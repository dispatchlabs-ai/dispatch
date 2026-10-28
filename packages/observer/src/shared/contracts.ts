import { z } from "zod";

const port = z.number().int().min(1).max(65535);
const path = z.string().trim().min(1).max(4096);
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (value) => !/[\s\x00-\x1f]/.test(value),
    "Enter a host name without whitespace",
  );
export const transportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("direct") }),
  z.object({
    kind: z.literal("ssh"),
    host,
    port: port.optional(),
    user: z.string().max(128).default(""),
    identityFile: z.string().max(4096).default(""),
    node: path.default("node"),
  }),
  z.object({
    kind: z.literal("ssm"),
    instance: z.string().regex(/^(i-[a-f0-9]+|mi-[a-f0-9]+)$/),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
    profile: z.string().max(128).default(""),
    node: path.default("node"),
  }),
]);
export const connectionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["sqlite", "postgres"]),
    transport: transportSchema,
    path: z.string().max(4096).default(""),
    postgres: z.object({
      host,
      port,
      database: z.string().min(1).max(128),
      user: z.string().min(1).max(128),
      storeId: z.string().max(200),
      tls: z.enum(["verify", "disable"]),
      caFile: z.string().max(4096).default(""),
    }),
  })
  .superRefine((value, context) => {
    if (value.kind === "sqlite" && !value.path.trim())
      context.addIssue({
        code: "custom",
        path: ["path"],
        message: "Choose an existing SQLite database",
      });
  });
export type Connection = z.infer<typeof connectionSchema>;
export type Transport = Connection["transport"];
export type SavedConnection = Connection & {
  hasSecret: boolean;
  secretSaved: boolean;
};
export type ConnectionDraft = {
  connection: Connection;
  password?: string;
  rememberSecret: boolean;
};
export const draftSchema = z.object({
  connection: connectionSchema,
  password: z.string().max(8192).optional(),
  rememberSecret: z.boolean(),
});
export const readRequestSchema = z
  .object({
    conversationId: z.number().int().positive().safe().optional(),
    before: z
      .object({
        sequence: z.number().int().nonnegative(),
        entryId: z.number().int().positive(),
      })
      .optional(),
    entryId: z.number().int().positive().safe().optional(),
    limit: z.number().int().min(1).max(2000).default(500),
  })
  .superRefine((value, context) => {
    if (
      value.entryId !== undefined &&
      (value.conversationId === undefined || value.before)
    )
      context.addIssue({
        code: "custom",
        path: ["entryId"],
        message:
          "Exact-entry reads require a conversation and cannot use pagination.",
      });
  });
export type ReadRequest = z.infer<typeof readRequestSchema>;
export type RawReadRequest = ReadRequest & { since?: number };
export type RecordData = Record<string, any>;
export type RawSnapshot = {
  sequence: number;
  observedAt: string;
  conversations: {
    record: RecordData;
    entryCount: number;
    latestEntry?: RecordData;
    latestResponseEntry?: RecordData;
    firstEntry?: RecordData;
    active: number;
    failed: number;
  }[];
  entries: { record: RecordData; sequence: number; inherited: boolean }[];
  tasks: RecordData[];
  documents: {
    record: RecordData;
    revisions: {
      seq: number;
      kind: string;
      version: number;
      content: unknown;
    }[];
  }[];
  hasEarlier: boolean;
  unchanged?: boolean;
  handoffs?: RecordData[];
};
export type Conversation = {
  id: number;
  title: string;
  owner?: { conversationId: number; taskId: number };
  parent?: { conversationId: number; at: number };
  entryCount: number;
  active: number;
  failed: number;
  lastAt?: number;
  response?: { entryId: number; text: string; at?: number };
  agent?: string;
  namespace?: string;
  channel?: string;
  createdAt?: number;
  opening?: {
    entryId: number;
    text: string;
    at?: number;
    sender?: InstanceMessage;
    labels?: HandoffLabels;
  };
};
export type HandoffLabels = {
  workflow?: string;
  cycle?: string;
  assignment?: string;
  phase?: string;
};
export type InstanceMessage = {
  namespace: string;
  from: string;
  to: string;
  kind: "message" | "reply";
  replyRequested: boolean;
};
export type Handoff = {
  conversationId: number;
  entryId: number;
  text: string;
  at?: number;
  sender: InstanceMessage;
  labels?: HandoffLabels;
};
export type Activity = {
  id: string;
  entryId: number;
  conversationId: number;
  sequence: number;
  kind: string;
  category: "message" | "tool" | "boundary" | "record";
  role?: string;
  sender?: InstanceMessage;
  title: string;
  text: string;
  at?: number;
  inherited: boolean;
  taskId?: number;
  tool?: {
    callId: string;
    name: string;
    phase: "call" | "result";
    arguments?: unknown;
    result?: unknown;
    error?: boolean;
    durationMs?: number;
    missing: boolean;
    truncated?: boolean;
    live?: RecordData;
  };
  record: unknown;
};
export type Task = {
  id: number;
  conversationId: number;
  owner?: number;
  kind: string;
  status: string;
  outcome?: string;
  startedAt?: number;
  endedAt?: number;
  phase?: string;
  attempt?: number;
  waitingOn: number[];
  background: boolean;
  record: unknown;
};
export type Document = {
  id: number;
  kind: string;
  scope: unknown;
  history?: string;
  sequence?: number;
  value?: unknown;
  unavailable?: string;
};
export type Snapshot = {
  sequence: number;
  observedAt: string;
  conversations: Conversation[];
  activities: Activity[];
  tasks: Task[];
  documents: Document[];
  live: { conversationId: number; text: string; tools: unknown[] }[];
  hasEarlier: boolean;
  earliestId?: number;
  earliestSequence?: number;
  sourceId: string;
  conversationId?: number;
  storeId?: string;
  handoffs: Handoff[];
};
export type Preferences = {
  connections: SavedConnection[];
  lastConnection?: string;
  theme: "system" | "light" | "dark";
  secureStorage: boolean;
  platform: string;
};
export type Probe = { stores: string[]; message: string };
export type LocalWork = {
  observedAt: string;
  stores: {
    connection: Connection;
    scope: string;
    pids: number[];
    conversations: Conversation[];
    documents: Document[];
    handoffs: Handoff[];
  }[];
  issues: string[];
};
export type ObserverApi = {
  localWork(): Promise<LocalWork>;
  preferences(): Promise<Preferences>;
  chooseFile(
    kind: "sqlite" | "identity" | "certificate",
  ): Promise<string | null>;
  probe(draft: ConnectionDraft): Promise<Probe>;
  save(draft: ConnectionDraft): Promise<SavedConnection>;
  remove(id: string): Promise<void>;
  connect(id: string): Promise<Probe>;
  disconnect(): Promise<void>;
  read(request: ReadRequest): Promise<Snapshot>;
  theme(value: Preferences["theme"]): Promise<void>;
  external(url: string): Promise<void>;
};
declare global {
  interface Window {
    observer: ObserverApi;
  }
}
