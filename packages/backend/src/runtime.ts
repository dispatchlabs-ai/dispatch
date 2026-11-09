import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import type { Agent, Chat, Snapshot } from "./contracts.js";
import { readConfig, AdmissionError } from "./config.js";
import * as runner from "@dispatch/runner";
import * as reader from "@dispatch/runner/watch-reader";
import { createStores, identity, readStore, type Selection } from "./stores.js";

interface NativeService {
  create(
    agent: string,
    source: runner.Chat["source"],
    key: string,
  ): Promise<Chat>;
  resolve(id: string): Promise<unknown>;
  submit(
    id: string,
    text: string,
    requestId: string,
    mode: "followUp",
    source: runner.Chat["source"],
  ): Promise<{ submissionId: number }>;
  snapshot(id: string): Promise<Snapshot>;
  stop(id: string): Promise<void>;
  close(): Promise<void>;
}
async function startOwner(
  path: string,
  namespace: string,
  names: string[],
): Promise<NativeService> {
  const worker = new Worker(new URL("./owner.js", import.meta.url), {
    workerData: {
      path,
      namespace,
      names,
      configFile: process.env.DISPATCH_CONFIG,
    },
  });
  const calls = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  let sequence = 0;
  let exited = false;
  const ready = new Promise<void>((resolve, reject) => {
    worker.on("message", (message) => {
      if (message.ready) resolve();
      else if (message.failed)
        reject(
          new AdmissionError(
            "Native ownership/compatibility admission failed. Use the original release/host configuration; saved work was not resumed.",
          ),
        );
      else {
        const call = calls.get(message.id);
        calls.delete(message.id);
        if (message.error)
          call?.reject(
            message.status === 409
              ? new AdmissionError(message.error)
              : new Error(message.error),
          );
        else call?.resolve(message.result);
      }
    });
    worker.on("error", () => {
      reject(
        new AdmissionError(
          "Native owner worker failed. Inspect the installed runtime.",
        ),
      );
    });
    worker.on("exit", () => {
      exited = true;
      reject(new AdmissionError("Native owner exited before admission."));
      for (const call of calls.values())
        call.reject(
          new Error(
            "Native owner exited; delivery may be uncertain. Preserve the request ID and retry.",
          ),
        );
      calls.clear();
    });
  });
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  const call = (method: string, args: unknown[]) =>
    new Promise<any>((resolve, reject) => {
      if (exited) {
        reject(
          new Error(
            "Native owner has exited. Restart Web with the same configuration and preserve the request identity.",
          ),
        );
        return;
      }
      const id = ++sequence;
      calls.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  return {
    create: (...args) => call("create", args),
    resolve: (...args) => call("resolve", args),
    submit: (...args) => call("submit", args),
    snapshot: (...args) => call("snapshot", args),
    stop: (...args) => call("stop", args),
    close: async () => {
      try {
        await call("close", []);
      } finally {
        await worker.terminate();
      }
    },
  };
}
// Read the native session document format for admission only. No writes, invented
// chat-index admission, migrations or copied history. Unknown formats fail closed.
function sessionDocument(path: string, kind: string): any {
  return readStore(path, (db) => {
    const doc = db
      .prepare("SELECT id FROM documents WHERE kind=? AND scope_kind='session'")
      .get(JSON.stringify(kind));
    if (!doc)
      throw new AdmissionError(
        `Missing ${kind} metadata. Recover with the original native runtime.`,
      );
    const rows = db
      .prepare(
        "SELECT kind,version,content FROM document_revisions WHERE document_id=? AND seq>=COALESCE((SELECT MAX(seq) FROM document_revisions WHERE document_id=? AND kind='base'),0) ORDER BY seq",
      )
      .all(doc.id!, doc.id!);
    let value: any = {};
    for (const row of rows) {
      if (row.version !== 1)
        throw new AdmissionError(
          "Unsupported native metadata version. Use the original runtime.",
        );
      const content = JSON.parse(String(row.content));
      if (row.kind === "base") {
        value = content;
        continue;
      }
      if (row.kind !== "delta" || !Array.isArray(content))
        throw new AdmissionError("Unsupported native metadata delta.");
      for (const op of content) {
        if (op[0] === "r") {
          value = op[1];
          continue;
        }
        const path = op[1];
        if (
          !Array.isArray(path) ||
          !path.length ||
          path.some((key) =>
            ["__proto__", "constructor", "prototype"].includes(String(key)),
          )
        )
          throw new AdmissionError("Unsupported native metadata path.");
        let target = value;
        for (const key of path.slice(0, -1)) target = target[key];
        const key = path.at(-1);
        if (op[0] === "s") target[key] = op[2];
        else if (op[0] === "d") delete target[key];
        else if (op[0] === "a") target[key] += op[2];
        else if (op[0] === "t") target[key] = target[key].slice(0, op[2]);
        else throw new AdmissionError("Unsupported native metadata operation.");
      }
    }
    return value;
  });
}
export async function openRuntime() {
  const config = await readConfig();
  const { definitionsRoot, host } = config;
  process.chdir(host.cwd);
  const stores = createStores(config, reader);
  // Catalog loading does not open any native storage or connect a provider.
  const definitions = new Map<string, any>();
  const agents: Agent[] = [];
  for (const entry of await runner.catalog(definitionsRoot))
    if (entry.runnable) {
      const definition = await runner.loadAgent(definitionsRoot, entry.id);
      definitions.set(entry.id, definition);
      agents.push({ id: entry.id, description: definition.description });
    }
  const owners = new Map<
    string,
    { service: NativeService; namespace: string }
  >();
  const claiming = new Set<string>();
  const opening = new Map<
    string,
    Promise<{ service: NativeService; namespace: string }>
  >();
  async function own(
    path: string,
    namespace: string,
    agent: string,
    create = false,
  ) {
    const ownerKey = join(path, agent);
    if (owners.has(ownerKey)) return owners.get(ownerKey)!;
    if (opening.has(ownerKey)) return opening.get(ownerKey)!;
    const operation = (async () => {
      if (!definitions.has(agent))
        throw new AdmissionError(
          `Agent ${agent} is not in this installed release. Use its original release to send; history is still available.`,
        );
      if (host.workspace?.agents?.includes(agent) || host.artifacts)
        throw new AdmissionError(
          "This session requires a workspace/artifact host binding. Use its configured native CLI; history remains available.",
        );
      if (namespace !== (host.namespace ?? "dispatch"))
        throw new AdmissionError(
          `This store uses namespace ${namespace}, not the configured host namespace. Use its original host configuration, or choose a compatible source.`,
        );
      const names = new Set<string>();
      async function include(id: string) {
        if (names.has(id)) return;
        const definition = definitions.get(id);
        if (!definition)
          throw new AdmissionError(
            `Required authored recipient ${id} is unavailable in this release.`,
          );
        names.add(id);
        for (const recipient of definition.messages ?? [])
          await include(recipient);
      }
      await include(agent);
      const overlaps = [...names].filter(
        (id) => owners.has(join(path, id)) || claiming.has(join(path, id)),
      );
      if (overlaps.length)
        throw new AdmissionError(
          `This session's ${overlaps.join(", ")} recipient is already owned by another chat worker. Restart Web to release it, then select the intended primary agent. Viewing stays available.`,
        );
      const claims = [...names].map((id) => join(path, id));
      for (const claim of claims) claiming.add(claim);
      try {
        // A harness resumes all unfinished tasks in its store. Validate the entire
        // message closure before opening any of it, not just the selected chat.
        for (const id of names) {
          if (host.workspace?.agents?.includes(id))
            throw new AdmissionError(
              `${id} requires its native workspace CLI.`,
            );
          const folder = join(path, id),
            file = join(folder, "session.sqlite");
          const exists = await stat(file).then(
            () => true,
            () => false,
          );
          if (!exists) {
            if (create) continue;
            throw new AdmissionError(
              `Required recipient store ${id} is missing. Recover the session in its original CLI; no replacement DB was created.`,
            );
          }
          if (
            await lockfile.check(folder, {
              lockfilePath: join(folder, ".owner.lock"),
            })
          )
            throw new AdmissionError(
              `${id} has a native owner lock. Finish/suspend the original CLI/service, wait for its lock to release, then retry. Do not delete live locks.`,
            );
          const found = await reader.discoverWatchRuns({
            stateRoot: dirname(path),
            session: path.split("/").at(-1)!,
          });
          const store = found.runs
            .flatMap((run) => run.stores)
            .find((store) => store.path === file);
          if (!store || store.namespace !== namespace)
            throw new AdmissionError(
              `Cannot verify ${id}'s native store: ${found.issues.join("; ")}. Use its original runtime.`,
            );
          if (store.pids.length)
            throw new AdmissionError(
              `${id} is owned by native process ${store.pids.join(", ")}. Suspend that owner before retrying.`,
            );
          readStore(file, (db) => {
            const schema = db
              .prepare("SELECT version FROM durable_schema WHERE singleton=1")
              .get();
            if (schema?.version !== 2)
              throw new AdmissionError(
                "This store needs a native schema migration. Use its original CLI deliberately; observation never migrates.",
              );
            const tasks = db
              .prepare("SELECT kind FROM tasks WHERE status<>'terminal'")
              .all();
            if (
              tasks.some(
                (task) =>
                  String(task.kind).includes("agent-loop") ||
                  String(task.kind).includes("schedule"),
              )
            )
              throw new AdmissionError(
                "This session has saved loop/calendar work. Stop or finish it in its original native owner before using web chat. Viewing does not resume it.",
              );
          });
          const saved = sessionDocument(file, `${namespace}.runner`);
          const definition = definitions.get(id);
          const extensions = [
            `${namespace}.schedules`,
            "dispatch.definition-resources",
            ...(definition.messages?.length
              ? [`${namespace}.instance-messages.${id}`]
              : []),
          ];
          // Mirror installed ChatService host adapters; never migrate definitions.
          if (
            saved.fingerprint !== definition.fingerprint ||
            saved.execution !== "live" ||
            saved.artifactVersion !== 1 ||
            saved.cwd !== (await realpath(host.cwd))
          )
            throw new AdmissionError(
              `${id}'s saved definition, working directory or execution mode differs from the installed host. Restart with its original release/configuration, or explicitly migrate idle work in the native CLI. History remains available.`,
            );
          const missing = (saved.hostExtensions ?? []).filter(
            (name: string) => !extensions.includes(name),
          );
          if (missing.length)
            throw new AdmissionError(
              `${id} requires original host adapters: ${missing.join(", ")}. Use its original CLI/service.`,
            );
        }
        const service = await startOwner(path, namespace, [...names]);
        const owner = { service, namespace };
        for (const name of names) owners.set(join(path, name), owner);
        return owner;
      } finally {
        for (const claim of claims) claiming.delete(claim);
      }
    })();
    opening.set(ownerKey, operation);
    try {
      return await operation;
    } finally {
      opening.delete(ownerKey);
    }
  }
  const nativeId = (item: Selection) =>
    `${item.chat.agent}:${item.chat.conversationId}`;
  async function admitted(id: string) {
    const item = await stores.get(id);
    const indexed = sessionDocument(
      item.store.path,
      `${item.store.namespace}.chats`,
    );
    if (!indexed.byId?.[nativeId(item)])
      throw new AdmissionError(
        "This is a native child/workflow conversation. Send or stop through its original parent/CLI; history remains available.",
      );
    const owner = await own(
      item.run.path,
      item.store.namespace,
      item.chat.agent,
    );
    // Only a real native Chats record admits ChatService operations; children
    // remain viewable, but must be directed through their owning parent.
    try {
      await owner.service.resolve(nativeId(item));
    } catch {
      throw new AdmissionError(
        "This is a native child/workflow conversation, not an independently addressable chat. Send or stop through its original parent/CLI; history remains available.",
      );
    }
    return { item, owner };
  }
  const service = {
    agents,
    sources: stores.statuses,
    list: stores.list,
    async create(
      agent: string,
      _source: runner.Chat["source"],
      key: string,
      sourceId = config.defaultSource,
    ) {
      const source = config.sources.find((value) => value.id === sourceId);
      if (!source)
        throw new AdmissionError("Choose a configured source for creation.");
      let root;
      try {
        root = await realpath(source.path);
        if (!(await stat(root)).isDirectory()) throw new Error();
      } catch {
        throw new AdmissionError(
          "Creation source is unavailable. Fix its configured directory and restart; no DB was created.",
        );
      }
      const session = `web-${createHash("sha256").update(`${agent}\0${key}`).digest("hex")}`;
      const path = join(root, session);
      const owner = await own(path, host.namespace ?? "dispatch", agent, true);
      const chat = await owner.service.create(agent, _source, key);
      stores.invalidate();
      return {
        ...chat,
        id: identity(join(path, agent, "session.sqlite"), chat.conversationId),
        source: source.id,
        sourceLabel: source.label,
        session,
      };
    },
    async submit(
      id: string,
      text: string,
      requestId: string,
      mode: "followUp",
      source: runner.Chat["source"],
    ) {
      const { item, owner } = await admitted(id);
      // Resume only on explicit admission, never on observation/startup/restart.
      return owner.service.submit(
        nativeId(item),
        text,
        requestId,
        mode,
        source,
      );
    },
    async stop(id: string) {
      const { item, owner } = await admitted(id);
      await owner.service.stop(nativeId(item));
    },
    async artifact(id: string, artifactId: string) {
      const item = await stores.get(id);
      const snapshot = await stores.snapshot(id);
      const artifact = snapshot.messages
        .flatMap((message) => message.artifacts ?? [])
        .find((value) => value.id === artifactId);
      if (!artifact) throw new Error("Unknown artifact.");
      const store = new runner.ArtifactStore(
        join(dirname(item.store.path), "artifacts"),
      );
      return {
        artifact,
        bytes: await store.read(item.chat.conversationId, artifact),
      };
    },
  };
  async function snapshot(id: string) {
    const item = await stores.get(id);
    const owner = owners.get(join(item.run.path, item.chat.agent));
    if (owner) {
      try {
        const snapshot = await owner.service.snapshot(nativeId(item));
        return {
          ...snapshot,
          chat: { ...item.chat, title: snapshot.chat.title },
        };
      } catch {
        /* Non-index children still use the native read-only reader. */
      }
    }
    return stores.snapshot(id);
  }
  const presentation = {
    snapshot,
    async watch(id: string, listener: (value: Snapshot) => Promise<void>) {
      // Poll native committed history for external owners; never attach an owning
      // harness merely to observe. Owned live partials come from native snapshot.
      let stopped = false,
        timer: ReturnType<typeof setTimeout>;
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const tick = async () => {
        try {
          if (!stopped) await listener(await snapshot(id));
        } catch {
          stopped = true;
          finish();
        }
        if (!stopped)
          timer = setTimeout(() => {
            void tick();
          }, 1000);
      };
      await listener(await snapshot(id));
      timer = setTimeout(() => {
        void tick();
      }, 1000);
      return {
        closed,
        stop: async () => {
          stopped = true;
          clearTimeout(timer);
          finish();
        },
      };
    },
  };
  return {
    service,
    presentation,
    stateRoot: config.sources.map((source) => source.path).join(", "),
    close: async () => {
      await Promise.allSettled([...opening.values()]);
      await Promise.all(
        [...new Set(owners.values())].map((owner) => owner.service.close()),
      );
    },
  };
}
