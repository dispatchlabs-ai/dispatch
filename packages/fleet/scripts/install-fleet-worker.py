#!/usr/bin/env python3
"""Install a checksum-pinned application closure on a dedicated fleet worker."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse

from common import load_release, private_config, ROOT, RUNTIME

WORKSPACES = ROOT / 'workspaces'


def run(*args): return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.new')
    if temporary.is_symlink(): raise ValueError('Invalid pending installation file')
    with temporary.open('w') as stream:
        os.fchmod(stream.fileno(), mode); stream.write(text); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)


def stage_installation(config):
    digest = config['releaseSha256']
    if not re.fullmatch('[a-f0-9]{64}', digest): raise ValueError('An exact release SHA-256 is required')
    receipt = Path('/opt/dispatch-fleet/releases') / digest
    if not receipt.is_symlink():
        with tempfile.TemporaryDirectory(prefix='dispatch-fleet-release-') as directory:
            archive = Path(directory) / 'release.tar.gz'
            run('aws', '--region', config['region'], 's3api', 'get-object', '--bucket', config['bucket'],
                '--key', config['releaseKey'], str(archive))
            with archive.open('rb') as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != digest: raise ValueError('Release archive checksum differs')
            # The bootstrap's independently verified staging code reads the
            # archive; never execute an unverified archive member.
            run(sys.executable, str(Path(__file__).with_name('stage-release.py')), str(archive), '--sha256', digest)
    installation = receipt.resolve(strict=True)
    candidates = list((installation / 'share').glob('*/release.json'))
    if len(candidates) != 1: raise ValueError('Expected one application manifest')
    manifest = candidates[0]
    if config.get('manifest') and config['manifest'] != str(manifest): raise ValueError('Archive differs from the retained application')
    load_release(str(manifest))
    return manifest


def validate(config):
    origin = urllib.parse.urlsplit(config['controlUrl'])
    if (origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or
            origin.path not in ('', '/') or origin.query or origin.fragment): raise ValueError('Use an HTTPS coordinator origin')
    if config.get('format') != 1 or config.get('workspaceRoot') != str(WORKSPACES): raise ValueError('Invalid worker configuration')
    if not re.fullmatch('fs-[a-f0-9]{8,17}', config['efsId']): raise ValueError('Invalid EFS identity')
    if not re.fullmatch('fsap-[a-f0-9]{17}', config['efsAccessPointId']): raise ValueError('Use the scoped EFS access point')
    if not re.fullmatch('[a-z]{2}-[a-z]+-[0-9]+', config['region']): raise ValueError('Invalid region')


def units(manifest):
    tools = manifest['fleet']['tools']; scripts = tools['scripts']; python = tools['python']
    common = f'''NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
Environment=SSL_CERT_FILE={tools['caBundle']}
Environment=NODE_EXTRA_CA_CERTS={tools['caBundle']}
Environment=PATH={tools['path']}:/usr/bin:/bin
'''
    return {
        'dispatch-fleet-network.service': f'''[Unit]
After=docker.service
Requires=docker.service
PartOf=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={python} {scripts}/configure-network.py
[Install]
WantedBy=multi-user.target
''',
        'dispatch-fleet-cua.service': f'''[Unit]
After=network-online.target
[Service]
Type=simple
User=root
UMask=0077
Environment=HOME={ROOT}/cua
Environment=CUA_HOME={ROOT}/cua
Environment=CUA_DAEMON={RUNTIME}/cua.sock
Environment=CUA_TELEMETRY=0
Environment=DO_NOT_TRACK=1
Environment=AWS_EC2_METADATA_DISABLED=true
RuntimeDirectory=dispatch-fleet
RuntimeDirectoryMode=0711
RuntimeDirectoryPreserve=yes
ExecStart={tools['cua']} daemon start --foreground --socket {RUNTIME}/cua.sock --loopback 127.0.0.1:0
ReadWritePaths={ROOT}/cua {RUNTIME}
Restart=on-failure
RestartSec=3
{common}[Install]
WantedBy=multi-user.target
''',
        'dispatch-fleet-worker.service': f'''[Unit]
After=network-online.target dispatch-fleet-cua.service dispatch-fleet-network.service
Requires=dispatch-fleet-cua.service dispatch-fleet-network.service
RequiresMountsFor={WORKSPACES}
[Service]
Type=simple
User=root
UMask=0077
Environment=HOME=/var/empty
Environment=AWS_CONFIG_FILE=/dev/null
Environment=AWS_SHARED_CREDENTIALS_FILE=/dev/null
RuntimeDirectory=dispatch-fleet
RuntimeDirectoryMode=0711
RuntimeDirectoryPreserve=yes
ExecStart={python} {scripts}/fleet-worker.py --config /etc/dispatch-fleet/config.json
ReadWritePaths={ROOT} {RUNTIME} /run/private/dispatch-fleet /run/systemd/system /opt/dispatch-fleet /nix
Restart=on-failure
RestartSec=3
TimeoutStopSec=120
{common}CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER
[Install]
WantedBy=multi-user.target
''',
        'dispatch-fleet-run@.service': f'''[Unit]
After=dispatch-fleet-worker.service
BindsTo=dispatch-fleet-worker.service
[Service]
Type=simple
DynamicUser=yes
UMask=0077
StateDirectory=dispatch-fleet-runs-%i
StateDirectoryMode=0700
RuntimeDirectory=dispatch-fleet/runs/%i
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
WorkingDirectory=/var/lib/dispatch-fleet-runs-%i
Environment=HOME=/var/lib/dispatch-fleet-runs-%i
Environment=AWS_EC2_METADATA_DISABLED=true
Environment=AWS_CONFIG_FILE=/dev/null
Environment=AWS_SHARED_CREDENTIALS_FILE=/dev/null
Environment=DISPATCH_STORAGE_SOCKET={RUNTIME}/runs/%i/relay.sock
LoadCredential=assignment:{ROOT}/assignments/%i.json
InaccessiblePaths=/etc/dispatch-fleet {ROOT} {RUNTIME}/cua.sock -{RUNTIME}/control.sock -{RUNTIME}/storage.sock
IPAddressDeny=10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 fc00::/7 fe80::/10
ProtectProc=invisible
ProtectKernelLogs=yes
RestrictNamespaces=yes
ExecStartPre=+{python} {scripts}/fleet-worker.py --prepare-artifacts %i
ExecStart={python} {scripts}/workspace-launch.py %i
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
{common}''',
    }


def install(config):
    validate(config)
    manifest_path = stage_installation(config)
    manifest = load_release(str(manifest_path)); tools = manifest['fleet']['tools']
    for directory, mode in [(ROOT, 0o700), (ROOT / 'cua', 0o700), (ROOT / 'assignments', 0o700),
                            (Path('/etc/dispatch-fleet'), 0o700), (Path('/etc/docker'), 0o755),
                            (RUNTIME, 0o711), (RUNTIME / 'runs', 0o711),
                            (Path('/run/private'), 0o700), (Path('/run/private/dispatch-fleet'), 0o755),
                            (Path('/run/private/dispatch-fleet/runs'), 0o755)]:
        directory.mkdir(parents=True, exist_ok=True, mode=mode)
        if directory.is_symlink() or directory.stat().st_uid: raise ValueError('Installation directory must be root owned')
        directory.chmod(mode)
    config = {**config, 'manifest': str(manifest_path)}
    write(Path('/etc/dispatch-fleet/config.json'), json.dumps(config))
    WORKSPACES.mkdir(mode=0o700, exist_ok=True)
    if WORKSPACES.is_symlink(): raise ValueError('EFS mountpoint cannot be a symlink')
    mount = run('systemd-escape', '--path', '--suffix=mount', str(WORKSPACES))
    write(Path('/etc/systemd/system') / mount, f'''[Unit]
Wants=network-online.target
After=network-online.target
[Mount]
What={config['efsId']}:/
Where={WORKSPACES}
Type=efs
Options=_netdev,tls,iam,noresvport,accesspoint={config['efsAccessPointId']}
[Install]
WantedBy=multi-user.target
''', 0o644)
    run('systemctl', 'daemon-reload'); run('systemctl', 'enable', '--now', mount)
    if not os.path.ismount(WORKSPACES): raise ValueError('EFS is unavailable; no runs can be admitted')
    WORKSPACES.chmod(0o700)
    exports = WORKSPACES / '.exports'
    exports.mkdir(mode=0o700, exist_ok=True)
    if exports.is_symlink() or exports.stat().st_uid or exports.stat().st_mode & 0o077:
        raise ValueError('Workspace exports must be private and root owned')
    docker_path = Path('/etc/docker/daemon.json')
    docker = json.loads(docker_path.read_text()) if docker_path.exists() else {}
    desired = {'path': tools['runsc'], 'runtimeArgs': ['--net-raw', '--allow-packet-socket-write', '--allow-suid', '--overlay2=none']}
    previous = docker.setdefault('runtimes', {}).get('runsc')
    if previous and previous != desired: raise ValueError('A different runsc installation already owns this host')
    docker['runtimes']['runsc'] = desired
    write(docker_path, json.dumps(docker), 0o644)
    run('systemctl', 'enable', '--now', 'docker'); run('systemctl', 'reload', 'docker')
    workspace = {'format': 1, 'namespace': 'dispatch-fleet', 'stateRoot': str(ROOT / 'spaces'),
                 'persistentRoot': str(WORKSPACES), 'registerNixRoots': False, 'allowedReleaseRoots': ['/nix/store'],
                 'network': 'dispatch-fleet', 'bridge': 'dispatchfl0', 'firewallTable': 'dispatch_fleet',
                 'runtime': 'runsc', 'docker': '/usr/bin/docker', 'nft': '/usr/sbin/nft',
                 'storage': {'kind': 'directory', 'path': str(exports)},
                 'cua': [tools['cua'], '--daemon', str(RUNTIME / 'cua.sock')],
                 'cuaEnv': {'HOME': str(ROOT / 'cua'), 'CUA_HOME': str(ROOT / 'cua')}}
    write(Path('/etc/dispatch-fleet/workspace.json'), json.dumps(workspace))
    write(Path('/etc/tmpfiles.d/dispatch-fleet.conf'),
          f'd {RUNTIME} 0711 root root -\nd {RUNTIME}/runs 0711 root root -\n'
          'd /run/private 0700 root root -\nd /run/private/dispatch-fleet 0755 root root -\n'
          'd /run/private/dispatch-fleet/runs 0755 root root -\n', 0o644)
    for name, body in units(manifest).items(): write(Path('/etc/systemd/system') / name, body, 0o644)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', 'dispatch-fleet-network', 'dispatch-fleet-cua', 'dispatch-fleet-worker')
    run('systemctl', 'is-active', '--quiet', 'dispatch-fleet-worker')
    print(json.dumps({'installed': str(manifest_path), 'worker': 'ready'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0: raise ValueError('Install as root')
    Path('/opt/dispatch-fleet').mkdir(parents=True, exist_ok=True)
    with open('/opt/dispatch-fleet/.install.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX); install(private_config(args.config))
