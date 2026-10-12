#!/usr/bin/env python3
"""Read-only release archive inspection; Python 3 standard library only.

Usage: python3 scripts/scan-release-artifact.py ARCHIVE > private-receipt.json
Supports flat tar archives, Docker-save and OCI image layouts (including indexes).
Never extracts files or runs artifact code. Reports categories/locations, not matches
or environment values. Exit 0 means traversal completed, NOT security clearance:
every hit needs review. Malformed/unsupported image layers fail with exit 1.
Known-pattern coverage cannot prove absence of arbitrary or encoded secrets.
"""
import hashlib
import json
import re
import sys
import tarfile

PATTERNS = {
    "private-key-header": rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "aws-key": rb"\bAKIA[0-9A-Z]{16}\b",
    "github-token": rb"\bgh[pousr]_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{20,}\b",
    "provider-key": rb"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b",
    "google-key": rb"\bAIza[0-9A-Za-z_-]{35}\b",
    "slack-token": rb"\bxox[baprs]-[A-Za-z0-9-]{10,}\b",
    "npm-token": rb"\bnpm_[A-Za-z0-9]{36}\b",
    "jwt": rb"eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.",
    "database-url": rb"(?:postgres|postgresql|mysql|mongodb)://[a-z0-9_]+:[^@/\s\x00]{8,}@",
    "bearer-token": rb"\bBearer\s+[A-Za-z0-9._-]{40,}\b",
}
PATTERNS = {name: re.compile(value) for name, value in PATTERNS.items()}
PATH_PATTERN = re.compile(
    r"(^|/)(\.ssh|\.gnupg|\.aws|\.docker|\.netrc|\.npmrc|\.git-credentials|"
    r"\.gitconfig|\.kube|known_hosts|id_rsa|id_ed25519|id_ecdsa|authorized_keys)(/|$)|"
    r"(^|/)\.env($|\.)|(^|/)(credentials|config\.json)$"
)
CHUNK = 64 * 1024 * 1024
OVERLAP = 4096


def main(archive):
    report = {"archiveSHA256": None, "format": None, "layers": 0,
              "entries": 0, "regularFiles": 0, "contentHits": [], "pathHits": [],
              "limits": "Known-pattern scan, not security clearance; no size/name exclusions. "
                        "64 MiB chunks use 4 KiB overlap: longer matches crossing chunk "
                        "boundaries can be missed. Paths may contain sensitive names; "
                        "keep receipts private."}
    with open(archive, "rb") as f:
        digest = hashlib.sha256()
        for data in iter(lambda: f.read(CHUNK), b""):
            digest.update(data)
        report["archiveSHA256"] = digest.hexdigest()

    def scan_bytes(data, location, base=0, previous_end=0):
        for category, pattern in PATTERNS.items():
            for match in pattern.finditer(data):
                if base + match.end() <= previous_end:
                    continue
                report["contentHits"].append({"location": location, "offset": base + match.start(),
                                              "category": category})

    def scan_tar(tf, label):
        # Scan each layer independently, including files hidden by later whiteouts.
        for member in tf:
            report["entries"] += 1
            location = label + ":" + member.name
            # Do not lstrip('./'): it would erase a leading dot from .env/.ssh.
            name = member.name.removeprefix("./")
            if PATH_PATTERN.search(name) or (member.linkname and PATH_PATTERN.search(member.linkname)):
                report["pathHits"].append({"location": location, "type": member.type.decode("ascii", "replace")})
            if not member.isfile():
                continue
            report["regularFiles"] += 1
            with tf.extractfile(member) as f:
                tail, offset = b"", 0
                while True:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    scan_bytes(tail + chunk, location, offset - len(tail), offset)
                    tail = (tail + chunk)[-OVERLAP:]
                    offset += len(chunk)

    with tarfile.open(archive, "r:*") as outer:
        members = {m.name.removeprefix("./"): m for m in outer.getmembers()}

        def member_file(name):
            member = members[name.removeprefix("./")]
            if not member.isfile():
                raise ValueError("image reference is not a regular file")
            return outer.extractfile(member)

        def read_json(name):
            with member_file(name) as f:
                data = f.read()
            scan_bytes(data, "metadata:" + name)
            return json.loads(data)

        def layer(name):
            with member_file(name) as f, tarfile.open(fileobj=f, mode="r|*") as tf:
                scan_tar(tf, "layer-" + str(report["layers"]))
            report["layers"] += 1

        if "manifest.json" in members:
            report["format"] = "docker-save"
            manifest = read_json("manifest.json")
            if not manifest:
                raise ValueError("empty image manifest")
            for image in manifest:
                read_json(image["Config"])
                if not image["Layers"]:
                    raise ValueError("image has no layers")
                for name in image["Layers"]:
                    layer(name)
        elif "index.json" in members:
            report["format"] = "oci-layout"

            def blob_name(desc):
                algorithm, value = desc["digest"].split(":", 1)
                if algorithm != "sha256" or not re.fullmatch(r"[a-f0-9]{64}", value):
                    raise ValueError("unsupported OCI digest")
                return "blobs/sha256/" + value

            def image(desc, depth=0):
                if depth > 16:
                    raise ValueError("OCI index nesting too deep")
                manifest = read_json(blob_name(desc))
                if "manifests" in manifest:
                    if not manifest["manifests"]:
                        raise ValueError("empty OCI index")
                    for child in manifest["manifests"]:
                        image(child, depth + 1)
                else:
                    read_json(blob_name(manifest["config"]))
                    if not manifest["layers"]:
                        raise ValueError("OCI image has no layers")
                    for desc in manifest["layers"]:
                        layer(blob_name(desc))

            index = read_json("index.json")
            if not index["manifests"]:
                raise ValueError("empty OCI index")
            for desc in index["manifests"]:
                image(desc)
        else:
            report["format"] = "flat-tar"
            scan_tar(outer, "archive")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 scripts/scan-release-artifact.py ARCHIVE")
    try:
        main(sys.argv[1])
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError):
        # Avoid echoing malformed metadata, paths or potential credential values.
        sys.exit("Artifact scan incomplete: unreadable, malformed or unsupported archive; review privately.")
