#!/usr/bin/env python3
"""Install a company's trusted Slack coordinator using an immutable fleet release."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess

from common import immutable_path, load_release, private_config


def unit_value(value):
    return json.dumps(str(value).replace('%', '%%'))


def protected_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid or info.st_mode & 0o077:
        raise ValueError('Use private root-owned application directories')


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--manifest', required=True)
parser.add_argument('--config', type=Path, required=True)
parser.add_argument('--credentials-dir', type=Path, required=True)
parser.add_argument('--entry', default='src/fleet-host.ts')
parser.add_argument('--activate', action='store_true')
args = parser.parse_args()
if os.geteuid() != 0: raise ValueError('Install the application as root')
manifest = load_release(args.manifest)
config = private_config(args.config)
namespace = config['namespace']
if not re.fullmatch('[a-z][a-z0-9-]*', namespace) or namespace != manifest['fleet']['namespace']:
    raise ValueError('Application and fleet namespaces must match')
if not any(release.get('manifest') == args.manifest for release in config['releases']):
    raise ValueError('The application release must be in the retained release registry')
root = immutable_path(manifest['definitionsRoot'])
entry = Path(args.entry)
if entry.is_absolute() or '..' in entry.parts:
    raise ValueError('Use a definition-relative host entry point')
entry = immutable_path(str(root / entry))
if not entry.is_relative_to(root): raise ValueError('Host entry point escapes its application')
name = 'dispatch-fleet-slack-' + namespace
if subprocess.run(['systemctl', 'is-active', '--quiet', name]).returncode == 0:
    raise ValueError('Gracefully stop the current Slack coordinator before selecting a release')
for value in (args.config, args.credentials_dir, Path(config['stateRoot']), Path(config['relayStateRoot'])):
    if not value.is_absolute(): raise ValueError('Use absolute installation paths')
for path in (Path(config['stateRoot']), Path(config['relayStateRoot']), args.credentials_dir):
    protected_directory(path)
credentials = []
for field in ('slack', 'inference', 'wiki-config', 'wiki-key'):
    path = args.credentials_dir / field
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid or info.st_mode & 0o077:
        raise ValueError('Application credentials must be private root-owned regular files')
    credentials.append('LoadCredential=' + unit_value(field + ':' + str(path)))
tools = manifest['fleet']['tools']
body = f'''[Unit]
Description=Durable Slack coordinator ({namespace})
After=network-online.target dispatch-fleet-coordinator.service
Requires=dispatch-fleet-coordinator.service
[Service]
User=root
UMask=0077
Environment=FLEET_HOST_CONFIG={unit_value(args.config)}
Environment=HOME={unit_value(config['stateRoot'])}
Environment=AWS_EC2_METADATA_DISABLED=true
Environment=NODE_EXTRA_CA_CERTS={unit_value(tools['caBundle'])}
WorkingDirectory={unit_value(config['stateRoot'])}
RuntimeDirectory={name}
RuntimeDirectoryMode=0700
{chr(10).join(credentials)}
ExecStart={unit_value(tools['node'])} {unit_value(entry)}
ReadWritePaths={unit_value(config['stateRoot'])} {unit_value(config['relayStateRoot'])} /run/dispatch-fleet
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectProc=invisible
RestrictSUIDSGID=yes
RestrictNamespaces=yes
IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128
KillMode=control-group
TimeoutStopSec=210
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
'''
path = Path('/etc/systemd/system') / (name + '.service')
temporary = path.with_suffix('.new')
with temporary.open('w') as stream:
    os.fchmod(stream.fileno(), 0o644)
    stream.write(body)
    stream.flush()
    os.fsync(stream.fileno())
temporary.replace(path)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
if args.activate:
    subprocess.run(['systemctl', 'enable', '--now', name], check=True)
print(json.dumps({'unit': name, 'manifest': args.manifest, 'activated': args.activate}))
