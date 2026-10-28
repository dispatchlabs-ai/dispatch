import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { StorageWrite } from "@earendil-works/pi-durable";

// An explicitly synthetic walkthrough, saved through stock Pi's storage API.
// It never contacts a provider or starts an agent. No existing file is replaced.
const target = resolve(process.argv[2] || ".local/sample.sqlite");
if (
  await access(target).then(
    () => true,
    () => false,
  )
)
  throw new Error("The sample destination already exists. Choose a new path.");
await mkdir(dirname(target), { recursive: true });
const storage = await openNodeSqliteStorage(target);
const context = BACKGROUND_CONTEXT;
const started = Date.now() - 125_000;
const write = (writes: unknown[]) =>
  storage.commit(writes as StorageWrite[], context);
const mint = () => storage.mintId();
const root = await mint(),
  workflow = await mint(),
  research = await mint(),
  review = await mint(),
  readTask = await mint(),
  retryTask = await mint(),
  doc = await mint(),
  liveDoc = await mint();
const task = (
  id: number,
  conversationId: number,
  kind: string,
  state: object,
  extra = {},
) => ({
  type: "task",
  value: {
    id,
    conversationId,
    kind,
    version: 1,
    input: { assignment: "Review the example change" },
    background: false,
    abortRequested: false,
    startedAt: started,
    state,
    ...extra,
  },
});
try {
  await write([
    { type: "conversation", value: { id: root } },
    {
      type: "conversation",
      value: {
        id: research,
        owner: { conversationId: root, taskId: workflow },
      },
    },
    {
      type: "conversation",
      value: { id: review, owner: { conversationId: root, taskId: workflow } },
    },
    task(workflow, root, "sample.review-workflow", {
      status: "waiting",
      checkpoint: { phase: "research", attempt: 2 },
      on: [readTask],
      policy: "all",
    }),
    task(
      readTask,
      research,
      "pi.tool",
      {
        status: "running",
        checkpoint: {
          phase: "execute",
          call: {
            id: "read-source",
            name: "read_file",
            arguments: { path: "src/worker.ts" },
          },
        },
      },
      { owner: workflow },
    ),
    task(
      retryTask,
      review,
      "sample.research-attempt",
      {
        status: "terminal",
        outcome: {
          status: "failed",
          error: { message: "The sample source was temporarily unavailable." },
        },
      },
      { owner: workflow, endedAt: started + 30_000 },
    ),
    {
      type: "document.create",
      record: { id: doc, kind: "observer.sample", scope: { kind: "session" } },
      content: {
        version: 1,
        kind: "base",
        value: {
          synthetic: true,
          byId: {
            coordinator: { conversationId: root, title: "Coordinator" },
            research: { conversationId: research, title: "Researcher" },
            review: { conversationId: review, title: "Reviewer" },
          },
          workflow: {
            stage: "research",
            attempt: 2,
            note: "Synthetic saved records for exploring Observer. No agent is executing.",
          },
        },
      },
    },
    {
      type: "document.create",
      record: {
        id: liveDoc,
        kind: "pi.live",
        scope: { kind: "conversation", conversationId: research },
        history: "latest",
        fork: "initial",
      },
      content: {
        version: 1,
        kind: "base",
        value: {
          run: { taskId: readTask, inputs: [] },
          tools: [
            {
              callId: "read-source",
              name: "read_file",
              status: "running",
              taskId: readTask,
              output: "Reading src/worker.ts…",
            },
          ],
        },
      },
    },
  ]);
  const entry = async (
    conversationId: number,
    kind: string,
    model: object[],
    byTaskId?: number,
    data?: object,
  ) =>
    write([
      {
        type: "entry",
        value: {
          id: await mint(),
          conversationId,
          kind,
          model,
          ...(byTaskId ? { byTaskId } : {}),
          ...(data ? { data } : {}),
        },
      },
    ]);
  const assistant = (content: object[], timestamp: number) => ({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "sample",
    model: "synthetic",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  });
  await entry(root, "pi.user", [
    { role: "user", content: "Review the example change", timestamp: started },
  ]);
  await entry(
    root,
    "pi.assistant",
    [
      assistant(
        [
          {
            type: "text",
            text: "I’ll gather the source, ask the researcher to trace the connection path, and review the findings.",
          },
          {
            type: "toolCall",
            id: "gather",
            name: "gather_context",
            arguments: { files: ["src/worker.ts", "src/connection.ts"] },
          },
        ],
        started + 1000,
      ),
    ],
    workflow,
  );
  await entry(
    root,
    "pi.tool-result",
    [
      {
        role: "toolResult",
        toolCallId: "gather",
        toolName: "gather_context",
        content: [
          {
            type: "text",
            text: "Collected two source files and the current configuration.",
          },
        ],
        details: { files: 2 },
        durationMs: 820,
        isError: false,
        timestamp: started + 2000,
      },
    ],
    workflow,
  );
  await entry(review, "pi.user", [
    {
      role: "user",
      content:
        "Check the connection handling and report any missing error paths.",
      timestamp: started + 3000,
    },
  ]);
  await entry(
    review,
    "pi.assistant",
    [
      assistant(
        [
          {
            type: "toolCall",
            id: "lookup",
            name: "fetch_reference",
            arguments: { url: "https://example.com/reference" },
          },
        ],
        started + 4000,
      ),
    ],
    retryTask,
  );
  await entry(
    review,
    "pi.tool-result",
    [
      {
        role: "toolResult",
        toolCallId: "lookup",
        toolName: "fetch_reference",
        content: [
          {
            type: "text",
            text: "Reference unavailable. The workflow recorded this failed attempt and continued with local source.",
          },
        ],
        durationMs: 1200,
        isError: true,
        timestamp: started + 5200,
      },
    ],
    retryTask,
  );
  await entry(root, "sample.workflow-note", [], workflow, {
    phase: "research",
    attempt: 2,
    message: "Retry using local source only.",
    timestamp: started + 6000,
  });
  await entry(research, "pi.user", [
    {
      role: "user",
      content:
        "Find the cause of the connection error. Inspect the worker’s reconnect path.",
      timestamp: started + 7000,
    },
  ]);
  await entry(
    research,
    "pi.assistant",
    [
      assistant(
        [
          {
            type: "text",
            text: "The worker retains its session when the transport disconnects. I’m checking how a new connection restores the pending request.",
          },
          {
            type: "toolCall",
            id: "read-source",
            name: "read_file",
            arguments: { path: "src/worker.ts" },
          },
        ],
        started + 8000,
      ),
    ],
    readTask,
  );
  console.log(
    `Created synthetic sample: ${target}\nOpen it with Settings → Add connection → SQLite. Saved running states are sample data, not live processes.`,
  );
} finally {
  await storage.close(context);
}
