import { access, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { WorkflowDocument } from "../src/shared/workflowDocument";

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
      value: {
        id: review,
        owner: { conversationId: root, taskId: workflow },
      },
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
          error: {
            message: "The sample source was temporarily unavailable.",
          },
        },
      },
      { owner: workflow, endedAt: started + 30_000 },
    ),
    {
      type: "document.create",
      record: {
        id: doc,
        kind: "observer.sample",
        scope: { kind: "session" },
      },
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
  ) => {
    const id = await mint();
    await write([
      {
        type: "entry",
        value: {
          id,
          conversationId,
          kind,
          model,
          ...(byTaskId ? { byTaskId } : {}),
          ...(data ? { data } : {}),
        },
      },
    ]);
    return id;
  };
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
    {
      role: "user",
      content: "Review the example change",
      timestamp: started,
    },
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
  const requestEntry = await entry(review, "pi.user", [
    {
      role: "user",
      content:
        "Check the connection handling and report any missing error paths.",
      timestamp: started + 3000,
    },
  ]);
  const callEntry = await entry(
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
  const resultEntry = await entry(
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
  const journeyDoc = await mint(),
    remediationDoc = await mint();
  const evidence = (entryId: number, label: string) => [
    { conversationId: review, entryId, label },
    { conversationId: review, label: "Full reviewer conversation" },
  ];
  const journey: WorkflowDocument = {
    version: 1,
    id: "sample-journey",
    title: "Workflow walkthrough",
    cycle: "Example cycle",
    status: "Partial evidence",
    nodes: [
      {
        id: "round",
        type: "group",
        title: "Round 1",
        kind: "Development round",
        order: 1,
        evidence: [],
      },
      {
        id: "plan",
        type: "activity",
        parent: "round",
        title: "Review request",
        kind: "Assignment",
        at: started + 3000,
        evidence: evidence(requestEntry, "Original review request"),
      },
      {
        id: "checks",
        type: "group",
        title: "Parallel checks",
        kind: "Security branches",
        order: 2,
        summary:
          "These branches converge at the review. Ordering alone does not imply a dependency.",
        evidence: [],
      },
      {
        id: "source",
        type: "activity",
        parent: "checks",
        title: "Source inspection",
        kind: "Branch",
        at: started + 8000,
        evidence: [
          { conversationId: research },
          {
            conversationId: research,
            taskId: readTask,
            label: "Retained task",
          },
        ],
      },
      {
        id: "case",
        type: "group",
        parent: "checks",
        title: "Connection case",
        kind: "QA case",
        evidence: [],
      },
      {
        id: "attempt1",
        type: "activity",
        parent: "case",
        title: "Attempt 1 · remote reference",
        kind: "Attempt",
        status: "Failed",
        at: started + 5200,
        evidence: evidence(resultEntry, "Failed tool result"),
      },
      {
        id: "attempt2",
        type: "group",
        parent: "case",
        title: "Attempt 2 · local recovery",
        kind: "Attempt",
        evidence: [],
      },
      {
        id: "turn",
        type: "activity",
        parent: "attempt2",
        title: "Inspect call arguments",
        kind: "Turn",
        at: started + 6000,
        evidence: evidence(callEntry, "Original tool call"),
      },
      {
        id: "scope1",
        type: "activity",
        title: "Initial scope",
        kind: "Scope revision",
        order: 3,
        attributes: { Scope: "Connection handling", Revision: "1" },
        evidence: evidence(requestEntry, "Scope request"),
      },
      {
        id: "scope2",
        type: "activity",
        title: "Expanded scope",
        kind: "Scope revision",
        order: 4,
        attributes: { Scope: "Connection and recovery", Revision: "2" },
        evidence: evidence(resultEntry, "Saved recovery evidence"),
      },
      {
        id: "steering",
        type: "group",
        title: "Steering and maintenance",
        kind: "Review",
        order: 5,
        evidence: [],
      },
      {
        id: "pass",
        type: "activity",
        parent: "steering",
        title: "Maintenance pass 1",
        kind: "Pass",
        at: started + 9000,
        evidence: [
          {
            conversationId: root,
            documentId: doc,
            label: "Retained workflow notes",
          },
        ],
      },
      {
        id: "remediation",
        type: "group",
        title: "Linked remediation",
        kind: "Related workflow",
        order: 6,
        workflow: { documentId: remediationDoc },
        evidence: [],
      },
    ],
    edges: [
      { from: "source", to: "pass", kind: "feeds review" },
      { from: "attempt2", to: "pass", kind: "feeds review" },
      { from: "attempt1", to: "attempt2", kind: "retry" },
      { from: "scope1", to: "scope2", kind: "superseded by" },
    ],
  };
  const document = (id: number, key: string, value: unknown) => ({
    type: "document.create",
    record: {
      id,
      kind: "observer.workflow",
      key,
      scope: { kind: "session" },
    },
    content: { version: 1, kind: "base", value },
  });
  await write([
    document(journeyDoc, "journey", journey),
    document(remediationDoc, "remediation", {
      version: 1,
      id: "sample-remediation",
      title: "Linked remediation",
      cycle: "Example follow-up",
      nodes: [
        {
          id: "fix",
          type: "activity",
          title: "Local recovery",
          kind: "Remediation",
          at: started + 10_000,
          evidence: [{ conversationId: research }],
          workflow: { documentId: journeyDoc },
        },
      ],
    }),
    document(await mint(), "partial", {
      version: 1,
      id: "sample-partial",
      title: "Incomplete evidence walkthrough",
      nodes: [
        {
          id: "a",
          parent: "b",
          type: "group",
          title: "Circular containment A",
        },
        {
          id: "b",
          parent: "a",
          type: "group",
          title: "Circular containment B",
        },
        {
          id: "missing",
          type: "activity",
          title: "Missing conversation",
          evidence: [{ conversationId: 999999 }],
        },
        {
          id: "missing-entry",
          type: "activity",
          title: "Missing saved entry",
          evidence: [{ conversationId: review, entryId: 999998 }],
        },
        {
          id: "link",
          type: "group",
          title: "Missing linked workflow",
          workflow: { documentId: 999997 },
        },
      ],
      edges: [{ from: "a", to: "absent", kind: "unresolved relationship" }],
    }),
    document(await mint(), "future-version", {
      version: 2,
      id: "future",
      title: "Unsupported version",
      nodes: [],
    }),
    {
      type: "document.create",
      record: {
        id: await mint(),
        kind: "sample.chats",
        scope: { kind: "session" },
      },
      content: {
        version: 1,
        kind: "base",
        value: {
          byId: Object.fromEntries(
            [
              [root, "coordinator"],
              [research, "researcher"],
              [review, "reviewer"],
            ].map(([conversationId, agent]) => [
              `${agent}:${conversationId}`,
              {
                id: `${agent}:${conversationId}`,
                conversationId,
                agent,
                source: "sample",
                title: `Example ${agent}`,
                createdAt: new Date(started).toISOString(),
              },
            ]),
          ),
        },
      },
    },
  ]);
  for (const cycle of ["Earlier cycle", "Later cycle"]) {
    const text = `workflow: handoff-walkthrough\ncycle: ${cycle}\nassignment: Reused reviewer\nphase: review\n\nSynthetic handoff in the same retained conversation.`;
    await entry(
      review,
      "sample.instance-message",
      [
        {
          role: "user",
          content: text,
          timestamp: started + (cycle === "Earlier cycle" ? 11_000 : 12_000),
        },
      ],
      undefined,
      {
        id: `sample-${cycle}`,
        from: `coordinator:${root}`,
        to: `reviewer:${review}`,
        status: "received",
        reply: true,
        text,
      },
    );
  }
  console.log(
    `Created synthetic sample: ${target}\nOpen it with Settings → Add connection → SQLite. Saved running states are sample data, not live processes.`,
  );
} finally {
  await storage.close(context);
}
