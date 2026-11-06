#!/usr/bin/env python3
"""Root-only, outbound Dispatch fleet transport; native processes get no fleet grant."""
import argparse
import hashlib
import http.client
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import socketserver
import stat
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import spaces
from common import cleanup_relay, load_release

ROOT = Path('/var/lib/dispatch-fleet')
ASSIGNMENTS = spaces.ROOT / 'assignments'
RUNTIME = Path('/run/dispatch-fleet/runs')
PRIVATE_RUNTIME = Path('/run/private/dispatch-fleet/runs')
def roles(run):
    return load_release(spaces.assignment(run)['release']['manifest'])['fleet']['roles']


def valid_run(run):
    if not isinstance(run, str) or not re.fullmatch('[a-f0-9]{64}', run):
        raise ValueError('Invalid run identity')
    return run


def systemctl(*args):
    return subprocess.run(['systemctl', *args], capture_output=True, text=True, check=True).stdout.strip()


def unit(run):
    return 'dispatch-fleet-run@' + valid_run(run) + '.service'


def identity(run):
    return 'dfl-ws-' + valid_run(run)[:22]


def runtime_owner(run):
    path = RUNTIME / valid_run(run)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        # DynamicUser + RuntimeDirectoryPreserve moves the directory beneath
        # /run/private. Accept only systemd's exact root-protected projection.
        target = PRIVATE_RUNTIME / run
        if path.resolve(strict=True) != target:
            raise ValueError('Unexpected private native runtime projection')
        for parent in PRIVATE_RUNTIME.parents:
            if parent.is_symlink() or parent.stat().st_uid or parent.stat().st_mode & 0o022:
                raise ValueError('The private runtime parent must be root protected')
        if PRIVATE_RUNTIME.is_symlink() or PRIVATE_RUNTIME.stat().st_uid or PRIVATE_RUNTIME.stat().st_mode & 0o022:
            raise ValueError('The native runtime parent must be root protected')
        info = target.lstat()
    if not stat.S_ISDIR(info.st_mode): raise ValueError('The native runtime must be a directory')
    if info.st_uid not in (0, 65534) and info.st_uid == info.st_gid:
        return info.st_uid, info.st_gid
    # On hosts which id-map preserved directories, disk ownership is nobody.
    # Query the system manager directly, independent of host NSS configuration.
    result = subprocess.run(['/usr/bin/busctl', 'call', 'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager',
        'LookupDynamicUserByName', 's', identity(run)], capture_output=True, text=True, check=True).stdout.strip()
    match = re.fullmatch(r'u ([0-9]+)', result)
    if not match or int(match[1]) in (0, 65534): raise ValueError('Missing native DynamicUser allocation')
    uid = int(match[1])
    return uid, uid  # The template leaves Group unset: systemd allocates the pair.


def private_config(path):
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid or st.st_mode & 0o077:
        raise ValueError('Fleet configuration must be a root-owned private file')
    config = json.loads(path.read_text())
    parsed = urllib.parse.urlsplit(config['controlUrl'])
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
            parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ValueError('The fleet coordinator needs an HTTPS origin')
    config['controlUrl'] = config['controlUrl'].rstrip('/')
    return config


