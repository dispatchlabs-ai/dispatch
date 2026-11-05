"""Placement of admitted Dispatch runs on replaceable EC2 workers.

Admission and native state remain on the coordinator. Workers receive only
run-bound commands; a confirmed stop or EC2 termination precedes reassignment.
"""
import concurrent.futures
from contextlib import contextmanager
import hmac
import http.client
import http.server
import json
from pathlib import Path
import re
import socket
import threading
import time
import uuid

from common import cleanup_relay

ROOT = Path('/var/lib/dispatch-fleet')


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=None):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class Controller:
    def __init__(self, config, broker):
        import boto3
        self.config, self.broker = config, broker
        self.asg = boto3.client('autoscaling', region_name=config['region'])
        self.ec2 = boto3.client('ec2', region_name=config['region'])
        self.metrics = boto3.client('cloudwatch', region_name=config['region'])
        secret = boto3.client('secretsmanager', region_name=config['region']).get_secret_value(SecretId=config['secretArn'])
        self.token = json.loads(secret['SecretString'])['token']
        if not isinstance(self.token, str) or len(self.token) < 32:
            raise ValueError('Missing fleet authentication secret')
        self.condition = threading.Condition(threading.RLock())
        self.workers, self.commands, self.members = {}, {}, {}
        self.member_seen = {}
        self.refresh_at = 0
        self.idle_since = None
        self.retiring = set()
        self.stopping = {}
        self.migration = None
        self.rebalance_samples = {}
        self.rebalance_after = 0
        self.placement_preferences = {}
        self.recovering = set()
        self.quiescing = False
        self.started_at = time.monotonic()
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)

    def start(self):
        self.refresh_members()
        controller = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self): self.handle_request()
            def do_POST(self): self.handle_request()

            def handle_request(self):
                started = False
                try:
                    if self.command == 'GET' and self.path == '/health':
                        return self.answer({'ready': True})
                    worker = self.headers.get('X-Worker-Id', '')
                    controller.authenticate(worker, self.headers.get('Authorization', ''))
                    if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) > 1:
                        raise ValueError('Use a single Content-Length frame')
                    size = int(self.headers.get('Content-Length', '0'))
                    if size < 0 or self.command == 'GET' and size:
                        raise ValueError('Invalid request frame')
                    body = self.rfile.read(size)
                    if len(body) != size: raise ValueError('Incomplete request')
                    match = re.fullmatch(r'/fleet/runs/([a-f0-9]{64})/relay(/.*)', self.path)
                    if match:
                        run, path = match.groups()
                        epoch = int(self.headers.get('X-Run-Epoch', '0'))
                        controller.authorized_run(worker, run, epoch, cleanup=cleanup_relay(self.command, path))
                        if path.startswith('/storage/'):
                            role = path.removeprefix('/storage/')
                            if self.command != 'POST' or not re.fullmatch(r'[a-z][a-z0-9_-]*', role):
                                raise ValueError('Invalid native store')
                            request = json.loads(body)
                            request['epoch'] = epoch
                            body = json.dumps(request).encode()
                            connection = UnixConnection('/run/dispatch-fleet/storage.sock')
                            target = '/storage/' + run + '/' + role
                        else:
                            if not (path.startswith('/v1/') or path.startswith('/company/') or path == '/events'):
                                raise ValueError('Unknown run relay')
                            connection = UnixConnection(controller.config['relaySocket'])
                            target = path
                        try:
                            connection.request(self.command, target, body or None,
                                {'Content-Type': 'application/json', 'Content-Length': str(len(body)),
                                 'X-Dispatch-Run': run, 'X-Dispatch-Epoch': str(epoch)})
                            response = connection.getresponse()
                            self.send_response(response.status)
                            self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
                            self.end_headers(); started = True
                            while True:
                                part = response.read1(65536)
                                if not part: break
                                self.wfile.write(part); self.wfile.flush()
                        finally: connection.close()
                        return
                    if self.command != 'POST': raise ValueError('Unknown fleet operation')
                    data = json.loads(body)
                    if self.path == '/fleet/heartbeat':
                        result = controller.heartbeat(worker, data)
                    elif self.path == '/fleet/poll':
                        result = controller.poll(worker)
                    elif self.path == '/fleet/result':
                        result = controller.result(worker, data)
                    else: raise ValueError('Unknown fleet operation')
                    self.answer(result)
                except (BrokenPipeError, ConnectionResetError): pass
                except Exception as error:
                    if not started:
                        self.answer({'ok': False, 'error': str(error) if isinstance(error, ValueError)
                                     else 'Fleet request failed; retained state was not reset'}, 409)

            def answer(self, data, status=200):
                payload = json.dumps(data).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers(); self.wfile.write(payload)

        server = http.server.ThreadingHTTPServer(('0.0.0.0', self.config.get('port', 8788)), Handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        threading.Thread(target=self.monitor, daemon=True).start()

    def refresh_members(self):
        groups = self.asg.describe_auto_scaling_groups(AutoScalingGroupNames=[self.config['asgName']])['AutoScalingGroups']
        if len(groups) != 1: raise ValueError('The configured Dispatch worker group is unavailable')
        self.group = groups[0]
        with self.condition:
            self.members = {row['InstanceId']: row for row in self.group['Instances']}
            for worker in self.members: self.member_seen.setdefault(worker, time.monotonic())
            self.refresh_at = time.monotonic()

    def authenticate(self, worker, authorization):
        if not re.fullmatch(r'i-[a-f0-9]{17}', worker) or not hmac.compare_digest(authorization, 'Bearer ' + self.token):
            raise ValueError('Fleet authentication failed')
        if worker not in self.members or time.monotonic() - self.refresh_at > 30:
            self.refresh_members()
        if worker not in self.members: raise ValueError('Instance is not a member of this worker group')

    def heartbeat(self, worker, data):
        if data.get('workerId') != worker or not isinstance(data.get('bootId'), str):
            raise ValueError('Worker identity mismatch')
        for name in ('cpuPercent', 'memoryPercent'):
            if not isinstance(data.get(name), (int, float)) or not 0 <= data[name] <= 100:
                raise ValueError('Invalid worker pressure measurement')
        with self.condition:
            old = self.workers.get(worker, {})
            draining = bool(old.get('draining') or data.get('draining') or
                            self.members[worker]['LifecycleState'].startswith('Terminating'))
            self.workers[worker] = {**data, 'seen': time.monotonic(), 'draining': draining}
            self.condition.notify_all()
        return {'ok': True, 'draining': draining}

    def poll(self, worker):
        until = time.monotonic() + 25
        with self.condition:
            while True:
                rows = []
                for command in self.commands.values():
                    if command['workerId'] != worker or command['future'].done(): continue
                    if command.get('sentAt', 0) + 30 > time.monotonic(): continue
                    command['sentAt'] = time.monotonic()
                    rows.append({k: command[k] for k in ('id', 'run', 'epoch', 'operation', 'args')})
                if rows or time.monotonic() >= until: return {'commands': rows}
                self.condition.wait(until - time.monotonic())

    def result(self, worker, data):
        with self.condition:
            command = self.commands.get(data.get('id'))
            if command is None: return {'ok': True, 'forgotten': True}
            if (command['workerId'], command['run'], command['epoch']) != (worker, data.get('run'), data.get('epoch')):
                raise ValueError('Command result belongs to another owner')
            if not command['future'].done():
                if data.get('ok'): command['future'].set_result(data.get('result'))
                else: command['future'].set_exception(ValueError(data.get('error', 'Worker operation failed')))
            self.condition.notify_all()
        return {'ok': True}

    def command(self, placement, run, operation, args=None, timeout=None):
        if self.broker.assignment(run).get('fleet') != placement:
            raise ValueError('The command belongs to a previous worker generation')
        request_id = str(uuid.uuid4())
        future = concurrent.futures.Future()
        command = {'id': request_id, 'workerId': placement['workerId'], 'run': run,
                   'epoch': placement['epoch'], 'operation': operation, 'args': args or {}, 'future': future}
        with self.condition:
            self.commands[request_id] = command
            self.condition.notify_all()
        begin = time.monotonic()
        try:
            while True:
                try: return future.result(timeout=5)
                except concurrent.futures.TimeoutError:
                    row = self.workers.get(placement['workerId'])
                    if not row or time.monotonic() - row['seen'] > 120:
                        raise ValueError('Worker contact was lost; the run is retained for fenced recovery')
                    if timeout and time.monotonic() - begin > timeout:
                        raise ValueError('Worker observation timed out; its native work remains admitted')
        finally:
            with self.condition:
                self.commands.pop(request_id, None)
                self.condition.notify_all()

    def authorized_run(self, worker, run, epoch, cleanup=False):
        d = self.broker.metadata(run)
        placement = d.get('fleet') or {}
        if placement.get('workerId') != worker or placement.get('epoch') != epoch:
            raise ValueError('Run ownership changed')
        stopping = cleanup and self.stopping.get(run) == placement
        if self.quiescing and not stopping: raise ValueError('The coordinator is suspending remote writers')
        owner = self.broker.owners.get(run)
        cancelling = cleanup and d.get('cancelPending')
        if not stopping and ((d.get('cancelled') or d.get('suspended')) and not cancelling or owner and owner['ended'].is_set()):
            raise ValueError('The admitted run has stopped')
        return d

    def assignments(self):
        for path in (self.broker.ROOT / 'assignments').glob('*.json'):
            yield self.broker.assignment(path.stem)

    def place(self, d, owner=None, cleanup=False):
        if self.quiescing: raise ValueError('The coordinator is suspending remote writers')
        if d.get('fleet'):
            worker = d['fleet']['workerId']
            row = self.workers.get(worker)
            if row and time.monotonic() - row['seen'] <= 120:
                return d['fleet']
            # Never assume a lease timeout stopped a process or a shell command.
            raise ValueError('The previous worker must be fenced before this run can move')
        d['fleetPending'] = True; self.broker.save_assignment(d)
        with self.condition:
            while True:
                if self.quiescing: raise ValueError('The coordinator is suspending remote writers')
                if not cleanup and self.broker.assignment(d['run']).get('suspended'):
                    raise ValueError('Run stopped while waiting for worker capacity')
                if owner and owner['ended'].is_set():
                    raise ValueError('The owning Slack process stopped while awaiting worker capacity')
                candidates = [(name, row) for name, row in self.workers.items()
                              if time.monotonic() - row['seen'] < 60 and not row.get('draining')
                              and name not in self.retiring
                              and self.members.get(name, {}).get('LifecycleState') == 'InService'
                              and max(row['cpuPercent'], row['memoryPercent']) < 90]
                preference = self.placement_preferences.get(d['run'])
                if preference:
                    candidates = [(name, row) for name, row in candidates if name != preference['source']]
                if candidates:
                    counts = {}
                    for item in self.assignments():
                        name = (item.get('fleet') or {}).get('workerId')
                        if name and not item.get('suspended'): counts[name] = counts.get(name, 0) + 1
                    worker, _ = min(candidates, key=lambda pair:
                                    (0 if preference and pair[0] == preference['target'] else 1,
                                     max(pair[1]['cpuPercent'], pair[1]['memoryPercent']) + counts.get(pair[0], 0), pair[0]))
                    d['fleetEpoch'] = int(d.get('fleetEpoch', 0)) + 1
                    d['fleet'] = {'workerId': worker, 'epoch': d['fleetEpoch']}
                    d['fleetPending'] = False; self.broker.save_assignment(d)
                    return d['fleet']
                self.condition.wait(5)

    def prepare_space(self, d, owner=None):
        placement = self.place(d, owner)
        result = self.command(placement, d['run'], 'space.ensure', {'assignment': d})
        record_path = self.broker.spaces.path(d['run'])
        saved = json.loads(record_path.read_text()) if record_path.exists() else {}
        # Publication/recovery receipts belong to the coordinator, not a worker's
        # local container projection. Never replace them with an older copy.
        record = {**result['record'], **{key: saved[key] for key in
                  ('publications', 'artifacts', 'recovery', 'pendingRecoveryDeletes', 'remoteBaselines') if key in saved},
                  'fleet': placement}
        self.broker.spaces.save(record_path, record)
        return result['binding']

    def ensure(self, d):
        if self.quiescing: raise ValueError('The coordinator is suspending remote writers')
        return self.command(d['fleet'], d['run'], 'start', {'assignment': d})

    def request(self, run, command, timeout=None, observation=False):
        d = self.broker.metadata(run)
        begin = time.monotonic()
        try:
            return self.command(d['fleet'], run, 'request', {'command': command, 'timeout': timeout, 'observation': observation}, timeout=timeout)
        except Exception:
            # A long poll must not prevent balancing a background native
            # run. Only observations follow the handoff; effects are never retried.
            if not observation and command.get('tool') != 'status': raise
            with self.condition:
                while self.migration and self.migration['run'] == run:
                    if self.quiescing or timeout and time.monotonic() - begin >= timeout: raise
                    self.condition.wait(1)
            latest = self.broker.metadata(run)
            if (self.quiescing or not latest.get('fleet') or latest['fleet'] == d['fleet'] or
                    latest.get('suspended') or latest.get('cancelled') or latest.get('finished')): raise
            remaining = None if timeout is None else timeout - (time.monotonic() - begin)
            if remaining is not None and remaining <= 0: raise
            return self.command(latest['fleet'], run, 'request', {'command': command, 'timeout': remaining, 'observation': observation}, timeout=remaining)

    def primitive(self, record, operation, args=None):
        # Metadata may be suspended during operator Stop; teardown still needs
        # the old owner's exact identity. New work uses authorized_run instead.
        d = self.broker.assignment(record['run'])
        if d.get('fleet') != record['fleet']:
            raise ValueError('Space belongs to a previous worker generation')
        return self.command(record['fleet'], record['run'], 'space.' + operation, args)

    def suspend(self, d, timeout=None):
        self.stopping[d['run']] = d['fleet']
        try: return self.command(d['fleet'], d['run'], 'suspend', timeout=timeout)
        finally: self.stopping.pop(d['run'], None)

    def instance_state(self, worker):
        try:
            rows = self.ec2.describe_instances(InstanceIds=[worker])['Reservations']
        except Exception as error:
            if getattr(error, 'response', {}).get('Error', {}).get('Code') == 'InvalidInstanceID.NotFound':
                # Only previously admitted IDs reach fencing. EC2 eventually
                # forgets terminated instances; such an ID cannot be reused.
                return 'terminated'
            raise
        return rows[0]['Instances'][0]['State']['Name'] if rows else 'unknown'

    def fence(self, worker):
        state = self.instance_state(worker)
        if state == 'terminated': return
        self.refresh_members()
        if worker not in self.members:
            raise ValueError('The previous worker left the group without confirmed termination')
        if not self.members[worker]['LifecycleState'].startswith('Terminating'):
            self.asg.terminate_instance_in_auto_scaling_group(InstanceId=worker, ShouldDecrementDesiredCapacity=False)
        # A completed hook requests termination; it is not proof that old
        # shell processes can no longer write the shared workspace.
        while self.instance_state(worker) != 'terminated':
            self.refresh_members()
            if self.members.get(worker, {}).get('LifecycleState') == 'Terminating:Wait':
                self.complete_hook(worker)
            time.sleep(5)

    @contextmanager
    def ownership_lock(self, lock, worker=None, timeout=60):
        fenced = False
        if not lock.acquire(timeout=timeout):
            if worker is None: raise ValueError('An admitted operation is still stopping')
            # A shell may hold the broker lock while waiting on this worker.
            # Termination interrupts it; fence outside the lock it is holding.
            self.fence(worker)
            fenced = True
            lock.acquire()
        try: yield fenced
        finally: lock.release()

    def shutdown(self):
        # Placement writes hold this same condition, so the shutdown snapshot
        # cannot miss a new owner created across a graceful handoff's empty gap.
        with self.condition:
            self.quiescing = True
            self.condition.notify_all()
            assignments = [d for d in self.assignments() if d.get('fleet')]
        failures = []
        def stop(d):
            try:
                deadline = time.monotonic() + 90
                with self.broker.lock_guard: lock = self.broker.locks.setdefault(d['run'], threading.Lock())
                with self.ownership_lock(lock, timeout=max(1, deadline - time.monotonic())):
                    d = self.broker.assignment(d['run'])
                    if not d.get('fleet'): return
                    self.suspend(d, timeout=max(1, deadline - time.monotonic()))
                    self.command(d['fleet'], d['run'], 'space.delete', timeout=max(1, deadline - time.monotonic()))
                    record_path = self.broker.spaces.path(d['run'])
                    if record_path.exists():
                        record = json.loads(record_path.read_text())
                        if record.get('state') != 'deleted':
                            record['state'] = 'deleted'
                            self.broker.spaces.save(record_path, record)
                    d.pop('fleet', None)
                    self.broker.save_assignment(d)
            except Exception:
                failures.append(d['run'])
        # Every run is independent; do not serialize a host's graceful stops.
        threads = [threading.Thread(target=stop, args=(d,)) for d in assignments]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        # Closing the separately ordered native-storage service fences every
        # database writer even when a failed host needs later EC2 fencing.
        print(json.dumps({'fleetWritersStopped': len(assignments) - len(failures),
                          'fleetWritersAwaitingFence': len(failures)}), flush=True)

    def retire(self, worker, failed=False):
        try:
            with self.condition:
                self.retiring.add(worker)
                if worker in self.workers: self.workers[worker]['draining'] = True
            if failed: self.fence(worker)
            affected = [d['run'] for d in self.assignments() if (d.get('fleet') or {}).get('workerId') == worker]
            for run in affected:
                with self.broker.lock_guard: lock = self.broker.locks.setdefault(run, threading.Lock())
                with self.ownership_lock(lock, worker) as fenced:
                    failed = failed or fenced
                    d = self.broker.assignment(run)
                    if (d.get('fleet') or {}).get('workerId') != worker: continue
                    if not failed:
                        try:
                            self.suspend(d, timeout=60)
                            self.command(d['fleet'], run, 'space.delete', timeout=120)
                        except Exception:
                            self.fence(worker)
                            failed = True
                    record_path = self.broker.spaces.path(run)
                    if record_path.exists():
                        record = json.loads(record_path.read_text())
                        record['state'] = 'deleted'; record.pop('fleet', None)
                        self.broker.spaces.save(record_path, record)
                    d.pop('fleet', None); self.broker.save_assignment(d)
                # Recovery is asynchronous and retains the original native run.
                if not d.get('suspended') and not d.get('cancelled') and not d.get('finished'):
                    def resume(run=run):
                        try:
                            with self.broker.lock_guard: target_lock = self.broker.locks.setdefault(run, threading.Lock())
                            with target_lock:
                                latest = self.broker.metadata(run)
                                owner = self.broker.owners.get(run)
                                if not latest.get('suspended') and not latest.get('cancelled'):
                                    self.broker.ensure_worker(run, owner)
                        except Exception:
                            print(json.dumps({'fleetRecovery': run, 'state': 'pending'}), flush=True)
                    threading.Thread(target=resume, daemon=True).start()
            if not failed: self.complete_hook(worker)
            with self.condition: self.workers.pop(worker, None)
        except Exception as error:
            print(json.dumps({'fleetRetirement': worker, 'state': 'retained', 'error': type(error).__name__}), flush=True)
        finally:
            with self.condition: self.retiring.discard(worker)

    def complete_hook(self, worker):
        try:
            self.asg.complete_lifecycle_action(AutoScalingGroupName=self.config['asgName'],
                LifecycleHookName=self.config['lifecycleHook'],
                InstanceId=worker, LifecycleActionResult='CONTINUE')
        except Exception as error:
            if 'No active Lifecycle Action' not in str(error): raise

    def balance_ready(self, worker, now):
        row = self.workers.get(worker)
        return bool(row and now - row['seen'] < 30 and not row.get('draining') and worker not in self.retiring
                    and self.members.get(worker, {}).get('LifecycleState') == 'InService')

    def balance_observation_only(self, run):
        pending = [command for command in self.commands.values()
                   if command['run'] == run and command['operation'] == 'request' and not command['future'].done()]
        return (getattr(self.broker, 'active_calls', {}).get(run, 0) <= len(pending)
                and all(command['args'].get('observation') or command['args']['command'].get('tool') == 'status' for command in pending))

    def maybe_rebalance(self):
        """Use new capacity for admitted work, without imposing a jobs-per-host limit."""
        now = time.monotonic()
        with self.condition:
            ready = {worker: row for worker, row in self.workers.items() if self.balance_ready(worker, now)}
            for worker in list(self.rebalance_samples):
                if worker not in ready or max(ready[worker]['cpuPercent'], ready[worker]['memoryPercent']) <= 70:
                    self.rebalance_samples.pop(worker)
            for worker, row in ready.items():
                if max(row['cpuPercent'], row['memoryPercent']) <= 70: continue
                sample = self.rebalance_samples.setdefault(worker, {'since': now, 'seen': None, 'count': 0})
                if sample['seen'] != row['seen']:
                    sample['seen'] = row['seen']; sample['count'] += 1
            if self.quiescing or self.migration or self.retiring or now < self.rebalance_after: return False
            sustained = [worker for worker, sample in self.rebalance_samples.items()
                         if sample['count'] >= 3 and now - sample['since'] >= 30]
            spare = [worker for worker, row in ready.items() if max(row['cpuPercent'], row['memoryPercent']) < 50]
            if not sustained or not spare: return False
            active = {}
            for d in self.assignments():
                owner = self.broker.owners.get(d['run'])
                if (d.get('fleet') and not any(d.get(key) for key in ('suspended', 'cancelled', 'finished'))
                        and not (owner and owner['ended'].is_set())):
                    active.setdefault(d['fleet']['workerId'], []).append(d)
            hot = [worker for worker in sustained if len(active.get(worker, [])) > 1]
            for source in sorted(hot, key=lambda worker: (-len(active[worker]), worker)):
                for target in sorted(spare, key=lambda worker: (max(ready[worker]['cpuPercent'], ready[worker]['memoryPercent']), len(active.get(worker, [])), worker)):
                    if max(ready[source]['cpuPercent'], ready[source]['memoryPercent']) - max(ready[target]['cpuPercent'], ready[target]['memoryPercent']) < 30: continue
                    for d in sorted(active[source], key=lambda value: value['run']):
                        run = d['run']
                        if not self.balance_observation_only(run): continue
                        with self.broker.lock_guard: lock = self.broker.locks.setdefault(run, threading.Lock())
                        if not lock.acquire(blocking=False): continue
                        self.migration = {'run': run, 'source': source, 'target': target, 'placement': dict(d['fleet'])}
                        self.rebalance_after = now + 60
                        self.idle_since = None
                        threading.Thread(target=self.rebalance_run, args=(dict(self.migration), lock), daemon=True).start()
                        return True
        return False

    def recover_moved_run(self, run):
        try:
            while not self.quiescing:
                try:
                    with self.broker.lock_guard: lock = self.broker.locks.setdefault(run, threading.Lock())
                    with lock:
                        d = self.broker.metadata(run)
                        if any(d.get(key) for key in ('suspended', 'cancelled', 'finished')): return
                        self.broker.ensure_worker(run, self.broker.owners.get(run))
                        return
                except Exception:
                    with self.condition: self.condition.wait(5)
        finally:
            with self.condition: self.recovering.discard(run)

    def rebalance_run(self, move, lock):
        run, source, target = (move[key] for key in ('run', 'source', 'target'))
        released = False
        fence_source = False
        recover = False
        try:
            with self.condition:
                d = self.broker.metadata(run)
                if (self.quiescing or self.retiring or d.get('fleet') != move['placement']
                        or any(d.get(key) for key in ('suspended', 'cancelled', 'finished'))
                        or not self.balance_ready(source, time.monotonic()) or not self.balance_ready(target, time.monotonic())
                        or not self.balance_observation_only(run)):
                    return
            try:
                self.suspend(d, timeout=60)
                self.command(d['fleet'], run, 'space.delete', timeout=120)
                released = True
            except Exception:
                # The old owner may be partially released. Never restart that
                # generation or assign a second writer on an ambiguous ACK.
                fence_source = True
                raise
            record_path = self.broker.spaces.path(run)
            if record_path.exists():
                record = json.loads(record_path.read_text())
                record['state'] = 'deleted'; record.pop('fleet', None)
                self.broker.spaces.save(record_path, record)
            d.pop('fleet', None); d['fleetPending'] = True
            self.broker.save_assignment(d)
            with self.condition:
                if self.quiescing: return
                self.placement_preferences[run] = {'source': source, 'target': target}
            self.broker.ensure_worker(run, self.broker.owners.get(run))
            print(json.dumps({'fleetRebalance': run, 'state': 'moved', 'from': source,
                              'to': self.broker.assignment(run)['fleet']['workerId']}), flush=True)
        except Exception as error:
            recover = released and not self.quiescing
            if released:
                # A failed durable assignment write can leave the released old
                # generation recorded. Recovery must not try to restart it.
                try: fence_source = self.broker.assignment(run).get('fleet') == move['placement']
                except Exception: fence_source = True
                if fence_source: recover = False
            print(json.dumps({'fleetRebalance': run, 'state': 'pending' if released else 'retained',
                              'error': type(error).__name__}), flush=True)
        finally:
            with self.condition:
                self.placement_preferences.pop(run, None)
                self.migration = None
                self.rebalance_after = time.monotonic() + 60
                self.rebalance_samples.pop(source, None)
                if fence_source and not self.quiescing and source not in self.retiring:
                    self.retiring.add(source)
                    if source in self.workers: self.workers[source]['draining'] = True
                    threading.Thread(target=self.retire, args=(source, True), daemon=True).start()
                if recover and run not in self.recovering:
                    self.recovering.add(run)
                    threading.Thread(target=self.recover_moved_run, args=(run,), daemon=True).start()
                self.condition.notify_all()
            lock.release()

    def monitor(self):
        while not self.quiescing:
            try:
                self.refresh_members()
                live = [(name, row) for name, row in self.workers.items()
                        if time.monotonic() - row['seen'] < 120 and not row.get('draining')]
                pending = sum(bool(d.get('fleetPending')) and (not d.get('suspended') or d.get('fleetCleanup')) for d in self.assignments())
                pressure = max((sum(row[name] for _, row in live) / max(len(live), 1)
                                for name in ('cpuPercent', 'memoryPercent')), default=0)
                self.metrics.put_metric_data(Namespace=self.config.get('metricNamespace', 'Dispatch/AgentFleet'), MetricData=[
                    {'MetricName': 'CapacityPressure', 'Dimensions': [{'Name': 'AutoScalingGroupName', 'Value': self.config['asgName']}],
                     'Value': pressure, 'Unit': 'Percent'},
                    {'MetricName': 'PendingRunsPerInstance', 'Dimensions': [{'Name': 'AutoScalingGroupName', 'Value': self.config['asgName']}],
                     'Value': pending / max(len(live), 1), 'Unit': 'Count'}])
                owned = {(d.get('fleet') or {}).get('workerId') for d in self.assignments()}
                for worker in (set(self.members) | (owned - {None})):
                    membership = self.members.get(worker, {})
                    row = self.workers.get(worker)
                    retiring = membership.get('LifecycleState') == 'Terminating:Wait'
                    if row and row.get('draining') and membership.get('LifecycleState') == 'InService':
                        self.asg.terminate_instance_in_auto_scaling_group(InstanceId=worker, ShouldDecrementDesiredCapacity=False)
                        continue
                    failed = (time.monotonic() - (row['seen'] if row else self.started_at) > 120 and
                              (worker in owned or row is not None))
                    if (not row and membership.get('LifecycleState') == 'InService' and
                            time.monotonic() - self.member_seen[worker] > self.config.get('bootstrapTimeoutSeconds', 900)):
                        failed = True
                    if retiring:
                        self.asg.record_lifecycle_action_heartbeat(AutoScalingGroupName=self.config['asgName'],
                            LifecycleHookName=self.config['lifecycleHook'], InstanceId=worker)
                    if (retiring or failed) and worker not in self.retiring:
                        with self.condition:
                            self.retiring.add(worker)
                            if worker in self.workers: self.workers[worker]['draining'] = True
                        threading.Thread(target=self.retire, args=(worker, failed), daemon=True).start()
                self.maybe_rebalance()
                spare = (not pending and len(live) > self.group['MinSize'] and
                         sum(row['cpuPercent'] for _, row in live) / (len(live) - 1) < 50 and
                         sum(row['memoryPercent'] for _, row in live) / (len(live) - 1) < 50)
                if not spare: self.idle_since = None
                elif self.idle_since is None: self.idle_since = time.monotonic()
                elif time.monotonic() - self.idle_since >= 600 and not self.retiring and not self.migration:
                    worker, _ = min(live, key=lambda pair: pair[1]['cpuPercent'] + pair[1]['memoryPercent'])
                    self.workers[worker]['draining'] = True
                    self.asg.terminate_instance_in_auto_scaling_group(InstanceId=worker, ShouldDecrementDesiredCapacity=True)
                    self.idle_since = None
            except Exception as error:
                print(json.dumps({'fleetMonitor': 'retrying', 'error': type(error).__name__}), flush=True)
            # Heartbeats/request completion can expose a safe placement boundary
            # promptly; they must not multiply AWS describe/metric API frequency.
            next_poll = time.monotonic() + 15
            while not self.quiescing and time.monotonic() < next_poll:
                with self.condition: self.condition.wait(max(0, next_poll - time.monotonic()))
                try: self.maybe_rebalance()
                except Exception as error:
                    print(json.dumps({'fleetRebalance': 'retrying', 'error': type(error).__name__}), flush=True)
