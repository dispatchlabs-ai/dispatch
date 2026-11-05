#!/usr/bin/env python3
"""Verify and stage a complete release. Never activate a service or alter state."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import tempfile

STORE = re.compile(r"^[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+$")
SHA = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def stream_digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def digest(path):
    with open(path, "rb") as stream:
        return stream_digest(stream)


def store_path(name):
    parts = PurePosixPath(name).parts
    # Linux systemd unit filenames use literal backslash escapes (e.g. \\x2d).
    # They are ordinary POSIX filename characters, never path separators.
    require(not name.startswith("/") and ".." not in parts,
            "Invalid archive path")
    require(len(parts) >= 3 and parts[:2] == ("nix", "store") and
            STORE.fullmatch(parts[2]), "Archive member is not a Nix store object")
    return PurePosixPath(*parts)


def extract_closure(archive, root):
    """Create files first and symlinks last; never extract through a symlink."""
    with tarfile.open(archive, "r:") as tar:
        members = tar.getmembers()
        names = {}
        for member in members:
            path = store_path(member.name)
            require(str(path) not in names, "Duplicate archive member")
            require(member.isdir() or member.isfile() or member.issym() or member.islnk(),
                    "Special archive member refused")
            require(not member.mode & 0o6000, "Privileged archive member refused")
            names[str(path)] = member
        for name in names:
            for parent in PurePosixPath(name).parents:
                if str(parent) in names:
                    require(names[str(parent)].isdir(), "Archive parent is not a directory")
        for name, member in names.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            elif member.isfile():
                with tar.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o555)
        # GNU tar can use hardlinks for identical files. Only link to regular files.
        for name, member in names.items():
            if member.islnk():
                link = store_path(member.linkname)
                require(str(link) in names and names[str(link)].isfile(),
                        "Hardlink must target an archived regular file")
                os.link(root / str(link), root / name)
        for name, member in names.items():
            if member.issym():
                require("\x00" not in member.linkname, "Invalid symlink")
                os.symlink(member.linkname, root / name)
        for name, member in names.items():
            if member.isdir():
                (root / name).chmod(0o555)


def identical_tree(left, right):
    """Do not overwrite any pre-existing store object, even after interruption."""
    if left.is_symlink() or right.is_symlink():
        return left.is_symlink() and right.is_symlink() and os.readlink(left) == os.readlink(right)
    if left.is_dir() and right.is_dir():
        entries = sorted(p.name for p in left.iterdir())
        return (stat.S_IMODE(left.stat().st_mode) == stat.S_IMODE(right.stat().st_mode) and
                entries == sorted(p.name for p in right.iterdir()) and all(
                    identical_tree(left / name, right / name) for name in entries))
    return (left.is_file() and right.is_file() and
            stat.S_IMODE(left.stat().st_mode) == stat.S_IMODE(right.stat().st_mode) and
            digest(left) == digest(right))


def closure_path(root, absolute):
    """Resolve Nix links inside the unpacked closure, never the host's store."""
    require(absolute.startswith("/nix/store/"), "Required path is not in the Nix store")
    store_path(absolute[1:])
    pending = list(PurePosixPath(absolute).parts[1:])
    resolved = PurePosixPath("/")
    links = 0
    while pending:
        part = pending.pop(0)
        if part == "..":
            resolved = resolved.parent
            continue
        if part == ".":
            continue
        resolved /= part
        candidate = root / str(resolved)[1:]
        if candidate.is_symlink():
            links += 1
            require(links <= 40, "Required closure path has too many symlinks")
            target = PurePosixPath(os.readlink(candidate))
            if target.is_absolute():
                resolved = PurePosixPath("/")
                pending = list(target.parts[1:]) + pending
            else:
                resolved = resolved.parent
                pending = list(target.parts) + pending
    store_path(str(resolved)[1:])
    return root / str(resolved)[1:]


