import { openSqliteSnapshot } from "@dispatch/runner/records";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import type { Connection, RawSnapshot, Snapshot } from "../shared/contracts";
import type {
  AgentProcess,
  ProcessAgent,
  ProcessCatalog,
  ProcessConversationRequest,
  ProcessToolRequest,
  ProcessTurnRequest,
  ProcessTurns,
  TurnTranscript,
} from "../shared/processes";
import {
  oneLine,
  readable,
  responseExcerpt,
  toolLabel,
} from "../shared/processes";
import { discoverLocalFiles } from "./local";
import { project, redact } from "./projection";
import { readSqlite } from "./sqlite";

const exec = promisify(execFile);
type Generation = { key: string; start: number; end: number };
type Store = {
  connection: Connection;
  snapshot?: Snapshot;
  generations?: Generation[];
};
const stores = new Map<string, Store>();
const paths = new Map<string, string>();
type EntryRow = { record: string; commit_seq: number };
const errorText = (error: unknown) =>
  String(redact(error instanceof Error ? error.message : error));
const timestamp = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function agentName(
  conversation: Snapshot["conversations"][number],
  source: string,
) {
  const name = readable(conversation.agent ?? source);
  if (!conversation.owner) return name;
  const title = conversation.opening?.text ?? conversation.title;
  const worker = title.match(/\b(w\d+)\b/i)?.[1];
  const pass = title.match(/\b(p\d+)\b/i)?.[1];
  const scope = title.match(/\bScope\s+([A-Z][A-Za-z0-9 /&_()-]{0,99}):/)?.[1];
  if (scope) return `${scope}${pass ? ` · ${pass}` : ` · #${conversation.id}`}`;
  return worker
    ? `${name} · ${worker}${pass ? ` · ${pass}` : ""}`
    : `${name} · #${conversation.id}`;
}

/** Only previously discovered sources are addressable by renderer requests. */
function withStore<T>(
  request: ProcessConversationRequest,
  read: (db: DatabaseSync, store: Store, sequence: number) => T,
): T {
  const store = stores.get(request.sourceId);
  if (!store)
    throw new Error(
      "This source is no longer available. Return to Processes and refresh.",
    );
  const db = openSqliteSnapshot(store.connection.path);
  try {
    if (
      !db
        .prepare("SELECT id FROM conversations WHERE id=?")
        .get(request.conversationId)
    )
      throw new Error("This agent conversation is no longer retained.");
    const sequence =
      Number(
        db.prepare("SELECT next_seq FROM durable_metadata").get()?.next_seq,
      ) - 1;
    return read(db, store, sequence);
  } finally {
    db.close();
  }
}

function activities(rows: EntryRow[], store: Store, sequence: number) {
  const raw: RawSnapshot = {
    sequence,
    observedAt: new Date().toISOString(),
    conversations: [],
    entries: rows.map((row) => ({
      record: JSON.parse(row.record),
      sequence: Number(row.commit_seq),
      inherited: false,
    })),
    tasks: [],
    documents: [],
    hasEarlier: false,
  };
  return project(raw, store.connection).activities;
}

