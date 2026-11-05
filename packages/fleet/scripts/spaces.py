"""Worker-local adapter to the application's pinned shared workspace controller."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import selectors
import socket
import subprocess
import threading

from common import ROOT, save, valid_run, load_release

RUN = ROOT / 'control'
CONFIG = Path('/etc/dispatch-fleet/workspace.json')
sessions, session_guard = {}, threading.Lock()


def assignment(run):
    return json.loads((ROOT / 'assignments' / (valid_run(run) + '.json')).read_text())


def engine(run):
    manifest = load_release(assignment(run)['release']['manifest'])
    spec = importlib.util.spec_from_file_location('dispatch_workspace', manifest['workspaceController'])
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module.Controller(CONFIG)


def path(run):
    identity = hashlib.sha256(('dispatch-fleet\0' + valid_run(run)).encode()).hexdigest()
    return ROOT / 'spaces/runs' / (identity + '.json')


def record_for(run):
    value = json.loads(path(run).read_text())
    if value.get('run') != run: raise ValueError('Workspace identity mismatch')
    return value


def persistent_workspace(run, create=False):
    controller = engine(run)
    return controller.persistent(run, create)


def ensure(run, value):
    manifest = load_release(value['release']['manifest'])
    controller = engine(run)
    release = {'definitionsRoot': manifest['definitionsRoot'], 'runtimeRevision': manifest['dispatch']['revision'],
               'runtimeEntryPoint': manifest['runtimeEntryPoint'], 'workspace': manifest['workspace']}
    with controller.locked(run):
        record = controller.bind(run, release)
        if record['release'] != controller.validate_release(release):
            raise ValueError('Workspace belongs to another immutable release')
        if not record.get('finished'): controller.ensure(record)
    return {'workspace': '/workspace'}, None


def owned(record):
    return engine(record['run']).owned(record)


def preempt(run, remove=False):
    if not path(run).exists(): return
    controller = engine(run)
    row = controller.owned(record_for(run))
    if row:
        if remove: controller.docker('rm', '--force', '--volumes', row['Id'])
        elif row['State']['Running']: controller.docker('stop', '--time', '10', row['Id'])


def delete(run):
    if not path(run).exists(): return
    controller = engine(run)
    with controller.locked(run): return controller.delete(controller.load(run))


def request(run, value, connection=None, output=None):
    """A separate controller process owns shell cancellation and its file lock."""
    if value.get('op') not in ('fs', 'shell', 'ensure', 'status', 'checkpoint', 'suspend', 'finish', 'export', 'read-artifact'):
        raise ValueError('Unknown run-bound workspace operation')
    manifest = load_release(assignment(run)['release']['manifest'])
    child = subprocess.Popen([manifest['fleet']['tools']['python'], manifest['workspaceController'], '--config', str(CONFIG)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child.stdin.write(json.dumps({**value, 'run': run}).encode()); child.stdin.close(); child.stdin = None
    chunks, errors = [], []
    streams = {child.stdout: chunks, child.stderr: errors}
    try:
        while streams:
            readable, _, _ = select.select(list(streams) + ([connection] if connection else []), [], [], .2)
            if connection and connection in readable:
                if not connection.recv(1, socket.MSG_PEEK):
                    raise ValueError('Workspace caller disconnected; reconcile interrupted effects')
            for stream in list(streams):
                if stream not in readable: continue
                chunk = os.read(stream.fileno(), 65536)
                if not chunk: streams.pop(stream); continue
                if output and stream is child.stdout: output(chunk)
                else: streams[stream].append(chunk)
        code = child.wait()
        if code: raise ValueError('Workspace operation failed: ' + b''.join(errors).decode(errors='replace')[-2000:])
        if output: return
        result = json.loads(b''.join(chunks))
        if isinstance(result, dict) and 'error' in result: raise ValueError(json.dumps(result['error']))
        if isinstance(result, dict) and value['op'] in ('ensure', 'status', 'checkpoint', 'suspend', 'finish'):
            keys = ('run', 'state', 'finished', 'release', 'artifacts', 'recovery', 'finalSnapshot')
            return {key: result[key] for key in keys if key in result}
        return result
    except BaseException:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
        raise
    finally:
        child.stdout.close(); child.stderr.close()


def computer(run, name, arguments):
    controller = engine(run)
    with controller.desktop_lease(run) as record:
        with session_guard:
            session = sessions.get(run)
            if session and session['sandbox'] != record['sandbox']:
                close_session(session)
                sessions.pop(run)
                session = None
            if not session or session['process'].poll() is not None:
                if session: close_session(session)
                process = subprocess.Popen([*controller.config['cua'], 'mcp', '--permissions', 'computer:all',
                    '--sandbox', record['sandbox']],
                    env={**os.environ, **controller.config.get('cuaEnv', {}), 'CUA_TELEMETRY': '0', 'DO_NOT_TRACK': '1'},
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
                selector = selectors.DefaultSelector(); selector.register(process.stdout, selectors.EVENT_READ)
                session = {'process': process, 'selector': selector, 'sequence': 0,
                           'lock': threading.Lock(), 'sandbox': record['sandbox']}
                sessions[run] = session
                exchange(session, 'initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                    'clientInfo': {'name': 'dispatch-fleet', 'version': '1'}})
                process.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n'); process.stdin.flush()
        with session['lock']:
            catalog = exchange(session, 'tools/list', {})
            allowed = [tool for tool in catalog.get('tools', []) if tool['name'].startswith('computer_')]
            for tool in allowed: tool['inputSchema'].get('properties', {}).pop('sandbox', None)
            if name is None: return {'tools': allowed}
            if name not in {tool['name'] for tool in allowed}: raise ValueError('Discover a computer tool first')
            arguments = dict(arguments or {})
            if any(key in arguments for key in ('on', 'host', 'space', 'location', 'token', 'sandbox')):
                raise ValueError('Computer calls cannot select another workspace')
            return exchange(session, 'tools/call', {'name': name, 'arguments': arguments})


def exchange(session, method, params):
    session['sequence'] += 1
    identity = session['sequence']; process = session['process']
    process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': identity, 'method': method, 'params': params}) + '\n'); process.stdin.flush()
    while session['selector'].select(timeout=60):
        line = process.stdout.readline()
        if not line: break
        response = json.loads(line)
        if response.get('id') != identity: continue
        if 'error' in response: raise ValueError('Computer request failed')
        return response['result']
    raise ValueError('Computer request did not return; inspect before repeating an effect')


def close_session(session):
    process = session['process']
    process.terminate(); session['selector'].close()
    try: process.wait(timeout=10)
    except subprocess.TimeoutExpired: process.kill(); process.wait()
    process.stdin.close(); process.stdout.close()


def close_connections(run):
    with session_guard: session = sessions.pop(run, None)
    if session: close_session(session)
