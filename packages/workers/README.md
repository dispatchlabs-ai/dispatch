# Workers

Outbound-connected native Runner owners for the [central Backend](../backend/README.md).
The service owns PostgreSQL; the worker owns model/tool execution using the public
RemoteStorage interface. Pi owns scheduling, tasks, retries and recovery. No new
agent loop, global principal queue, launcher or Fleet coordinator.

```sh
DISPATCH_WORKER_CONFIG=/srv/example/worker.json node packages/workers/dist/main.js
```

`WorkerConfig` / `startWorker(config)` are exported for other trusted native hosts.
Configuration: `service` HTTPS origin, `run`, private `tokenFile`, `definitionsRoot`,
persistent `stateRoot`, authorized authored `names` and `host` (`cwd`, gateway and/or
trusted provider modules, optional service policy). A whole native messaging closure
belongs in one run. A run is not a principal; concurrent conversations share native
harness state and independent runs have no app concurrency cap. Production host
workspace/artifacts must persist outside disposable containers. Run only one owner
for a work scope. Fixed-worker supervision belongs to the consumer; for replaceable
EC2 execution use existing [Fleet](../fleet/README.md) and its fencing contracts.

Only explicit create/send/stop opens an owner. Observation/reconnect does not.
Saved definitions and host bindings must match; no implicit migration. Under native
ownership, send/stop reject unrelated paused work before enabling scheduling. Stop
cancels selected owned work, not independently admitted recipient conversations.
Native request IDs survive uncertain delivery; retry commands deliberately, never
on transport reconnect. Unknown owners/uncertain reservations are not replaced.

See the [small composition example](../../examples/chat/README.md) for an actual
local PostgreSQL/service/worker setup using a synthetic provider. This qualifies
native integration, not external inference, real tools, hosted identity or EC2.

For planned shutdown, stop and confirm each worker exited **before** stopping its
central storage service. Otherwise native close may remain unable to reach its
remote storage; that live process/lock is not a replacement invitation. Wait for
or deliberately terminate only the confirmed old executor, reconcile effects and
retained receipts, then recover. Never remove an active local owner lock.
