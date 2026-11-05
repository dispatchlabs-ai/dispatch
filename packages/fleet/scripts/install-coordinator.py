#!/usr/bin/env python3
"""Install root coordinator units; selection does not activate them by default."""
import argparse
import json
import os
from pathlib import Path
import subprocess
from common import load_release, private_config, ROOT, RUNTIME

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--manifest', required=True)
parser.add_argument('--config', type=Path, default=Path('/etc/dispatch-fleet/config.json'))
parser.add_argument('--activate', action='store_true')
args = parser.parse_args()
if os.geteuid() != 0: raise ValueError('Install the coordinator as root')
manifest = load_release(args.manifest); config = private_config(args.config); tools = manifest['fleet']['tools']
if not Path(config['relaySocket']).is_absolute(): raise ValueError('Supply the root application relay socket')
if str(args.config) != '/etc/dispatch-fleet/config.json': raise ValueError('Install the coordinator configuration at its fixed root-owned path')
for unit in ('dispatch-fleet-coordinator', 'dispatch-fleet-storage'):
    if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0:
        raise ValueError('Gracefully stop the previous coordinator and storage owner before selecting a release')
for path in (ROOT, ROOT / 'assignments', ROOT / 'native', RUNTIME):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid or path.stat().st_mode & 0o077: raise ValueError('Coordinator state must be private and root owned')
units = {
    'dispatch-fleet-storage.service': f'''[Unit]
Before=dispatch-fleet-coordinator.service
[Service]
User=root
UMask=0077
RuntimeDirectory=dispatch-fleet
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
ExecStart={tools['node']} {tools['storage']}
Restart=on-failure
RestartSec=3
TimeoutStopSec=120
''',
    'dispatch-fleet-coordinator.service': f'''[Unit]
After=network-online.target dispatch-fleet-storage.service
Requires=dispatch-fleet-storage.service
[Service]
User=root
UMask=0077
Environment=SSL_CERT_FILE={tools['caBundle']}
Environment=AWS_CONFIG_FILE=/dev/null
Environment=AWS_SHARED_CREDENTIALS_FILE=/dev/null
RuntimeDirectory=dispatch-fleet
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
ExecStart={tools['python']} {tools['scripts']}/coordinator.py --config {args.config}
Restart=on-failure
RestartSec=3
TimeoutStopSec=210
[Install]
WantedBy=multi-user.target
''',
}
for name, body in units.items():
    path = Path('/etc/systemd/system') / name
    temporary = path.with_suffix('.new'); temporary.write_text(body); temporary.chmod(0o644); temporary.replace(path)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
if args.activate:
    subprocess.run(['systemctl', 'enable', '--now', 'dispatch-fleet-coordinator.service'], check=True)
print(json.dumps({'installed': args.manifest, 'activated': args.activate}))
