#!/usr/bin/env python3
"""Root-owned admission and native run control; company authority is a relay adapter."""
import argparse
import http.server
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import struct
import threading

from common import ROOT, RUNTIME, CONFIG, private_config, valid_run, save, release_reference, immutable_path, load_release
from controller import Controller, UnixConnection


class Records:
    def path(self, run): return ROOT / 'spaces' / (valid_run(run) + '.json')
    save = staticmethod(save)


class RunNotFound(ValueError): pass


class Broker:
    ROOT = ROOT
    def __init__(self, config):
        self.config = config
        self.locks, self.owners, self.active_calls = {}, {}, {}
        self.lock_guard = threading.Lock()
        self.intent_guard = threading.Lock()
        self.spaces = Records()
        for path in (ROOT, ROOT / 'assignments', ROOT / 'intents', ROOT / 'spaces', RUNTIME):
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.controller = Controller(config, self)

    def lock(self, run):
        with self.lock_guard: return self.locks.setdefault(valid_run(run), threading.Lock())

    def assignment(self, run):
        try: value = json.loads((ROOT / 'assignments' / (valid_run(run) + '.json')).read_text())
        except FileNotFoundError: raise RunNotFound('No admitted run has this identity') from None
        if value.get('run') != run: raise ValueError('Assignment identity mismatch')
        intent = ROOT / 'intents' / (run + '.json')
        if intent.exists(): value.update(json.loads(intent.read_text()))
        return value

    metadata = assignment

    def save_assignment(self, value):
        with self.intent_guard:
            intent = ROOT / 'intents' / (valid_run(value['run']) + '.json')
            if intent.exists(): value.update(json.loads(intent.read_text()))
            save(ROOT / 'assignments' / (value['run'] + '.json'), value)

    def ensure_worker(self, run, owner=None):
        value = self.assignment(run)
        if value.get('suspended') or value.get('finished'): raise ValueError('Run is not admitted')
        self.controller.prepare_space(value)
        if self.assignment(run).get('suspended'): raise ValueError('Run stopped during workspace preparation')
        result = self.controller.ensure(value)
        value['cancelPending'] = False
        self.save_assignment(value)
        return result

    def ensure(self, run, body):
        with self.lock(run):
            with self.intent_guard:
                try:
                    value = self.assignment(run)
                    if value['input'] != body['input']:
                        raise ValueError('Retained runs keep their original input; use command for new input')
                    if value.get('finished'): raise ValueError('Finished run needs a new identity')
                    if value['release'] != body['release']:
                        if body.get('updateRelease') != 'when-idle':
                            raise ValueError('Use updateRelease when-idle to select another release')
                        if value.get('fleet'):
                            raise ValueError('Suspend the worker before changing its release')
                        manifest = release_reference(body['release'])
                        if (manifest['fleet']['namespace'] != value['namespace']
                                or not set(value['roles']).issubset(manifest['fleet']['roles'])):
                            raise ValueError('The selected release must preserve the native namespace and roles')
                        connection = UnixConnection('/run/dispatch-fleet/storage.sock', timeout=30)
                        try:
                            connection.request('POST', '/idle/' + run, body=b'{}')
                            response = connection.getresponse()
                            inspection = json.loads(response.read())
                            if response.status != 200 or inspection.get('ok') is not True:
                                raise ValueError('Could not establish whether the retained native work is idle')
                        finally: connection.close()
                        # Suspension alone preserves unfinished work. The storage
                        # owner closes its handles and checks the fenced stores.
                        if inspection['result']['idle']:
                            value['release'] = body['release']
                            value['roles'] = manifest['fleet']['roles']
                        else:
                            def pi_version(release):
                                path = release['dispatch']['storePath'] + '/lib/dispatch-runner/node_modules/@earendil-works/pi-durable/package.json'
                                return json.loads(immutable_path(path).read_text())['version']
                            if pi_version(load_release(value['release']['manifest'])) != pi_version(manifest):
                                raise ValueError('Unfinished work must finish or be qualified for the selected Pi runtime before upgrading')
                except RunNotFound:
                    manifest = release_reference(body['release'])
                    value = {'run': run, 'release': body['release'], 'input': body['input'],
                             'roles': manifest['fleet']['roles'], 'namespace': manifest['fleet']['namespace']}
                # Stop cannot insert a new intent between this activation's
                # retained-state read and removal of the preceding intent.
                intent = ROOT / 'intents' / (run + '.json')
                intent.unlink(missing_ok=True)
                fd = os.open(intent.parent, os.O_DIRECTORY)
                try: os.fsync(fd)
                finally: os.close(fd)
            value['suspended'] = False
            self.save_assignment(value)
            native = self.ensure_worker(run)
            return {'assignment': self.assignment(run), 'native': native}

    def command(self, run, body):
        with self.lock(run):
            value = self.assignment(run)
            if value.get('suspended') or value.get('finished'): raise ValueError('Run is suspended')
            if not value.get('fleet'): self.ensure_worker(run)
            with self.controller.condition:
                self.active_calls[run] = self.active_calls.get(run, 0) + 1
        try: return self.controller.request(run, body['command'], body.get('timeout'), body.get('observation') is True)
        finally:
            with self.controller.condition:
                self.active_calls[run] -= 1
                if not self.active_calls[run]: self.active_calls.pop(run)
                self.controller.condition.notify_all()

    def stop(self, run, cancel=False, finished=False):
        # Persist intent before taking a lock held by an in-flight admission.
        # The worker's release tombstone preempts long guest operations.
        value = self.assignment(run)
        intent = {'suspended': True}
        if cancel or value.get('cancelPending'): intent['cancelPending'] = True
        if finished or value.get('finished'): intent['finished'] = True
        with self.intent_guard: save(ROOT / 'intents' / (run + '.json'), intent)
        with self.controller.condition: self.controller.condition.notify_all()
        worker = (value.get('fleet') or {}).get('workerId')
        with self.controller.ownership_lock(self.lock(run), worker, timeout=60) as fenced:
            value = self.assignment(run)
            if fenced: value.pop('fleet', None)
            self.save_assignment(value)
            placement = value.get('fleet')
            if finished and not placement:
                # A paused run can still own EFS files. Acquire a cleanup-only
                # placement without starting its native adapter or guest.
                value['fleetCleanup'] = True
                placement = self.controller.place(value, cleanup=True)
            if placement:
                if cancel and not value.get('fleetCleanup'):
                    try: self.controller.command(placement, run, 'request', {'command': {'tool': 'cancel'}}, timeout=30)
                    except Exception: pass  # Persisted intent precedes the bounded best-effort native abort.
                try:
                    # A cleanup-only epoch is installed by space.delete itself;
                    # no native process has been admitted under that ownership.
                    if not value.get('fleetCleanup'):
                        self.controller.suspend(value, timeout=60)
                    self.controller.command(placement, run, 'space.delete', {'finished': finished, 'assignment': value}, timeout=120)
                except Exception:
                    with self.controller.condition:
                        if placement['workerId'] not in self.controller.retiring:
                            self.controller.retiring.add(placement['workerId'])
                            threading.Thread(target=self.controller.retire, args=(placement['workerId'], True), daemon=True).start()
                    raise
                value.pop('fleet', None)
                value.pop('fleetCleanup', None)
                self.save_assignment(value)
            return {'assignment': value}


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = socket.SOMAXCONN


