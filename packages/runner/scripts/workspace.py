#!/usr/bin/env python3
"""Host-owned, digest-pinned disposable workspaces. One JSON request per process."""
import argparse
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

CONTRACT = 'dispatch-workspace-v1'
LABEL = 'ai.dispatch.workspace'
HERE = Path(__file__).resolve().parent


def atomic(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    with temporary.open('x') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    s = path.lstat()
    if path.is_symlink() or not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077:
        raise ValueError('Controller state must be a private owned directory')


def descriptor(value):
    if (not isinstance(value, dict) or value.get('format') != 1 or value.get('contract') != CONTRACT or
            value.get('platform') not in ('linux/amd64', 'linux/arm64') or
            not re.fullmatch(r'[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}', value.get('image', '')) or
            not re.fullmatch('[a-f0-9]{40}', value.get('sourceRevision', ''))):
        raise ValueError('Use a prepared workspace descriptor with an immutable image and source revision')
    return {key: value[key] for key in ('format', 'contract', 'platform', 'image', 'sourceRevision')}


class Controller:
    def __init__(self, config):
        s = config.lstat()
        if config.is_symlink() or not stat.S_ISREG(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o022:
            raise ValueError('Controller configuration must be owned and not writable by other users')
        self.config = json.loads(config.read_text())
        c = self.config
        if (c.get('format') != 1 or not re.fullmatch('[a-z][a-z0-9-]*', c.get('namespace', '')) or
                not re.fullmatch('[a-zA-Z0-9_-]+', c.get('runtime', '')) or not re.fullmatch('[a-zA-Z0-9_-]+', c.get('network', '')) or
                not re.fullmatch('[a-zA-Z0-9_-]{1,15}', c.get('bridge', '')) or
                not re.fullmatch('[a-zA-Z0-9_]+', c.get('firewallTable', ''))):
            raise ValueError('Invalid workspace host configuration')
        self.root = Path(c['stateRoot'])
        if not self.root.is_absolute(): raise ValueError('Use an absolute stateRoot')
        private_directory(self.root)
        for name in ('runs', 'locks', 'control', 'gcroots'): private_directory(self.root / name)
        self.owner = c['namespace']

    def command(self, args, **kwargs):
        kwargs.setdefault('stdout', subprocess.PIPE)
        kwargs.setdefault('stderr', subprocess.PIPE)
        p = subprocess.run(args, **kwargs)
        if p.returncode:
            error = p.stderr.decode(errors='replace') if isinstance(p.stderr, bytes) else p.stderr
            raise RuntimeError('Workspace host operation failed: ' + error[-2000:])
        return p.stdout

    def docker(self, *args, **kwargs):
        return self.command([self.config.get('docker', 'docker'), *args], text=True, **kwargs).strip()

    def cua(self, *args, token=None):
        environment = {**os.environ, **self.config.get('cuaEnv', {}), 'CUA_TELEMETRY': '0', 'DO_NOT_TRACK': '1'}
        if token: environment['CUA_ENV_TOKEN'] = token
        command = self.config.get('cua', ['cua'])
        return self.command([*command, '--json', *args], env=environment, text=True)

    def location(self, run):
        if not isinstance(run, str) or not re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9_.-]*', run): raise ValueError('Invalid run identity')
        identity = hashlib.sha256((self.owner + '\0' + run).encode()).hexdigest()
        return identity, self.root / 'runs' / (identity + '.json')

    @contextmanager
    def locked(self, run, shared=False):
        identity, _ = self.location(run)
        with (self.root / 'locks' / identity).open('a') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
            yield

    @contextmanager
    def desktop_lease(self, run):
        """Keep lifecycle operations out while a trusted adapter calls this desktop."""
        with self.locked(run, shared=True):
            record = self.load(run)
            if not record or record['state'] != 'ready':
                raise ValueError('Ensure the workspace before acquiring its desktop lease')
            row = self.owned(record)
            if not row or not row['State']['Running']:
                raise ValueError('Workspace is not running; ensure it before acquiring its desktop lease')
            yield record

    def save(self, record): atomic(self.location(record['run'])[1], record)

    def load(self, run):
        _, path = self.location(run)
        if not path.exists(): return None
        if path.is_symlink(): raise ValueError('Invalid run record')
        value = json.loads(path.read_text())
        if value.get('run') != run or value.get('namespace') != self.owner: raise ValueError('Workspace owner mismatch')
        return value

    def validate_release(self, release):
        if not isinstance(release, dict): raise ValueError('A complete release binding is required')
        release = dict(release); release['workspace'] = descriptor(release.get('workspace'))
        if not re.fullmatch('[a-f0-9]{40}|[a-f0-9]{64}', release.get('runtimeRevision', '')):
            raise ValueError('Use the exact runtime revision or content hash')
        paths = [release.get('definitionsRoot')]
        entry = release.get('runtimeEntryPoint')
        if entry:
            if not isinstance(entry, dict) or set(entry) != {'node', 'module'}: raise ValueError('Use a pinned Node and module entry point')
            paths += [entry['node'], entry['module']]
        allowed = [Path(value).resolve(strict=True) for value in self.config.get('allowedReleaseRoots', [])]
        if not allowed: raise ValueError('Configure allowed immutable release roots')
        for value in paths:
            if not isinstance(value, str) or not Path(value).is_absolute(): raise ValueError('Release paths must be absolute')
            path = Path(value).resolve(strict=True)
            parents = [root for root in allowed if path.is_relative_to(root)]
            if not parents: raise ValueError('Release path is outside allowed installations')
            bound = max(parents, key=lambda root: len(root.parts))
            current = path
            while current != bound:
                mode = current.stat()
                if mode.st_uid not in (0, os.geteuid()) or mode.st_mode & 0o022:
                    raise ValueError('Release installation is writable by another identity')
                current = current.parent
        if not Path(release['definitionsRoot']).is_dir(): raise ValueError('Definition root is not a directory')
        release['definitionsRoot'] = str(Path(release['definitionsRoot']).resolve(strict=True))
        if entry: release['runtimeEntryPoint'] = {key: str(Path(value).resolve(strict=True)) for key, value in entry.items()}
        return release

    def bind(self, run, release):
        record = self.load(run)
        if record: return record
        value = self.validate_release(release)
        record = {'format': 1, 'namespace': self.owner, 'run': run, 'release': value, 'state': 'uncreated', 'artifacts': [], 'createdAt': time.time()}
        identity, _ = self.location(run)
        paths = [value['definitionsRoot'], *value.get('runtimeEntryPoint', {}).values()]
        roots = {str(Path('/nix/store') / Path(path).parts[3]) for path in paths if path.startswith('/nix/store/')}
        for index, root in enumerate(sorted(roots)):
            self.command([self.config.get('nixStore', '/nix/var/nix/profiles/default/bin/nix-store'),
                '--realise', root, '--add-root', str(self.root / 'gcroots' / (identity + '-' + str(index))), '--indirect'], text=True)
        self.save(record)
        return record

    def network(self, configure=False):
        c = self.config
        p = subprocess.run([c.get('docker', 'docker'), 'network', 'inspect', c['network']], capture_output=True, text=True)
        if p.returncode and configure:
            self.docker('network', 'create', '--label', LABEL + '.owner=' + self.owner,
                '--opt', 'com.docker.network.bridge.name=' + c['bridge'], '--opt', 'com.docker.network.bridge.enable_icc=false', c['network'])
            p = subprocess.run([c.get('docker', 'docker'), 'network', 'inspect', c['network']], capture_output=True, text=True)
        if p.returncode: raise ValueError('Configured workspace network is unavailable')
        row = json.loads(p.stdout)[0]
        if (row.get('Driver') != 'bridge' or row.get('Labels', {}).get(LABEL + '.owner') != self.owner or
                row.get('Options', {}).get('com.docker.network.bridge.name') != c['bridge'] or
                row.get('Options', {}).get('com.docker.network.bridge.enable_icc') != 'false'):
            raise ValueError('Configured workspace network does not match its owner')
        if configure:
            nft = c.get('nft', '/usr/sbin/nft'); table = c['firewallTable']; bridge = c['bridge']
            present = subprocess.run([nft, 'list', 'table', 'inet', table], capture_output=True).returncode == 0
            rules = ('delete table inet ' + table + '\n' if present else '') + f'''table inet {table} {{
 chain input {{
  type filter hook input priority -5; policy accept;
  iifname "{bridge}" ct state != {{ established, related }} reject
 }}
 chain forward {{
  type filter hook forward priority -5; policy accept;
  iifname "{bridge}" ip daddr 169.254.169.254 drop
  iifname "{bridge}" ip6 daddr fd00:ec2::254 drop
  iifname "{bridge}" oifname "{bridge}" drop
 }}
}}
'''
            for flags in (['-c', '-f', '-'], ['-f', '-']): self.command([nft, *flags], input=rules, text=True)
        else:
            self.command([c.get('nft', '/usr/sbin/nft'), 'list', 'table', 'inet', c['firewallTable']], text=True)
        return {'network': row['Name'], 'owner': self.owner}

    def image(self, workspace):
        image = workspace['image']; c = self.config
        p = subprocess.run([c.get('docker', 'docker'), 'image', 'inspect', image], capture_output=True, text=True)
        if p.returncode:
            registry = image.split('/')[0]
            match = re.fullmatch(r'([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com', registry)
            if match:
                token = self.command([c.get('aws', 'aws'), '--region', match[2], 'ecr', 'get-login-password'], text=True).strip()
                with tempfile.TemporaryDirectory(prefix='workspace-registry-') as temporary:
                    auth = base64.b64encode(('AWS:' + token).encode()).decode()
                    path = Path(temporary) / 'config.json'; path.write_text(json.dumps({'auths': {registry: {'auth': auth}}})); path.chmod(0o600)
                    self.docker('--config', temporary, 'pull', '--platform', workspace['platform'], image)
            else: self.docker('pull', '--platform', workspace['platform'], image)
            p = subprocess.run([c.get('docker', 'docker'), 'image', 'inspect', image], capture_output=True, text=True)
        if p.returncode: raise ValueError('Prepared workspace image unavailable')
        row = json.loads(p.stdout)[0]; labels = (row.get('Config') or {}).get('Labels') or {}
        if (row.get('Os') + '/' + row.get('Architecture') != workspace['platform'] or image not in row.get('RepoDigests', []) or
                labels.get(LABEL + '.contract') != CONTRACT or labels.get('org.opencontainers.image.revision') != workspace['sourceRevision']):
            raise ValueError('Workspace image failed digest/platform/contract/source verification')
        return row

    def owned(self, record):
        if not record.get('name'): return None
        ids = self.docker('container', 'ls', '-aq', '--filter', 'name=^/' + re.escape(record['name']) + '$')
        if not ids: return None
        row = json.loads(self.docker('container', 'inspect', ids))[0]
        labels = row.get('Config', {}).get('Labels', {}); host = row['HostConfig']
        if (labels.get(LABEL + '.owner') != self.owner or labels.get(LABEL + '.run') != record['run'] or
                record.get('container') and row['Id'] != record['container'] or row['Config']['Image'] != record['release']['workspace']['image'] or
                record.get('imageId') and row['Image'] != record['imageId']):
            raise ValueError('Workspace container owner or image changed')
        if (host['Runtime'] != self.config['runtime'] or host['NetworkMode'] != self.config['network'] or host.get('Privileged') or host.get('Binds') or
                host.get('RestartPolicy', {}).get('Name') != 'no' or
                host.get('Tmpfs') != {'/run': 'rw,mode=755'} or any(x.get('Type') != 'tmpfs' or x.get('Destination') != '/run' for x in row.get('Mounts', []))):
            raise ValueError('Workspace isolation differs from its saved binding')
        if host.get('PortBindings', {}).get('3211/tcp') != [{'HostIp': '127.0.0.1', 'HostPort': str(record['controlPort'])}]:
            raise ValueError('Workspace control port must be loopback only')
        return row

    def guest(self, record, request, shell=False):
        row = self.owned(record)
        if not row or not row['State']['Running']: raise ValueError('Workspace is not running; ensure it first')
        script = (HERE / 'workspace_guest.py').read_text()
        args = self.guest_command(row, 'python3', '-c', script)
        if not shell:
            p = subprocess.run(args, input=json.dumps(request), capture_output=True, text=True)
            try: result = json.loads(p.stdout)
            except json.JSONDecodeError: raise RuntimeError('Guest filesystem operation failed: ' + p.stderr[-1000:])
            if not result['ok']: raise RuntimeError(json.dumps(result['error']))
            return result['value']
        request = {**request, 'action': 'shell', 'job': uuid.uuid4().hex}
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        # Python retries InterruptedError during pipe I/O. Use an exception
        # that reaches the cancellation cleanup while the command is running.
        old = signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(RuntimeError('Workspace command interrupted')))
        try:
            if request.get('stream'):
                child.stdin.write(json.dumps(request)); child.stdin.close(); child.stdin = None
                # Output frames contain only guest command bytes; host diagnostics stay separate.
                for line in child.stdout: print(line, end='', flush=True)
                error = child.stderr.read(); code = child.wait()
                if code: raise RuntimeError('Guest command failed: ' + error[-1000:])
                return None
            stdout, stderr = child.communicate(json.dumps(request), timeout=request.get('timeout'))
            return {'exitCode': child.returncode, 'stdout': stdout, 'stderr': stderr}
        except BaseException:
            try: self.guest(record, {'action': 'cancel', 'job': request['job']})
            finally:
                child.kill(); child.communicate()
            raise
        finally: signal.signal(signal.SIGTERM, old)

    def guest_command(self, row, *args):
        return [self.config.get('docker', 'docker'), 'exec', '-i', '-u', 'cua',
                '--env', 'HOME=/home/cua', '--env', 'USER=cua', '--env', 'LOGNAME=cua', row['Id'], *args]

    def copy_from_guest(self, row, remote, local, root=None):
        # Docker's archive API cannot see live gVisor tmpfs mounts. Stream from
        # the running guest, checking the opened file rather than a raced path.
        script = """import os, shutil, stat, sys
from pathlib import Path
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(fd, 'rb') as source:
    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise ValueError('Export a regular file')
    if len(sys.argv) > 2: Path('/proc/self/fd/' + str(source.fileno())).resolve().relative_to(Path(sys.argv[2]))
    shutil.copyfileobj(source, sys.stdout.buffer)
"""
        with local.open('xb') as target:
            self.command(self.guest_command(row, 'python3', '-c', script, remote, *([root] if root else [])), stdout=target)
            target.flush(); os.fsync(target.fileno())

    def copy_to_guest(self, row, local, remote):
        script = """import os, shutil, sys
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'wb') as target:
    shutil.copyfileobj(sys.stdin.buffer, target)
    target.flush(); os.fsync(target.fileno())
"""
        with local.open('rb') as source:
            self.command(self.guest_command(row, 'python3', '-c', script, remote), stdin=source)

    def ensure(self, record):
        if record.get('finished'): raise ValueError('The workspace was finished; start a new run')
        self.validate_release(record['release']); self.network(); workspace = record['release']['workspace']; image = self.image(workspace)
        runtimes = json.loads(self.docker('info', '--format', '{{json .Runtimes}}'))
        if not {'--net-raw', '--allow-packet-socket-write', '--allow-suid', '--overlay2=none'}.issubset(runtimes.get(self.config['runtime'], {}).get('runtimeArgs', [])):
            raise ValueError('gVisor must support nested Docker, sudo and persistent writes')
        if record.get('imageId') and record['imageId'] != image['Id']: raise ValueError('Pinned image changed')
        record['imageId'] = image['Id']
        if record['state'] in ('uncreated', 'deleted'):
            identity, _ = self.location(record['run']); generation = uuid.uuid4().hex[:10]
            with socket.socket() as listener: listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
            record.update(name='dw-' + identity[:20] + '-' + generation, controlPort=port, sandbox=f'direct:127.0.0.1:{port}', state='creating')
            for key in ('container', 'writableLayer'): record.pop(key, None)
            self.save(record)
        control = self.root / 'control' / record['name']; private_directory(control)
        token = control / 'token'
        if not token.exists(): token.write_text(secrets.token_hex(32)); token.chmod(0o600)
        row = self.owned(record)
        if not row:
            if record['state'] not in ('creating', 'preparing'):
                if not record.get('recovery'): raise ValueError('Workspace disappeared without a saved checkpoint; retain its record for recovery')
                record['state'] = 'deleted'; self.save(record); return self.ensure(record)
            environment = control / 'environment'; environment.write_text('CUA_ENV_TOKEN=' + token.read_text() + '\nCUA_TELEMETRY=0\nDO_NOT_TRACK=1\n'); environment.chmod(0o600)
            try:
                self.docker('create', '--name', record['name'], '--platform', workspace['platform'], '--runtime', self.config['runtime'], '--cap-add', 'ALL',
                    '--network', self.config['network'], '--shm-size', '2g', '--restart', 'no', '--tmpfs', '/run:rw,mode=755',
                    '--label', LABEL + '.owner=' + self.owner, '--label', LABEL + '.run=' + record['run'],
                    '--publish', f"127.0.0.1:{record['controlPort']}:3211", '--env-file', str(environment), workspace['image'])
            finally: environment.unlink(missing_ok=True)
            row = self.owned(record)
        record['container'] = row['Id']; self.save(record)
        if not row['State']['Running']: self.docker('start', row['Id'])
        dns = self.config.get('dns') or [line.split()[1] for line in Path('/etc/resolv.conf').read_text().splitlines() if line.startswith('nameserver ')]
        if not dns or any(ipaddress.ip_address(x).is_loopback for x in dns): raise ValueError('Supply reachable DNS servers for gVisor')
        self.docker('exec', '-i', '-u', 'root', row['Id'], 'sh', '-c', 'cat > /etc/resolv.conf', input=''.join('nameserver ' + x + '\n' for x in dns))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({})); deadline = time.monotonic() + 120
        while True:
            try:
                with opener.open(f"http://127.0.0.1:{record['controlPort']}/health", timeout=2) as response:
                    if response.status in (200, 204): break
            except OSError: pass
            if time.monotonic() >= deadline: raise ValueError('Prepared desktop did not become ready')
            time.sleep(.2)
        registered = json.loads(self.cua('spaces', 'add', f"http://127.0.0.1:{record['controlPort']}", '--name', record['name'], token=token.read_text()))
        if registered.get('id') != record['sandbox']: raise ValueError('Cua registered a different desktop')
        self.docker('exec', '-u', 'root', row['Id'], '/usr/local/sbin/dispatch-docker-start')
        if record['state'] in ('creating', 'preparing'):
            record['state'] = 'preparing'; self.save(record)
            if record.get('recovery'):
                with tempfile.TemporaryDirectory(prefix='workspace-restore-') as temporary:
                    archive = Path(temporary) / 'recovery.tar.gz'; self.retrieve(record, record['recovery'], archive)
                    remote = '/tmp/dispatch-recovery-' + uuid.uuid4().hex + '.tar.gz'
                    script = (HERE / 'workspace_checkpoint.py').read_text()
                    try:
                        self.copy_to_guest(row, archive, remote)
                        self.command(self.guest_command(row, 'python3', '-c', script, 'restore', remote), text=True)
                    finally: self.command(self.guest_command(row, 'rm', '-f', remote), text=True)
        record['state'] = 'ready'; self.save(record)
        return record

    def store(self, record, source, category, name):
        if not stat.S_ISREG(source.lstat().st_mode): raise ValueError('Only regular files can enter host artifact storage')
        digest = hashlib.file_digest(source.open('rb'), 'sha256').hexdigest(); size = source.stat().st_size
        identity, _ = self.location(record['run']); key = f'{identity}/{category}/{digest}/{name}'; storage = self.config['storage']
        receipt = {'sha256': digest, 'bytes': size, 'key': key, 'kind': storage['kind']}
        if storage['kind'] == 'directory':
            root = Path(storage['path']); private_directory(root)
            target = root / key; target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not target.exists():
                temp = target.with_name(name + '.' + uuid.uuid4().hex); shutil.copyfile(source, temp); temp.chmod(0o600)
                with temp.open('rb') as stream: os.fsync(stream.fileno())
                temp.replace(target)
            if hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() != digest: raise ValueError('Durable artifact failed checksum verification')
            current = target.parent
            while current != root.parent:
                fd = os.open(current, os.O_DIRECTORY)
                try: os.fsync(fd)
                finally: os.close(fd)
                current = current.parent
        elif storage['kind'] == 's3':
            key = storage.get('prefix', '').strip('/') + '/' + key; receipt['key'] = key; receipt['bucket'] = storage['bucket']
            args = [self.config.get('aws', 'aws'), '--region', storage['region'], 's3api']
            value = json.loads(self.command([*args, 'put-object', '--bucket', storage['bucket'], '--key', key, '--body', str(source), '--server-side-encryption', 'AES256', '--checksum-algorithm', 'SHA256'], text=True))
            receipt['versionId'] = value['VersionId']
            head = json.loads(self.command([*args, 'head-object', '--bucket', storage['bucket'], '--key', key, '--version-id', value['VersionId'], '--checksum-mode', 'ENABLED'], text=True))
            if head.get('ChecksumSHA256') != base64.b64encode(bytes.fromhex(digest)).decode() or head['ContentLength'] != size: raise ValueError('Durable artifact failed checksum verification')
        else: raise ValueError('Unsupported durable storage')
        return receipt

    def retrieve(self, record, receipt, target):
        storage = self.config['storage']; identity, _ = self.location(record['run'])
        prefix = identity + '/' if storage['kind'] == 'directory' else storage.get('prefix', '').strip('/') + '/' + identity + '/'
        if receipt.get('kind') != storage['kind'] or not receipt.get('key', '').startswith(prefix) or '..' in Path(receipt['key']).parts:
            raise ValueError('Artifact belongs to another workspace')
        if storage['kind'] == 'directory': shutil.copyfile(Path(storage['path']) / receipt['key'], target)
        else:
            if receipt.get('bucket') != storage['bucket']: raise ValueError('Artifact bucket differs')
            self.command([self.config.get('aws', 'aws'), '--region', storage['region'], 's3api', 'get-object', '--bucket', storage['bucket'], '--key', receipt['key'], '--version-id', receipt['versionId'], str(target)], text=True)
        if target.stat().st_size != receipt['bytes'] or hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() != receipt['sha256']:
            raise ValueError('Saved artifact failed integrity verification')

    def remove_object(self, record, receipt):
        with tempfile.TemporaryDirectory(prefix='workspace-delete-') as temporary:
            self.retrieve(record, receipt, Path(temporary) / 'verified')
        storage = self.config['storage']
        if storage['kind'] == 'directory': (Path(storage['path']) / receipt['key']).unlink()
        else: self.command([self.config.get('aws', 'aws'), '--region', storage['region'], 's3api', 'delete-object', '--bucket', storage['bucket'], '--key', receipt['key'], '--version-id', receipt['versionId']], text=True)

    def prune(self, record):
        pending = []
        for receipt in record.get('pendingDeletes', []):
            try: self.remove_object(record, receipt)
            except Exception: pending.append(receipt)
        record['pendingDeletes'] = pending; self.save(record)

    def checkpoint(self, record, final=False):
        row = self.owned(record)
        if not row: raise ValueError('Cannot checkpoint a missing workspace')
        remote = '/tmp/dispatch-checkpoint-' + uuid.uuid4().hex + '.tar.gz'
        script = (HERE / 'workspace_checkpoint.py').read_text()
        try:
            manifest = json.loads(self.command(self.guest_command(row, 'python3', '-c', script, 'save', remote), text=True))
            with tempfile.TemporaryDirectory(prefix='workspace-save-') as temporary:
                archive = Path(temporary) / 'source-and-artifacts.tar.gz'; self.copy_from_guest(row, remote, archive)
                receipt = self.store(record, archive, 'deliverables' if final else 'recovery', archive.name)
        finally: self.command(self.guest_command(row, 'rm', '-f', remote), text=True)
        if final:
            record['finalSnapshot'] = receipt
            if receipt not in record['artifacts']: record['artifacts'].append(receipt)
        else:
            old = record.get('recovery'); record['recovery'] = receipt
            if old and old != receipt: record.setdefault('pendingDeletes', []).append(old)
        record['sourceInventory'] = manifest; self.save(record); self.prune(record)
        return receipt

    def delete(self, record):
        row = self.owned(record)
        if row:
            record['writableLayer'] = row.get('GraphDriver', {}).get('Data', {}).get('UpperDir'); self.save(record)
            self.docker('rm', '--force', '--volumes', row['Id'])
        if self.owned(record) or record.get('writableLayer') and Path(record['writableLayer']).exists(): raise ValueError('Workspace storage deletion is incomplete')
        if record.get('sandbox'):
            # Removing a direct registration never deletes a remote provider VM.
            rows = json.loads(self.cua('spaces', 'ls')); rows = rows.get('spaces', []) if isinstance(rows, dict) else rows
            if any(x.get('id') == record['sandbox'] for x in rows): self.cua('spaces', 'rm', record['sandbox'])
        record['state'] = 'deleted'; record['deletedAt'] = time.time(); self.save(record)
        if record.get('name'): shutil.rmtree(self.root / 'control' / record['name'], ignore_errors=True)
        return record

    def execute(self, q):
        op = q['op']
        if op == 'configure-network': return self.network(configure=True)
        run = q['run']
        read_only = op in ('status', 'shell', 'read', 'write', 'fs', 'read-artifact')
        with self.locked(run, shared=read_only):
            if op == 'bind': return self.bind(run, q['release'])
            record = self.load(run)
            if op == 'status': return record
            if not record: raise ValueError('Bind this workflow to a release before using its workspace')
            if op == 'ensure': return self.ensure(record)
            if op == 'shell': return self.guest(record, {k: v for k, v in q.items() if k not in ('op', 'run')}, shell=True)
            if op in ('read', 'write'): return self.guest(record, {'action': op, **{k: v for k, v in q.items() if k not in ('op', 'run')}})
            if op == 'fs': return self.guest(record, q['request'])
            if op == 'checkpoint': return self.checkpoint(record)
            if op == 'suspend':
                if record['state'] not in ('uncreated', 'deleted'): self.checkpoint(record); self.delete(record)
                return record
            if op == 'export':
                path = q['path']
                if not isinstance(path, str) or not path.startswith('/workspace/'): raise ValueError('Export a file from /workspace')
                path = self.guest(record, {'action': 'canonical', 'path': path})
                if not path.startswith('/workspace/'): raise ValueError('Export must stay inside /workspace')
                row = self.owned(record)
                with tempfile.TemporaryDirectory(prefix='workspace-export-') as temporary:
                    local = Path(temporary) / 'file'; self.copy_from_guest(row, path, local, '/workspace')
                    receipt = self.store(record, local, 'deliverables', Path(path).name)
                if receipt not in record['artifacts']: record['artifacts'].append(receipt)
                self.save(record); return receipt
            if op == 'read-artifact':
                receipt = q['receipt']
                if receipt not in record.get('artifacts', []) and receipt != record.get('recovery'): raise ValueError('Unknown retained artifact')
                with tempfile.TemporaryDirectory(prefix='workspace-read-') as temporary:
                    local = Path(temporary) / 'file'; self.retrieve(record, receipt, local)
                    offset = q.get('offset', 0); length = q.get('length')
                    if not isinstance(offset, int) or offset < 0 or length is not None and (not isinstance(length, int) or length < 0): raise ValueError('Invalid artifact byte range')
                    with local.open('rb') as stream:
                        stream.seek(offset); data = stream.read(length) if length is not None else stream.read()
                    return {'content': base64.b64encode(data).decode(), 'offset': offset, 'nextOffset': offset + len(data), 'bytes': receipt['bytes']}
            if op == 'finish':
                if not record.get('finished'):
                    if record['state'] == 'uncreated': pass
                    elif not record.get('finalSnapshot') or self.owned(record):
                        if not self.owned(record): self.ensure(record)
                        self.checkpoint(record, final=True)
                    else:
                        with tempfile.TemporaryDirectory(prefix='workspace-finish-') as temporary:
                            self.retrieve(record, record['finalSnapshot'], Path(temporary) / 'verified')
                    self.delete(record)
                    if record.get('recovery'): record.setdefault('pendingDeletes', []).append(record.pop('recovery'))
                    record['finished'] = True; self.save(record)
                self.prune(record); return record
            if op == 'discard':
                if q.get('confirm') != run: raise ValueError('Explicit run identity confirmation required to discard recovery')
                self.delete(record)
                if record.get('recovery'): record.setdefault('pendingDeletes', []).append(record.pop('recovery'))
                record['finished'] = True; record['discarded'] = True; self.save(record); self.prune(record); return record
            raise ValueError('Unknown workspace operation')


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--config', required=True, type=Path); args = parser.parse_args()
    try:
        request = json.load(sys.stdin)
        result = Controller(args.config).execute(request)
        if not (request.get('op') == 'shell' and request.get('stream')): print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'error': {'type': type(error).__name__, 'message': str(error)}})); sys.exit(1)


if __name__ == '__main__': main()
