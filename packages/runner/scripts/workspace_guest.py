#!/usr/bin/env python3
"""Credential-free filesystem and command operations inside one disposable computer."""
import base64
import codecs
import json
import os
from pathlib import Path
import shutil
import selectors
import signal
import stat
import subprocess
import sys
import tempfile


def info(path):
    p = Path(path)
    s = p.lstat()
    kind = 'symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file'
    if kind == 'file' and not stat.S_ISREG(s.st_mode): raise ValueError('Not a regular file')
    return {'name': p.name, 'path': str(p), 'kind': kind, 'size': s.st_size, 'mtimeMs': s.st_mtime * 1000}


def main(q):
    op = q['action']; p = q.get('path')
    if op == 'read': return {'content': base64.b64encode(Path(p).read_bytes()).decode()}
    if op in ('write', 'append'):
        with open(p, 'wb' if op == 'write' else 'ab') as f: f.write(base64.b64decode(q['content'], validate=True))
        return None
    if op == 'truncate':
        with open(p, 'r+b') as f: f.truncate(q['size'])
        return None
    if op == 'flush':
        with open(p, 'rb') as f: os.fsync(f.fileno())
        return None
    if op == 'rename': os.replace(p, q['destination']); return None
    if op == 'info': return info(p)
    if op == 'list': return [info(x) for x in Path(p).iterdir()]
    if op == 'canonical': return str(Path(p).resolve(strict=True))
    if op == 'exists': return Path(p).exists()
    if op == 'mkdir': Path(p).mkdir(parents=q.get('recursive', False), exist_ok=q.get('recursive', False)); return None
    if op == 'remove':
        x = Path(p)
        if not x.exists() and not x.is_symlink() and q.get('force'): return None
        if x.is_dir() and not x.is_symlink():
            if q.get('recursive'): shutil.rmtree(x)
            else: x.rmdir()
        else: x.unlink()
        return None
    if op == 'temp-dir': return tempfile.mkdtemp(prefix=q.get('prefix', 'dispatch-'))
    if op == 'temp-file':
        fd, name = tempfile.mkstemp(prefix=q.get('prefix', 'dispatch-'), suffix=q.get('suffix', '')); os.close(fd); return name
    if op == 'reader-open':
        flags = os.O_RDONLY | os.O_NONBLOCK | (os.O_NOFOLLOW if q.get('noFollow') else 0)
        fd = os.open(p, flags)
        try:
            s = os.fstat(fd)
            if not stat.S_ISREG(s.st_mode): raise ValueError('Not a regular file')
            out, name = tempfile.mkstemp(prefix='dispatch-reader-')
            with os.fdopen(out, 'wb') as target, os.fdopen(fd, 'rb', closefd=False) as source: shutil.copyfileobj(source, target)
        finally: os.close(fd)
        result = info(p); result['size'] = s.st_size
        return {'handle': name, 'info': result}
    if op in ('reader-read', 'reader-close'):
        if not isinstance(p, str) or not p.startswith('/tmp/dispatch-reader-') or '/' in p[5:]: raise ValueError('Invalid reader')
        if op == 'reader-close': Path(p).unlink(missing_ok=True); return None
        with open(p, 'rb') as f: f.seek(q['offset']); return {'content': base64.b64encode(f.read(q['length'])).decode()}
    if op == 'shell':
        job = q['job']
        if not job.isalnum(): raise ValueError('Invalid command identity')
        directory = Path('/tmp/dispatch-workspace-jobs'); directory.mkdir(exist_ok=True, mode=0o700)
        marker = directory / job
        args = q['command']; args = ['/bin/bash', '--noprofile', '--norc', '-c', args] if isinstance(args, str) else args
        env = dict(os.environ) if q.get('inheritEnv', True) else {'PATH': '/usr/local/bin:/usr/bin:/bin'}
        env.update(HOME='/home/cua', USER='cua', LOGNAME='cua')
        env.update(q.get('env', {}))
        child = subprocess.Popen(args, cwd=q.get('cwd', '/workspace'), env=env, start_new_session=True,
                                 stdout=subprocess.PIPE if q.get('stream') else None,
                                 stderr=subprocess.PIPE if q.get('stream') else None)
        marker.write_text(json.dumps({'pid': child.pid, 'start': Path(f'/proc/{child.pid}/stat').read_text().split()[21]}))
        try:
            if not q.get('stream'): return child.wait()
            selector = selectors.DefaultSelector()
            decoders = {key: codecs.getincrementaldecoder('utf-8')('replace') for key in ('stdout', 'stderr')}
            for key in decoders: selector.register(getattr(child, key), selectors.EVENT_READ, key)
            spill = None; buffered = []; count = 0; lines = 0; thresholds = q.get('spill')
            while selector.get_map():
                for event, _ in selector.select():
                    chunk = os.read(event.fd, 65536); key = event.data
                    text = decoders[key].decode(chunk, final=not chunk)
                    if not chunk: selector.unregister(event.fileobj)
                    if chunk and thresholds:
                        count += len(chunk); lines += chunk.count(b'\n')
                        if not spill and (count > thresholds['afterBytes'] or lines + 1 > thresholds['afterLines']):
                            spill = tempfile.NamedTemporaryFile(prefix='dispatch-output-', delete=False)
                            for previous in buffered: spill.write(previous)
                            buffered.clear()
                        if spill: spill.write(chunk)
                        else: buffered.append(chunk)
                    if text: print(json.dumps({'output': text, 'stream': key}), flush=True)
            result = {'exitCode': child.wait()}
            if spill: spill.close(); result['spillPath'] = spill.name
            print(json.dumps({'result': result}), flush=True)
            return 0
        finally: marker.unlink(missing_ok=True)
    if op == 'cancel':
        job = q['job']
        if not job.isalnum(): raise ValueError('Invalid command identity')
        marker = Path('/tmp/dispatch-workspace-jobs') / job
        if marker.exists():
            data = json.loads(marker.read_text()); path = Path(f"/proc/{data['pid']}/stat")
            if path.exists() and path.read_text().split()[21] == data['start']:
                try: os.killpg(data['pid'], signal.SIGKILL)
                except ProcessLookupError: pass
            marker.unlink(missing_ok=True)
        return None
    raise ValueError('Unknown filesystem operation')


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        result = main(request)
        if request['action'] == 'shell': sys.exit(result)
        print(json.dumps({'ok': True, 'value': result}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': {'type': type(error).__name__, 'message': str(error), 'errno': getattr(error, 'errno', None)}}))
        sys.exit(1)