def serve(broker):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self): self.handle_request()
        def do_POST(self): self.handle_request()
        def handle_request(self):
            status = 200
            try:
                _, uid, _ = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != 0: raise ValueError('Only the trusted root adapter may admit or inspect fleet runs')
                match = re.fullmatch('/runs/([a-f0-9]{64})/(ensure|command|status|assignment|suspend|cancel|finish)', self.path)
                if not match: raise ValueError('Unknown control endpoint')
                run, action = match.groups()
                if self.command == 'GET' and action in ('status', 'assignment'):
                    assignment = broker.assignment(run)
                    result = assignment if action == 'assignment' else {'assignment': assignment}
                elif self.command == 'POST':
                    if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) != 1:
                        raise ValueError('Use a single Content-Length frame')
                    size = int(self.headers['Content-Length'])
                    if size < 0: raise ValueError('Invalid request size')
                    data = self.rfile.read(size)
                    if len(data) != size: raise ValueError('Incomplete request')
                    body = json.loads(data)
                    if action == 'ensure': result = broker.ensure(run, body)
                    elif action == 'command': result = broker.command(run, body)
                    elif action in ('suspend', 'cancel', 'finish'): result = broker.stop(run, cancel=action == 'cancel', finished=action == 'finish')
                    else: raise ValueError('Unknown control operation')
                else: raise ValueError('Unsupported control method')
                value = {'ok': True, 'result': result}
            except RunNotFound:
                status, value = 404, {'ok': False, 'code': 'RunNotFound', 'error': 'No admitted run has this identity'}
            except Exception as error:
                status, value = 409, {'ok': False, 'error': str(error) if isinstance(error, ValueError)
                                    else 'Fleet operation failed; retained state was preserved'}
            payload = json.dumps(value).encode()
            self.send_response(status); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)

    path = RUNTIME / 'control.sock'
    if path.exists():
        with socket.socket(socket.AF_UNIX) as probe:
            if probe.connect_ex(str(path)) == 0: raise ValueError('A fleet coordinator already owns this socket')
        path.unlink()
    server = Server(str(path), Handler); path.chmod(0o600)
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--config', type=Path, default=CONFIG)
    args = parser.parse_args()
    if os.geteuid() != 0: raise ValueError('The coordinator must run as root')
    broker = Broker(private_config(args.config))
    server = serve(broker)
    broker.controller.start()
    stopping = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT): signal.signal(signum, lambda *_: stopping.set())
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try: stopping.wait()
    finally:
        broker.controller.shutdown()
        server.shutdown(); server.server_close()


if __name__ == '__main__': main()