def verify(archive, expected, scratch):
    require(SHA.fullmatch(expected), "Supply an independently recorded SHA-256")
    # Retain the exact verified bytes, not a second open of a mutable input path.
    verified = scratch / "verified.tar.gz"
    with open(archive, "rb") as source, verified.open("xb") as output:
        shutil.copyfileobj(source, output)
    require(digest(verified) == expected, "Release digest does not match")
    with tarfile.open(verified, "r:gz") as tar:
        expected_names = {"closure.tar", "release.json", "installation", "stage-release.py"}
        members = tar.getmembers()
        require(len(members) == len(expected_names) and
                {m.name for m in members} == expected_names and all(m.isfile() for m in members),
                "Invalid release envelope")
        for member in members:
            with tar.extractfile(member) as source, (scratch / member.name).open("xb") as output:
                shutil.copyfileobj(source, output)
    manifest = json.loads((scratch / "release.json").read_text())
    require(manifest["schemaVersion"] == 1 and COMMIT.fullmatch(manifest["revision"]) and
            COMMIT.fullmatch(manifest["dispatch"]["revision"]), "Invalid source provenance")
    installation = (scratch / "installation").read_text().strip()
    require(installation.startswith("/nix/store/") and
            len(store_path(installation[1:]).parts) == 3, "Invalid installation")
    require(re.fullmatch('[a-z][a-z0-9-]*', manifest['name']), "Invalid release name")
    closure = scratch / "tree"
    closure.mkdir()
    extract_closure(scratch / "closure.tar", closure)
    inside = closure / installation[1:]
    require(inside.is_dir() and not inside.is_symlink(), "Installation is missing")
    manifest_path = installation + '/share/' + manifest['name'] + '/release.json'
    require(json.loads(closure_path(closure, manifest_path).read_text()) == manifest,
            "Inner and outer provenance disagree")
    fleet = manifest.get('fleet', {})
    require(fleet.get('format') == 1 and re.fullmatch('[a-z][a-z0-9-]*', fleet.get('namespace', '')),
            'Missing fleet execution descriptor')
    roles = fleet.get('roles')
    require(isinstance(roles, list) and roles and len(set(roles)) == len(roles) and
            all(isinstance(role, str) and re.fullmatch('[a-z][a-z0-9_-]*', role) for role in roles),
            'Invalid native store names')
    module = PurePosixPath(fleet.get('module', ''))
    require(not module.is_absolute() and '..' not in module.parts and module.parts,
            'The adapter module must be inside the definitions')
    require(closure_path(closure, manifest['definitionsRoot'] + '/' + str(module)).is_file(), 'Run adapter is missing')
    for name in ('node', 'python', 'cua', 'runsc'):
        executable = closure_path(closure, fleet['tools'][name])
        require(executable.is_file() and executable.stat().st_mode & 0o111, 'Missing fleet executable: ' + name)
    for name in ('host', 'storage', 'scripts', 'caBundle'):
        require(closure_path(closure, fleet['tools'][name]).exists(), 'Missing fleet runtime: ' + name)
    return manifest, installation, closure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    require(args.verify_only or os.geteuid() == 0, "Staging requires root")
    if args.verify_only:
        parent = None
    else:
        require(os.uname().sysname == "Linux" and os.uname().machine == "x86_64",
                "This release requires Linux x86_64")
        require(not Path("/nix/var/nix/db/db.sqlite").exists(),
                "Use Nix's native import on a Nix-managed machine")
        for directory in (Path("/nix"), Path("/nix/store"), Path("/opt/dispatch-fleet"),
                          Path("/opt/dispatch-fleet/releases")):
            require(not directory.is_symlink(), "Installation directory cannot be a symlink")
            directory.mkdir(mode=0o755, parents=True, exist_ok=True)
            require(directory.stat().st_uid == 0 and not directory.stat().st_mode & 0o022,
                    "Installation directory must be root owned and not writable by others")
            # Bootstrap and the root worker use umask 0077. mkdir's mode is
            # filtered by that mask; native DynamicUsers still need traversal.
            directory.chmod(0o755)
        parent = "/nix"
    # Same filesystem for atomic store-object renames. Mode 0700 until committed.
    temporary = tempfile.mkdtemp(prefix="dispatch-fleet-release-", dir=parent)
    try:
        manifest, installation, closure = verify(args.archive, args.sha256, Path(temporary))
        if not args.verify_only:
            with open("/opt/dispatch-fleet/.stage.lock", "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                for source in sorted((closure / "nix/store").iterdir()):
                    target = Path("/nix/store") / source.name
                    if target.exists() or target.is_symlink():
                        require(identical_tree(source, target),
                                "Existing Nix store object differs; refusing overwrite: " + target.name)
                    else:
                        source.rename(target)
                release = Path("/opt/dispatch-fleet/releases") / args.sha256
                if release.exists() or release.is_symlink():
                    require(release.is_symlink() and os.readlink(release) == installation,
                            "Existing release receipt differs")
                else:
                    release.symlink_to(installation)
        print(json.dumps({
            "verified": True, "staged": not args.verify_only, "activated": False,
            "sha256": args.sha256, "installation": installation, **manifest,
        }))
    finally:
        # Verification also runs without root; immutable staged directories must
        # be made removable. Never follow archive symlinks while doing so.
        for directory, _, _ in os.walk(temporary, followlinks=False):
            os.chmod(directory, 0o700)
        shutil.rmtree(temporary)


if __name__ == "__main__":
    main()
