#!/usr/bin/env python3
"""Package a published mkAgentRelease closure and its independently hashed bootstrap."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--application', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
application = args.application.resolve(strict=True)
manifests = list((application / 'share').glob('*/release.json'))
if application.parent != Path('/nix/store') or len(manifests) != 1: raise ValueError('Use one built immutable application')
manifest = json.loads(manifests[0].read_text())
if len(manifest['revision']) != 40 or len(manifest['dispatch']['revision']) != 40 or not manifest.get('fleet'):
    raise ValueError('Package only published application and runtime revisions with fleet support')
paths = subprocess.check_output(['nix-store', '--query', '--requisites', str(application)], text=True).splitlines()
scripts = Path(manifest['fleet']['tools']['scripts'])
with tempfile.TemporaryDirectory(prefix='dispatch-fleet-package-') as temporary:
    stage = Path(temporary)
    subprocess.run(['tar', '--sort=name', '--mtime=@1', '--owner=0', '--group=0', '--numeric-owner',
        '-cf', str(stage / 'closure.tar'), '-C', '/', *(path.lstrip('/') for path in sorted(paths))], check=True)
    shutil.copy2(manifests[0], stage / 'release.json')
    shutil.copy2(scripts / 'stage-release.py', stage / 'stage-release.py')
    (stage / 'installation').write_text(str(application) + '\n')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['tar', '--sort=name', '--mtime=@1', '--owner=0', '--group=0', '--numeric-owner',
        '-czf', str(args.output), '-C', str(stage), 'closure.tar', 'release.json', 'installation', 'stage-release.py'], check=True)
    bootstrap = args.output.with_suffix('.bootstrap.tar.gz')
    with tarfile.open(bootstrap, 'w:gz') as archive:
        for name in ('install-fleet-worker.py', 'stage-release.py', 'common.py'):
            archive.add(scripts / name, arcname=name)
    values = {}
    for kind, path in (('release', args.output), ('bootstrap', bootstrap)):
        with path.open('rb') as stream: values[kind] = {'path': str(path), 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}
    print(json.dumps({'manifest': str(manifests[0]), **values}))
