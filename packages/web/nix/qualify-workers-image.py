#!/usr/bin/env python3
"""Explicit, disposable workers-oci packaging check; never application acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import uuid


def run(*args):
    return subprocess.check_output(args, text=True, timeout=300)


def qualify(archive, platform, docker):
    # Docker may normalize legacy archive config JSON and change its digest.
    # Verify loaded config and every rootfs layer before using its immutable ID.
    with tarfile.open(archive, "r:*") as bundle:
        manifest_file = bundle.extractfile("manifest.json")
        if manifest_file is None:
            raise ValueError("Missing Docker image manifest")
        manifest = json.load(manifest_file)
        if len(manifest) != 1:
            raise ValueError("Expected one image, not a multi-platform publication")
        config_file = bundle.extractfile(manifest[0]["Config"])
        if config_file is None:
            raise ValueError("Missing image configuration")
        config_bytes = config_file.read()
    image_id = "sha256:" + hashlib.sha256(config_bytes).hexdigest()
    configuration = json.loads(config_bytes)
    architecture = platform.split("/")[1]
    if configuration.get("os") != "linux" or configuration.get("architecture") != architecture:
        raise ValueError("Archive does not match the requested platform")
    server_arch = run(docker, "info", "--format", "{{.Architecture}}").strip()
    native_arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(server_arch, server_arch)
    if native_arch != architecture:
        raise ValueError("Qualification requires a native Docker server, not emulation")
    run(docker, "load", "--input", str(archive))
    tags = manifest[0].get("RepoTags", [])
    if len(tags) != 1:
        raise ValueError("Expected exactly one archive tag")
    image = json.loads(run(docker, "image", "inspect", tags[0]))[0]
    normalize = lambda value: {key: item for key, item in value.items() if item not in (None, {}, [])}
    if (normalize(configuration["config"]) != normalize(image["Config"])
            or configuration["rootfs"]["diff_ids"] != image["RootFS"]["Layers"]
            or image["Architecture"] != architecture or image["Os"] != "linux"):
        raise ValueError("Loaded image differs from the supplied archive")
    archive_config_digest = image_id
    image_id = image["Id"]
    if image["Config"]["User"] != "65532:65532" or image["Config"].get("Volumes"):
        raise ValueError("Expected a non-root image without anonymous volumes")
    command = """set -eu
    test "$(id -u)" = 65532
    test ! -e /workspace/image-sentinel
    touch /workspace/image-sentinel
    for wrapper in backend launcher worker auth; do test -x /bin/dispatch-$wrapper; done
    node -e 'if(Number(process.versions.node.split(".")[0])!==24)process.exit(1)'
    """
    for _ in range(2):
        name = "dispatch-image-probe-" + uuid.uuid4().hex
        try:
            run(docker, "run", "--rm", "--name", name, "--network", "none",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--memory", "128m", "--pids-limit", "32", "--cpus", "0.25",
                image_id, "/bin/sh", "-c", command)
        finally:
            # Never address an application container or shared volume.
            for container_id in run(docker, "ps", "-aq", "--filter", "name=^/" + name + "$").split():
                run(docker, "rm", "-f", container_id)
    with archive.open("rb") as source:
        archive_digest = hashlib.file_digest(source, "sha256").hexdigest()
    return {"scope": "native workers-oci packaging only; no application/runtime acceptance",
            "archiveSha256": archive_digest, "archiveConfigDigest": archive_config_digest,
            "image": image_id, "platform": platform,
            "nonroot": True, "noAnonymousVolumes": True, "wrappersPresent": True,
            "node24": True, "freshWritableWorkspaceTwice": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--platform", choices=["linux/amd64", "linux/arm64"], required=True)
    parser.add_argument("--docker", default="/usr/bin/docker")
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    receipt = qualify(args.archive, args.platform, args.docker)
    encoded = json.dumps(receipt, indent=2) + "\n"
    args.receipt.write_text(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    main()