class Metadata:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.token, self.expires = None, 0
        self.lock = threading.Lock()

    def read(self, path):
        with self.lock:
            if time.monotonic() >= self.expires:
                request = urllib.request.Request('http://169.254.169.254/latest/api/token', method='PUT',
                    headers={'X-aws-ec2-metadata-token-ttl-seconds': '60'})
                with self.opener.open(request, timeout=2) as response:
                    self.token = response.read().decode()
                self.expires = time.monotonic() + 50
            request = urllib.request.Request('http://169.254.169.254/latest/' + path,
                headers={'X-aws-ec2-metadata-token': self.token})
            with self.opener.open(request, timeout=2) as response:
                return response.read().decode()


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=None):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class UnixHTTP(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = socket.SOMAXCONN


def worker_request(run, command, timeout=None):
    connection = UnixConnection(RUNTIME / valid_run(run) / 'worker.sock', timeout)
    try:
        connection.request('POST', '/commands', json.dumps(command), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        result = json.loads(response.read())
        if not result.get('ok'):
            raise ValueError(result.get('error', 'Native worker rejected the request'))
        return result['result']
    finally:
        connection.close()


def artifact_root(run, role):
    if role not in roles(run): raise ValueError('Unknown native artifact role')
    workspace = spaces.persistent_workspace(valid_run(run), True)
    root = workspace.parent / 'artifacts'
    root.mkdir(mode=0o700, exist_ok=True)
    if root.is_symlink() or root.stat().st_uid or root.stat().st_mode & 0o077:
        raise ValueError('Artifact parent must be private and root owned')
    target = root / role
    target.mkdir(mode=0o700, exist_ok=True)
    if target.is_symlink() or not target.is_dir(): raise ValueError('Invalid artifact root')
    return target


def prepare_artifacts(run):
    """ExecStartPre runs after DynamicUser allocation and before any native writer."""
    valid_run(run)
    assignment = json.loads((ASSIGNMENTS / (run + '.json')).read_text())
    if assignment.get('run') != run or not assignment.get('fleet'):
        raise ValueError('A coordinator-assigned run is required')
    uid, gid = runtime_owner(run)
    state = Path('/var/lib/dispatch-fleet-runs-' + run)
    state_owner = state.stat()
    native = state / 'native'
    native.mkdir(mode=0o700, exist_ok=True)
    if native.is_symlink() or not native.is_dir(): raise ValueError('Invalid native state parent')
    # On hosts with id-mapped StateDirectory mounts, the on-disk owner is
    # nobody and systemd maps it to the DynamicUser inside the namespace.
    os.chown(native, state_owner.st_uid, state_owner.st_gid); native.chmod(0o700)
    # Every directory remains private. A replacement DynamicUser may have a
    # different numeric UID; only artifact bytes are re-owned, never native DBs.
    for role in roles(run):
        directory = native / role
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink() or not directory.is_dir(): raise ValueError('Invalid native role directory')
        os.chown(directory, state_owner.st_uid, state_owner.st_gid); directory.chmod(0o700)
        root = artifact_root(run, role)
        for directory, dirs, files, descriptor in os.fwalk(root, follow_symlinks=False):
            for name in dirs + files:
                info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or (
                        stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
                    raise ValueError('Artifact state contains an unsafe filesystem entry')
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
                try:
                    opened = os.fstat(child)
                    if (opened.st_ino, opened.st_dev) != (info.st_ino, info.st_dev):
                        raise ValueError('Artifact state changed while recovering its owner')
                    os.fchown(child, uid, gid)
                    os.fchmod(child, 0o700 if stat.S_ISDIR(info.st_mode) else 0o600)
                finally: os.close(child)
            os.fchown(descriptor, uid, gid)
            os.fchmod(descriptor, 0o700)


class Worker:
    def __init__(self, config):
        import boto3
        self.config = config
        self.metadata = Metadata()
        self.worker_id = self.metadata.read('meta-data/instance-id')
        if not re.fullmatch(r'i-[a-f0-9]{17}', self.worker_id):
            raise ValueError('An EC2 instance identity is required')
        self.boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        secret = boto3.client('secretsmanager', region_name=config['region']).get_secret_value(SecretId=config['secretArn'])
        self.token = json.loads(secret['SecretString'])['token']
        if not isinstance(self.token, str) or len(self.token) < 32:
            raise ValueError('Missing fleet authentication secret')
        self.origin = urllib.parse.urlsplit(config['controlUrl'])
        self.guard = threading.RLock()
        self.stop = threading.Event()
        self.last_contact = time.monotonic()
        self.draining = False
        self.quarantined = False
        self.proxies, self.locks, self.inflight = {}, {}, set()
        self.stopping = {}
        self.runs, self.ledger = {}, {}
        self.cpu = self.cpu_sample()
        for path in (ROOT / 'runs', ROOT / 'commands', ASSIGNMENTS, spaces.RUN, RUNTIME):
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        for path in (ROOT / 'runs').glob('*.json'):
            row = json.loads(path.read_text()); valid_run(row['run'])
            self.runs[row['run']] = row
        # A restarted daemon cannot prove which pre-restart requests escaped.
        # Let the coordinator fence/reassign its retained runs as a group.
        self.draining = bool(self.runs)
        for path in (ROOT / 'commands').glob('*.json'):
            row = json.loads(path.read_text())
            if row['state'] == 'running':
                row['state'] = 'done'
                row['response'] = {**row['identity'], 'ok': False,
                    'error': 'Worker restarted during this operation; inspect retained state before repeating an effect'}
                spaces.save(path, row)
            self.ledger[row['identity']['id']] = row

    def headers(self, epoch=None):
        result = {'Authorization': 'Bearer ' + self.token, 'X-Worker-Id': self.worker_id,
                  'Content-Type': 'application/json'}
        if epoch is not None: result['X-Run-Epoch'] = str(epoch)
        return result

    def connection(self, timeout=None):
        return http.client.HTTPSConnection(self.origin.hostname, self.origin.port or 443, timeout=timeout)

    def rpc(self, path, value, timeout=40):
        connection = self.connection(timeout)
        try:
            connection.request('POST', path, json.dumps(value), self.headers())
            response = connection.getresponse()
            data = response.read()
            if response.status != 200:
                raise ValueError('Coordinator refused fleet request (HTTP ' + str(response.status) + ')')
            result = json.loads(data)
            self.last_contact = time.monotonic()
            return result
        finally: connection.close()

    def save_run(self, row):
        with self.guard:
            old = self.runs.get(row['run'])
            if old and (old['epoch'] > row['epoch'] or old['epoch'] == row['epoch'] and
                    old['state'] == 'released' and row['state'] != 'released'):
                raise ValueError('A released ownership epoch cannot become active again')
            spaces.save(ROOT / 'runs' / (row['run'] + '.json'), row)
            self.runs[row['run']] = row

    def lease(self, run, epoch, allow_released=False):
        with self.guard:
            row = self.runs.get(run)
            if not row or row['epoch'] != epoch:
                raise ValueError('Command belongs to a different run owner')
            if row['state'] == 'released' and not allow_released:
                raise ValueError('This run ownership has been released')
            return dict(row)

    def relay_lease(self, run, epoch, method, path):
        with self.guard:
            closing = cleanup_relay(method, path) and self.stopping.get((run, epoch), 0) > 0
            row = self.lease(run, epoch, allow_released=closing)
            if (self.quarantined or row['state'] != 'running') and not closing:
                raise ValueError('This worker no longer owns an active run')
            return row

    def install_assignment(self, run, epoch, assignment):
        if (not isinstance(assignment, dict) or assignment.get('run') != run or
                assignment.get('fleet') != {'workerId': self.worker_id, 'epoch': epoch}):
            raise ValueError('Assignment belongs to a different fleet owner')
        prior = self.runs.get(run)
        if prior and prior['epoch'] > epoch:
            raise ValueError('Stale assignment epoch')
        if prior and prior['epoch'] == epoch and prior['state'] == 'released':
            raise ValueError('A released ownership epoch cannot start again')
        if prior and prior['epoch'] < epoch:
            self.suspend(run, stop_space=True)
            self.close_proxy(run)
        if self.draining or self.quarantined:
            raise ValueError('Worker is draining; retain this run for another owner')
        release = assignment['release']
        if not Path(release['manifest']).is_file():
            spec = importlib.util.spec_from_file_location('fleet_installer', Path(__file__).with_name('install-fleet-worker.py'))
            installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
            staged = installer.stage_installation({**self.config, 'manifest': release['manifest'],
                'releaseKey': release['archiveKey'], 'releaseSha256': release['archiveSha256']})
            if str(staged) != release['manifest']: raise ValueError('Staged release differs from the admitted run')
        manifest = load_release(release['manifest'])
        if assignment.get('roles') != manifest['fleet']['roles']:
            raise ValueError('Native stores differ from the pinned release')
        for path in ASSIGNMENTS.glob('*.json'):
            if path.stem != run and path.stem[:22] == run[:22]:
                raise ValueError('Workspace OS identity collision')
        if prior and prior['epoch'] == epoch:
            original = json.loads((ASSIGNMENTS / (run + '.json')).read_text())
            if any(original.get(key) != assignment.get(key) for key in ('release', 'input', 'roles')):
                raise ValueError('An admitted run cannot change its immutable execution binding')
        spaces.save(ASSIGNMENTS / (run + '.json'), assignment)
        self.save_run({'run': run, 'epoch': epoch,
            'state': prior.get('state', 'prepared') if prior and prior['epoch'] == epoch else 'prepared'})
        return assignment

    def close_proxy(self, run):
        server = self.proxies.pop(run, None)
        if server:
            server.shutdown(); server.server_close()
            (RUNTIME / run / 'relay.sock').unlink(missing_ok=True)

    def proxy(self, run, epoch):
        if run in self.proxies: return
        worker = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self): self.relay()
            def do_POST(self): self.relay()

            def relay(self):
                started = False
                connection = None
                try:
                    _, uid, _ = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid not in (0, runtime_owner(run)[0]):
                        raise ValueError('Run relay peer is not its native worker')
                    worker.relay_lease(run, epoch, self.command, self.path)
                    if (not (self.path.startswith(('/v1/', '/company/', '/storage/')) or self.path in ('/events', '/workspace', '/workspace/computer')) or
                            '#' in self.path or '\r' in self.path or '\n' in self.path):
                        raise ValueError('Unknown scoped relay operation')
                    if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) > 1:
                        raise ValueError('Use a single Content-Length frame')
                    size = int(self.headers.get('Content-Length', '0'))
                    if size < 0 or self.command == 'GET' and size:
                        raise ValueError('Invalid relay frame')
                    body = self.rfile.read(size)
                    if len(body) != size: raise ValueError('Incomplete relay frame')
                    if self.path == '/workspace':
                        request = json.loads(body)
                        if request.get('op') not in ('fs', 'shell', 'ensure', 'status', 'checkpoint', 'suspend', 'finish', 'export', 'read-artifact'):
                            raise ValueError('Unknown native workspace operation')
                        if request.get('stream') and request['op'] != 'shell':
                            raise ValueError('Only guest shell output uses streaming frames')
                        if request.get('stream'):
                            self.send_response(200); self.send_header('Content-Type', 'application/x-ndjson'); self.end_headers(); started = True
                            spaces.request(run, request, self.connection, lambda part: (self.wfile.write(part), self.wfile.flush()))
                        else:
                            result = spaces.request(run, request, self.connection)
                            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); started = True
                            self.wfile.write(json.dumps(result).encode())
                        return
                    if self.path == '/workspace/computer':
                        request = json.loads(body)
                        result = spaces.computer(run, request.get('name'), request.get('arguments'))
                        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); started = True
                        self.wfile.write(json.dumps(result).encode()); return
                    connection = worker.connection()
                    headers = worker.headers(epoch)
                    headers['Content-Length'] = str(len(body))
                    connection.request(self.command, '/fleet/runs/' + run + '/relay' + self.path, body or None, headers)
                    response = connection.getresponse()
                    if response.status < 500: worker.last_contact = time.monotonic()
                    self.send_response(response.status)
                    self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
                    self.end_headers(); started = True
                    while True:
                        part = response.read1(65536)
                        if not part: break
                        self.wfile.write(part); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError): pass
                except Exception as error:
                    if not started:
                        self.send_response(409); self.send_header('Content-Type', 'application/json'); self.end_headers()
                        self.wfile.write(json.dumps({'ok': False, 'error': str(error) if isinstance(error, ValueError)
                            else 'Scoped relay failed; retained native state was not reset'}).encode())
                finally:
                    if connection: connection.close()

        directory = RUNTIME / run
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / 'relay.sock'
        path.unlink(missing_ok=True)
        server = UnixHTTP(str(path), Handler)
        path.chmod(0o666)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.proxies[run] = server

    def start_run(self, run, epoch, assignment):
        self.install_assignment(run, epoch, assignment)
        binding, _ = spaces.ensure(run, assignment)
        manifest = load_release(assignment['release']['manifest'])
        tools = manifest['fleet']['tools']
        content = '[Service]\nUser=' + identity(run) + '\n'
        content += f"ExecStartPre=\nExecStartPre=+{tools['python']} {tools['scripts']}/fleet-worker.py --prepare-artifacts {run}\n"
        content += f"ExecStart=\nExecStart={tools['python']} {tools['scripts']}/workspace-launch.py {run}\n"
        for role in roles(run):
            root = artifact_root(run, role)
            content += f'BindPaths={root}:/var/lib/dispatch-fleet-runs-{run}/native/{role}/artifacts\n'
        dropin = Path('/run/systemd/system') / (unit(run) + '.d')
        dropin.mkdir(parents=True, exist_ok=True, mode=0o755)
        target = dropin / 'identity.conf'
        if not target.exists() or target.read_text() != content:
            if subprocess.run(['systemctl', 'is-active', '--quiet', unit(run)], capture_output=True).returncode == 0:
                raise ValueError('Stop the existing native worker before changing its binding')
            target.write_text(content); target.chmod(0o644)
            systemctl('daemon-reload')
        self.proxy(run, epoch)
        self.save_run({'run': run, 'epoch': epoch, 'state': 'running'})
        try:
            systemctl('start', unit(run))
            deadline = time.monotonic() + 110
            while time.monotonic() < deadline:
                self.lease(run, epoch)
                if self.quarantined: raise ValueError('Coordinator contact was lost while starting')
                try:
                    result = worker_request(run, {'tool': 'status'}, timeout=5)
                    if assignment.get('cancelPending'):
                        assignment['cancelPending'] = False
                        spaces.save(ASSIGNMENTS / (run + '.json'), assignment)
                    return result
                except (FileNotFoundError, ConnectionRefusedError): time.sleep(.2)
            raise ValueError('Native worker did not become ready; its state was retained')
        except Exception:
            self.suspend(run)
            raise

    def suspend(self, run, stop_space=False):
        with self.guard:
            row = self.runs.get(run)
            key = (run, row['epoch']) if row else None
            if row:
                self.save_run({**row, 'state': 'released' if row['state'] == 'released' else 'suspended'})
                self.stopping[key] = self.stopping.get(key, 0) + 1
        try:
            # Native SIGTERM closes remote stores and retained deliveries.
            # Permit that cleanup while the exact old process stops, then shut
            # the relay before systemd can recycle its DynamicUser identity.
            systemctl('stop', unit(run))
        finally:
            if key:
                with self.guard:
                    self.stopping[key] -= 1
                    if not self.stopping[key]: del self.stopping[key]
        if stop_space:
            spaces.close_connections(run)
            spaces.preempt(run)
        return {'suspended': True}

    def operation(self, command):
        run, epoch, operation, args = (command[key] for key in ('run', 'epoch', 'operation', 'args'))
        valid_run(run)
        if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 1 or not isinstance(args, dict):
            raise ValueError('Invalid run command')
        # Requests may wait on native work. A lifecycle command must still be
        # able to stop that process, and another run must never wait behind it.
        if operation == 'request':
            row = self.lease(run, epoch)
            if self.quarantined or row['state'] != 'running':
                raise ValueError('The native run is suspended')
            return worker_request(run, args['command'], args.get('timeout'))
        if operation == 'suspend':
            if run in self.runs: self.lease(run, epoch, allow_released=True)
            return self.suspend(run)
        if operation == 'space.delete':
            if args.get('assignment') and (run not in self.runs or self.runs[run]['epoch'] != epoch):
                self.install_assignment(run, epoch, args['assignment'])
            row = self.lease(run, epoch, allow_released=True) if run in self.runs else {'run': run, 'epoch': epoch}
            self.save_run({**row, 'state': 'released'})
            self.suspend(run)
            spaces.close_connections(run)
            # Do not wait behind a shell which can only finish when its
            # container stops. The final locked deletion below verifies that
            # an in-flight preparation did not recreate it before our ACK.
            spaces.preempt(run, remove=True)
        with self.guard: lock = self.locks.setdefault(run, threading.RLock())
        with lock:
            if operation == 'space.ensure':
                self.install_assignment(run, epoch, args['assignment'])
            elif operation != 'start':
                self.lease(run, epoch, allow_released=operation == 'space.delete')
                if self.quarantined and operation != 'space.delete':
                    raise ValueError('Worker contact was lost; retained work requires recovery')
            if operation == 'space.ensure':
                assignment = args['assignment']
                binding, credentials = spaces.ensure(run, assignment)
                record = spaces.record_for(run)
                if record.get('fleet'): raise ValueError('Worker Space records must remain local')
                return {'binding': binding, 'record': record}
            if operation == 'start': return self.start_run(run, epoch, args['assignment'])
            if operation == 'space.record': return spaces.record_for(run)
            if operation == 'space.computer': return spaces.computer(run, args.get('name'), args.get('arguments'))
            if operation == 'space.delete':
                row = self.lease(run, epoch, allow_released=True)
                self.save_run({**row, 'state': 'released'})
                self.suspend(run)
                spaces.close_connections(run)
                spaces.delete(run)
                self.close_proxy(run)
                if args.get('finished') is True and not row.get('persistentRemoved'):
                    owner = Path(self.config['workspaceRoot']) / run
                    if owner.exists() or owner.is_symlink():
                        target = spaces.persistent_workspace(run, create=True)
                        shutil.rmtree(target.parent)
                removed = bool(row.get('persistentRemoved') or args.get('finished') is True)
                self.save_run({**self.runs[run], 'releaseComplete': True, 'persistentRemoved': removed})
                return {'deleted': True, 'persistentRemoved': removed}
            if operation == 'space.request': return spaces.request(run, args['request'])
            raise ValueError('Unknown fleet worker operation')

    def command_path(self, identity):
        return ROOT / 'commands' / (hashlib.sha256(identity.encode()).hexdigest() + '.json')

    def submit(self, command):
        if not isinstance(command, dict) or not isinstance(command.get('id'), str) or not command['id']:
            raise ValueError('A command identity is required')
        identity_value = {key: command[key] for key in ('id', 'run', 'epoch')}
        fingerprint = hashlib.sha256(json.dumps(command, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with self.guard:
            old = self.ledger.get(command['id'])
            if old:
                if old['fingerprint'] != fingerprint: raise ValueError('Command identity was reused for different work')
                if old['state'] == 'done':
                    old['delivered'] = False
                    spaces.save(self.command_path(command['id']), old)
                return
            row = {'identity': identity_value, 'fingerprint': fingerprint, 'state': 'running', 'delivered': False}
            spaces.save(self.command_path(command['id']), row)
            self.ledger[command['id']] = row
        threading.Thread(target=self.execute, args=(command,), daemon=True).start()

    def execute(self, command):
        response = {key: command[key] for key in ('id', 'run', 'epoch')}
        try:
            response.update(ok=True, result=self.operation(command))
        except Exception as error:
            response.update(ok=False, error=str(error) if isinstance(error, ValueError)
                            else 'Worker operation failed; inspect retained state before repeating an effect')
        with self.guard:
            row = self.ledger[command['id']]
            row.update(state='done', response=response)
            spaces.save(self.command_path(command['id']), row)

    def deliver_results(self):
        while not self.stop.is_set():
            with self.guard:
                pending = [row for row in self.ledger.values() if row['state'] == 'done' and not row.get('delivered')]
            for row in pending:
                try:
                    self.rpc('/fleet/result', row['response'])
                    with self.guard:
                        row['delivered'] = True
                        spaces.save(self.command_path(row['identity']['id']), row)
                except Exception: break
            self.stop.wait(.2 if pending else 1)

    @staticmethod
    def cpu_sample():
        counters = [int(value) for value in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
        return sum(counters), counters[3] + counters[4]

    def pressure(self):
        total, idle = self.cpu_sample()
        previous_total, previous_idle = self.cpu
        self.cpu = total, idle
        cpu = 100 * (1 - (idle - previous_idle) / max(total - previous_total, 1))
        memory = {line.split(':')[0]: int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()}
        available = memory['MemAvailable']
        return max(0, min(100, cpu)), 100 * (1 - available / memory['MemTotal']), available

    def heartbeat(self):
        while not self.stop.is_set():
            try:
                try:
                    lifecycle = self.metadata.read('meta-data/autoscaling/target-lifecycle-state')
                    self.draining = self.draining or lifecycle in ('Terminated', 'Detached') or lifecycle.startswith('Terminating')
                except (OSError, urllib.error.HTTPError): pass
                cpu, memory, available = self.pressure()
                with self.guard: runs = [dict(row) for row in self.runs.values()]
                result = self.rpc('/fleet/heartbeat', {'workerId': self.worker_id, 'bootId': self.boot_id,
                    'cpuPercent': cpu, 'memoryPercent': memory, 'availableMemoryBytes': available,
                    'runs': runs, 'draining': self.draining or self.quarantined}, timeout=10)
                self.draining = self.draining or bool(result.get('draining'))
            except Exception: pass
            self.stop.wait(5)

    def watchdog(self):
        while not self.stop.wait(1):
            if time.monotonic() - self.last_contact < 60 or self.quarantined: continue
            self.quarantined = True
            self.stop.set()
            for run in list(self.runs):
                try: self.suspend(run, stop_space=True)
                except Exception:
                    print(json.dumps({'run': run, 'fleetWatchdog': 'stop-failed'}), flush=True)

    def serve(self):
        # A daemon restart does not authorize replaying a previously running
        # effect. Stop its old local processes before asking for new commands.
        for run in list(self.runs): self.suspend(run, stop_space=True)
        for target in (self.heartbeat, self.deliver_results, self.watchdog):
            threading.Thread(target=target, daemon=True).start()
        while not self.stop.is_set():
            try:
                response = self.rpc('/fleet/poll', {})
                for command in response['commands']:
                    self.submit(command)
            except Exception:
                self.stop.wait(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/dispatch-fleet/config.json'))
    parser.add_argument('--prepare-artifacts')
    args = parser.parse_args()
    if os.geteuid() != 0: raise ValueError('The fleet boundary must run as root')
    if args.prepare_artifacts:
        prepare_artifacts(args.prepare_artifacts)
        return
    worker = Worker(private_config(args.config))
    def shutdown(signum, frame):
        worker.draining = True; worker.stop.set()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try: worker.serve()
    finally:
        for run in list(worker.runs):
            try: worker.suspend(run, stop_space=True)
            except Exception: pass
    # The watchdog is a lost-contact failure, not an operator-requested stop.
    # Restart=on-failure reconnects idle hosts; retained runs restart draining.
    if worker.quarantined: raise SystemExit(1)


if __name__ == '__main__': main()
