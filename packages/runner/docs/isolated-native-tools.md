# Host-isolated native tools

`nativeToolProxies(invoke, names?)` exposes stock Pi tool schemas; the trusted
host forwards stable native request IDs to `openNativeTools(state, workspace)`.
The worker owns a private locked SQLite store and a native nested `ToolTask`.
Safe retries reuse that task; unsafe interrupted effects retain Pi's unknown
outcome rather than being replayed. No second model runs.

`dispatch-native-tools --state PATH --workspace PATH --socket PATH` serves
`POST /commands` over an owner-only Unix socket:

- `{tool:"coding", arguments:{name,arguments}, requestId}` — execute/recover.
- `{tool:"status"}` — inspect pending native tasks.
- `{tool:"stop"}` — abort native tasks before recovery.

`--cancel-pending` performs cancellation before opening the socket.
SIGTERM suspends; the host must kill the worker's entire cgroup/process tree and
retain a cancellation marker when cooperative Stop cannot finish.

**This API does not create isolation.** The host must separate Unix identities,
filesystems, credentials and process visibility; authenticate the calling primary;
own descendant lifetime; prevent metadata/credential access; and transfer only
files from that primary's workspace. A scrubbed environment or different cwd is
not a boundary. Do not expose this socket to untrusted code or a network.

`ChatService.open({prepareAgent})` binds loaded definitions before stores open.
Use it to replace direct coding tools with proxies, including `coding:true`,
while preserving model/skill/message policy. Hosts still own state migrations.

`requireKnowledge({namespace,instruction,allowedTools})` supplies native hooks
and evidence recording. Record only successful authenticated search/read results.
The current run's inputs require a search and a returned article read (or a
genuine zero-match search); steering invalidates earlier evidence. An actual
outage permits a blocker answer but never effectful tools. Argument errors are
not outages. Gate streamed text separately through `allowProgress`.
