"""Initialize retained desktop state and apply optional private browser settings."""
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

home = Path("/home/cua")
for directory in [".config", ".local", ".local/share", ".local/share/keyrings", "Downloads"]:
    path = home / directory
    path.mkdir(parents=True, exist_ok=True)
    os.chown(path, 1000, 1000)
    os.chmod(path, 0o700)

policy = Path("/etc/chromium/policies/managed/dispatch-private.json")
settings = Path("/run/dispatch-settings/browser.json")
if settings.exists():
    server = json.loads(settings.read_text())["vaultServer"]
    url = urlsplit(server)
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
        raise ValueError("vaultServer must be an HTTPS origin")
    policy.write_text(json.dumps({
        "PasswordManagerEnabled": False,
        "3rdparty": {"extensions": {"nngceckbapebfimnlniiiahkandclblb": {
            "environment": {"base": server}}}}
    }))
elif policy.exists():
    policy.unlink()

managed = json.loads(Path("/etc/chromium/policies/managed/dispatch.json").read_text())
if "DownloadDirectory" in managed:
    downloads = Path(managed["DownloadDirectory"])
    downloads.mkdir(parents=True, exist_ok=True)
    os.chown(downloads, 1000, 1000)
    os.chmod(downloads, 0o700)