export async function processCatalog(): Promise<ProcessCatalog> {
  const discovery = await discoverLocalFiles([]);
  if (discovery.issues.length) throw new Error(discovery.issues.join(" "));
  const issues = [...discovery.issues];
  const processes = new Map<number, AgentProcess>();
  const pids = [
    ...new Set([...discovery.paths.values()].flatMap((owners) => [...owners])),
  ];
  const metadata = new Map<number, { startedAt?: number; command: string }>();
  if (pids.length) {
    try {
      const { stdout } = await exec(
        "ps",
        ["-p", pids.join(","), "-o", "pid=,lstart=,comm="],
        { env: { ...process.env, LC_ALL: "C" } },
      );
      for (const line of stdout.split("\n")) {
        const match = line
          .trim()
          .match(/^(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/);
        if (!match) continue;
        const started = Date.parse(match[2]);
        metadata.set(Number(match[1]), {
          startedAt: Number.isFinite(started) ? started : undefined,
          command: basename(match[3]),
        });
      }
    } catch {
      issues.push(
        "Process start times are unavailable. Agent stores remain readable.",
      );
    }
  }
  for (const [path, owners] of discovery.paths) {
    let db: DatabaseSync | undefined;
    let known = false;
    try {
      db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      known = Boolean(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='durable_schema'",
          )
          .get(),
      );
    } catch {
      /* Unrelated or disappeared process files are not sources. */
    } finally {
      db?.close();
    }
    if (!known) continue;
    const sourceId = paths.get(path) ?? randomUUID();
    paths.set(path, sourceId);
    let store = stores.get(sourceId);
    if (!store) {
      store = {
        connection: {
          id: sourceId,
          name: readable(basename(dirname(path))),
          kind: "sqlite",
          path,
          transport: { kind: "direct" },
          postgres: {
            host: "localhost",
            port: 5432,
            database: "postgres",
            user: "postgres",
            storeId: "",
            tls: "verify",
            caFile: "",
          },
        },
      };
      stores.set(sourceId, store);
    }
    const scopeName =
      basename(path) === "session.sqlite"
        ? basename(dirname(dirname(path)))
        : basename(path);
    for (const pid of owners)
      if (!processes.has(pid)) {
        const info = metadata.get(pid);
        processes.set(pid, {
          key: `${pid}:${info?.startedAt ?? path}`,
          pid,
          name: readable(scopeName.replace(/-\d{8}(?:-\d{6})?$/, "")),
          application: info?.command ?? "Agent process",
          startedAt: info?.startedAt,
          agents: [],
          issues: [],
        });
      }
    try {
      const raw = await readSqlite(path, {
        limit: 1,
        since: store.snapshot?.sequence,
      });
      if (!raw.unchanged) {
        store.snapshot = project(raw, store.connection);
        const timing = new DatabaseSync(path, {
          readOnly: true,
          allowExtension: false,
        });
        try {
          store.generations = timing
            .prepare(
              `SELECT conversation_id,
            json_extract(record,'$.startedAt') AS started,
            json_extract(record,'$.endedAt') AS ended FROM tasks
            WHERE kind='"pi.generation"' AND json_type(record,'$.startedAt')='integer'
            AND json_type(record,'$.endedAt')='integer'`,
            )
            .all()
            .map((row) => ({
              key: `${sourceId}:${row.conversation_id}`,
              start: Number(row.started),
              end: Number(row.ended),
            }));
        } finally {
          timing.close();
        }
      }
      const snapshot = store.snapshot!;
      const agents: ProcessAgent[] = snapshot.conversations
        .filter((c) => c.entryCount > 0 || c.active > 0)
        .map((c) => ({
          key: `${sourceId}:${c.id}`,
          sourceId,
          conversationId: c.id,
          name: agentName(c, store!.connection.name),
          title: oneLine(c.opening?.text ?? c.title),
          parentKey: c.owner
            ? `${sourceId}:${c.owner.conversationId}`
            : undefined,
          startedAt: c.createdAt ?? c.opening?.at,
          lastAt: c.lastAt ?? c.response?.at,
          response: c.response
            ? {
                entryId: c.response.entryId,
                at: c.response.at,
                excerpt: responseExcerpt(c.response.text),
              }
            : undefined,
          active: c.active,
          failed: c.failed,
          turns: c.turnCount ?? 0,
          parallelKeys: [],
        }));
      const namespaces = [
        ...new Set(
          snapshot.conversations.flatMap((c) =>
            c.namespace ? [c.namespace] : [],
          ),
        ),
      ];
      for (const pid of owners) {
        const process = processes.get(pid)!;
        if (namespaces.length) process.application = namespaces.join(", ");
        if (/^(state|data|db)$/i.test(process.name) && namespaces[0])
          process.name = readable(
            namespaces[0].replace(/-\d{8}(?:-\d{6})?$/, ""),
          );
        process.agents.push(...agents);
      }
    } catch (error) {
      for (const pid of owners)
        processes
          .get(pid)!
          .issues.push(`${store.connection.name}: ${errorText(error)}`);
    }
  }
  for (const process of processes.values()) {
    process.agents.sort(
      (a, b) =>
        (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) ||
        a.conversationId - b.conversationId ||
        a.key.localeCompare(b.key),
    );
    const agents = new Map(process.agents.map((agent) => [agent.key, agent]));
    const sources = new Set(process.agents.map((agent) => agent.sourceId));
    const generations = [...sources]
      .flatMap((id) => stores.get(id)?.generations ?? [])
      .sort((a, b) => a.start - b.start);
    let overlapping: Generation[] = [];
    const peers = new Map<string, Set<string>>();
    for (const generation of generations) {
      overlapping = overlapping.filter((other) => other.end > generation.start);
      for (const other of overlapping)
        if (other.key !== generation.key) {
          for (const [left, right] of [
            [other.key, generation.key],
            [generation.key, other.key],
          ]) {
            const keys = peers.get(left) ?? new Set<string>();
            keys.add(right);
            peers.set(left, keys);
          }
        }
      if (generation.end > generation.start) overlapping.push(generation);
    }
    for (const [key, keys] of peers) {
      const agent = agents.get(key);
      if (agent)
        agent.parallelKeys = [...keys].filter((key) => agents.has(key));
    }
  }
  return {
    host: hostname().replace(/\.local$/, ""),
    observedAt: new Date().toISOString(),
    processes: [...processes.values()].sort(
      (a, b) =>
        (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.pid - b.pid,
    ),
    issues,
  };
}

/** One retained pi.assistant entry is one model turn; tools never inflate this count. */
export function processTurns(
  request: ProcessConversationRequest,
): ProcessTurns {
  return withStore(request, (db, _store, sequence) => {
    const rows = db
      .prepare(
        `SELECT e.id,
      json_extract(e.record,'$.model[0].timestamp') AS at,
      json_extract(e.record,'$.model[0].stopReason') AS stop_reason,
      CASE WHEN json_type(e.record,'$.model[0].content')='text' THEN substr(json_extract(e.record,'$.model[0].content'),1,220)
        ELSE (SELECT substr(group_concat(json_extract(p.value,'$.text'),' '),1,220) FROM json_each(CASE WHEN json_type(e.record,'$.model[0].content')='array' THEN json_extract(e.record,'$.model[0].content') ELSE '[]' END) p WHERE json_extract(p.value,'$.type')='text') END AS summary,
      (SELECT json_group_array(json_object('name',json_extract(p.value,'$.name'),'arguments',json_object(
        'description',substr(json_extract(p.value,'$.arguments.description'),1,150),
        'title',substr(json_extract(p.value,'$.arguments.title'),1,150),
        'path',json_extract(p.value,'$.arguments.path'),
        'file_path',json_extract(p.value,'$.arguments.file_path'),
        'skill',json_extract(p.value,'$.arguments.skill'),
        'url',substr(json_extract(p.value,'$.arguments.url'),1,150),
        'query',substr(json_extract(p.value,'$.arguments.query'),1,150),
        'command',substr(COALESCE(json_extract(p.value,'$.arguments.command'),json_extract(p.value,'$.arguments.cmd')),1,150))))
        FROM json_each(CASE WHEN json_type(e.record,'$.model[0].content')='array' THEN json_extract(e.record,'$.model[0].content') ELSE '[]' END) p WHERE json_extract(p.value,'$.type')='toolCall') AS tools,
      (SELECT COUNT(*) FROM json_each(CASE WHEN json_type(e.record,'$.model[0].content')='array' THEN json_extract(e.record,'$.model[0].content') ELSE '[]' END) p WHERE json_extract(p.value,'$.type')='toolCall') AS tool_count
      FROM entries e WHERE e.conversation_id=? AND json_extract(e.record,'$.kind')='pi.assistant' ORDER BY e.commit_seq,e.id`,
      )
      .all(request.conversationId);
    return {
      sequence,
      turns: rows.map((row, index) => {
        const tools = JSON.parse(String(row.tools ?? "[]")) as {
          name: string;
          arguments: unknown;
        }[];
        const label = tools[0]
          ? toolLabel({ title: tools[0].name, tool: tools[0] })
          : "Assistant response";
        return {
          entryId: Number(row.id),
          number: index + 1,
          at: timestamp(row.at),
          summary: oneLine(
            String(
              redact(
                row.summary ||
                  `${label}${tools.length > 1 ? ` + ${tools.length - 1} more` : ""}`,
              ),
            ),
          ),
          tools: Number(row.tool_count),
          error: row.stop_reason === "error" || row.stop_reason === "aborted",
        };
      }),
    };
  });
}

export function processTurn(request: ProcessTurnRequest): TurnTranscript {
  return withStore(request, (db, store, sequence) => {
    const entry = db
      .prepare(
        "SELECT record,commit_seq FROM entries WHERE conversation_id=? AND id=? AND json_extract(record,'$.kind')='pi.assistant'",
      )
      .get(request.conversationId, request.entryId) as EntryRow | undefined;
    if (!entry)
      throw new Error("This turn is no longer retained in the selected agent.");
    const next = db
      .prepare(
        "SELECT id,commit_seq FROM entries WHERE conversation_id=? AND json_extract(record,'$.kind')='pi.assistant' AND (commit_seq>? OR (commit_seq=? AND id>?)) ORDER BY commit_seq,id LIMIT 1",
      )
      .get(
        request.conversationId,
        entry.commit_seq,
        entry.commit_seq,
        request.entryId,
      );
    const previous = db
      .prepare(
        "SELECT id,commit_seq FROM entries WHERE conversation_id=? AND json_extract(record,'$.kind')='pi.assistant' AND (commit_seq<? OR (commit_seq=? AND id<?)) ORDER BY commit_seq DESC,id DESC LIMIT 1",
      )
      .get(
        request.conversationId,
        entry.commit_seq,
        entry.commit_seq,
        request.entryId,
      );
    // Retain result metadata here; payload bytes cross IPC only on expansion.
    const rows = db
      .prepare(
        `SELECT CASE WHEN json_extract(record,'$.kind')='pi.tool-result' THEN json_object(
      'id',id,'conversationId',conversation_id,'kind','pi.tool-result',
      'model',json_array(json_object('role','toolResult',
        'toolCallId',json_extract(record,'$.model[0].toolCallId'),
        'toolName',json_extract(record,'$.model[0].toolName'),
        'timestamp',json_extract(record,'$.model[0].timestamp'),
        'isError',json(CASE WHEN json_extract(record,'$.model[0].isError')=1 THEN 'true' ELSE 'false' END),
        'durationMs',json_extract(record,'$.model[0].durationMs'),
        'details',json_object('durationMs',json_extract(record,'$.model[0].details.durationMs'),
          'truncated',json_extract(record,'$.model[0].details.truncated'),
          'truncation',json_extract(record,'$.model[0].details.truncation')),
        'content',json('[]')))) ELSE record END AS record,commit_seq FROM entries WHERE conversation_id=?
      AND (commit_seq>? OR (commit_seq=? AND id>?))
      ${next ? "AND (commit_seq<? OR (commit_seq=? AND id<?))" : ""} ORDER BY commit_seq,id`,
      )
      .all(
        request.conversationId,
        Number(previous?.commit_seq ?? -1),
        Number(previous?.commit_seq ?? -1),
        Number(previous?.id ?? 0),
        ...(next
          ? [Number(next.commit_seq), Number(next.commit_seq), Number(next.id)]
          : []),
      ) as EntryRow[];
    const inTurn = rows.filter((row) => {
      const record = JSON.parse(row.record);
      const position =
        row.commit_seq - entry.commit_seq || record.id - request.entryId;
      const userMessage = (record.model ?? []).some(
        (message: { role: string }) => message.role === "user",
      );
      return userMessage
        ? position <= 0
        : position >= 0 || /compact|reset|context/.test(record.kind);
    });
    const projected = activities(inTurn, store, sequence);
    const calls = new Set(
      projected
        .filter((event) => event.tool?.phase === "call")
        .map((event) => event.tool!.callId),
    );
    return {
      sequence,
      events: projected
        .filter(
          (event) =>
            event.category !== "record" &&
            !(event.tool?.phase === "result" && calls.has(event.tool.callId)),
        )
        .map((event) => {
          const { record: _record, ...safe } = event;
          if (!event.tool) return safe;
          const result = projected.find(
            (other) =>
              other.tool?.phase === "result" &&
              other.tool.callId === event.tool!.callId,
          );
          return {
            ...safe,
            title: toolLabel(event),
            text: "",
            hasResult: Boolean(event.tool.result),
            resultAt: result?.at,
            tool: {
              ...event.tool,
              arguments: undefined,
              result: undefined,
              live: undefined,
            },
          };
        }),
    };
  });
}

export function processTool(request: ProcessToolRequest) {
  return withStore(request, (db, store, sequence) => {
    const row = db
      .prepare(
        "SELECT record,commit_seq FROM entries WHERE conversation_id=? AND id=?",
      )
      .get(request.conversationId, request.entryId) as EntryRow | undefined;
    if (!row) throw new Error("This tool event is no longer retained.");
    const record = JSON.parse(row.record);
    const belongs = (record.model ?? []).some(
      (message: { role: string; toolCallId?: string; content?: unknown }) =>
        message.role === "toolResult"
          ? message.toolCallId === request.callId
          : Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === "toolCall" && part.id === request.callId,
            ),
    );
    if (!belongs)
      throw new Error("The requested tool does not belong to this turn.");
    const result = db
      .prepare(
        `SELECT record,commit_seq FROM entries WHERE conversation_id=? AND json_extract(record,'$.kind')='pi.tool-result'
      AND json_extract(record,'$.model[0].toolCallId')=? ORDER BY commit_seq DESC,id DESC LIMIT 1`,
      )
      .get(request.conversationId, request.callId) as EntryRow | undefined;
    const events = activities(
      result && result.record !== row.record ? [row, result] : [row],
      store,
      sequence,
    );
    const event =
      events.find(
        (item) =>
          item.tool?.callId === request.callId && item.tool.phase === "call",
      ) ?? events.find((item) => item.tool?.callId === request.callId);
    if (!event)
      throw new Error("The requested tool does not belong to this turn.");
    return event;
  });
}
