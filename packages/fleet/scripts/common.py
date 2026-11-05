"""Trusted installation identities and atomic fleet metadata."""
import json
import os
from pathlib import Path
import re
import stat
import uuid

ROOT = Path('/var/lib/dispatch-fleet')
RUNTIME = Path('/run/dispatch-fleet')
CONFIG = Path('/etc/dispatch-fleet/config.json')
STORE = re.compile(r'/nix/store/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+')


def cleanup_relay(method, path):
    # The root adapter still limits Slack calls to retained delivery cleanup.
    return (method == 'POST' and (path.startswith('/storage/') or path in
            ('/events', '/company/slack/start', '/company/slack/api'))
            or method == 'GET' and path == '/v1/catalog')


def valid_run(run):
    if not isinstance(run, str) or not re.fullmatch('[a-f0-9]{64}', run):
        raise ValueError('Invalid run identity')
    return run


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    try:
        with temporary.open('x') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
        temporary.replace(path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally: temporary.unlink(missing_ok=True)


def private_config(path=CONFIG):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid or info.st_mode & 0o077:
        raise ValueError('Configuration must be a private root-owned regular file')
    return json.loads(path.read_text())


def immutable_path(value):
    if not isinstance(value, str) or any(char in value for char in ('\n', '\r', '\x00')):
        raise ValueError('Invalid installed path')
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or len(path.parts) < 4 or not STORE.fullmatch(str(Path(*path.parts[:4]))):
        raise ValueError('Use an immutable Nix installation')
    path = path.resolve(strict=True)
    if len(path.parts) < 4 or not STORE.fullmatch(str(Path(*path.parts[:4]))):
        raise ValueError('Installed path escapes the Nix store')
    for current in (path, *path.parents):
        info = current.stat()
        if info.st_uid or info.st_mode & 0o022:
            raise ValueError('Installation must be root-owned and not writable by another identity')
    return path


def load_release(path):
    path = immutable_path(path)
    value = json.loads(path.read_text())
    name = value.get('name', '')
    if (value.get('schemaVersion') != 1 or not re.fullmatch('[a-z][a-z0-9-]*', name)
            or not re.fullmatch('[a-f0-9]{40}', value.get('revision', ''))
            or not re.fullmatch('[a-f0-9]{40}', value.get('dispatch', {}).get('revision', ''))):
        raise ValueError('Invalid published application provenance')
    installation = Path(*path.parts[:4])
    if path != installation / 'share' / name / 'release.json':
        raise ValueError('Unexpected application manifest location')
    root = immutable_path(value['definitionsRoot'])
    if not root.is_relative_to(installation): raise ValueError('Definitions must belong to this installation')
    fleet = value.get('fleet', {})
    roles = fleet.get('roles')
    if (fleet.get('format') != 1 or not re.fullmatch('[a-z][a-z0-9-]*', fleet.get('namespace', ''))
            or not isinstance(roles, list) or not roles or len(set(roles)) != len(roles)
            or any(not isinstance(role, str) or not re.fullmatch('[a-z][a-z0-9_-]*', role) for role in roles)):
        raise ValueError('Invalid fleet execution descriptor')
    module = Path(fleet.get('module', ''))
    if not module.parts or module.is_absolute() or '..' in module.parts:
        raise ValueError('Use a definition-relative trusted run module')
    if not immutable_path(str(root / module)).is_relative_to(root):
        raise ValueError('Run module leaves its definitions')
    immutable_path(value['workspaceController'])
    for key in ('node', 'python', 'cua', 'runsc', 'host', 'storage', 'scripts', 'caBundle'):
        immutable_path(fleet['tools'][key])
    return value


def release_reference(value):
    if (not isinstance(value, dict) or set(value) != {'manifest', 'archiveKey', 'archiveSha256'}
            or not isinstance(value['archiveKey'], str) or not value['archiveKey'] or value['archiveKey'].startswith('/')
            or not re.fullmatch('[a-f0-9]{64}', value['archiveSha256'])):
        raise ValueError('Use a complete immutable release reference')
    manifest = load_release(value['manifest'])
    # Only a verified archive receipt authorizes a newly admitted installation.
    receipt = Path('/opt/dispatch-fleet/releases') / value['archiveSha256']
    if not receipt.is_symlink() or receipt.resolve(strict=True) != Path(*Path(value['manifest']).parts[:4]):
        raise ValueError('Stage the verified application archive before admitting runs')
    return manifest
