import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { StorageRequestError, type Storage } from "@earendil-works/pi-durable";
import { SqliteStorage, type SqliteDatabase, type SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import { identifier, parseRequest, type StorageReply, type StorageRequest } from "./protocol.js";

const context = BACKGROUND_CONTEXT;
type Owner = { session: string; sequence: number; hash: string; reply: string; closed: number };

/** Pi and the receipt use the same native transaction, without changing Pi's schema. */
class ReceiptedDatabase implements SqliteDatabase {
  private scope = new AsyncLocalStorage<SqliteExecutor>();
  constructor(private db: SqliteDatabase) {}
  atomic<T>(work: (tx: SqliteExecutor) => Promise<T>) {
    return this.db.transaction(tx => this.scope.run(tx, () => work(tx)));
  }
  transaction<T>(work: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    const tx = this.scope.getStore();
    return tx ? work(tx) : this.db.transaction(work);
  }
  exec: SqliteDatabase["exec"] = sql => (this.scope.getStore() ?? this.db).exec(sql);
  run: SqliteDatabase["run"] = (sql, ...args) => (this.scope.getStore() ?? this.db).run(sql, ...args);
  get: SqliteDatabase["get"] = (sql, ...args) => (this.scope.getStore() ?? this.db).get(sql, ...args);
  all: SqliteDatabase["all"] = (sql, ...args) => (this.scope.getStore() ?? this.db).all(sql, ...args);
  close() { return this.db.close(); }
}

/** Restrict files before SQLite can recover journals or create sidecars. POSIX hosts only. */
async function privateStore(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await dir.stat();
    if (!info.isDirectory() || info.uid !== process.geteuid?.()) throw new Error("Store must belong to this account.");
    await dir.chmod(0o700);
  } finally { await dir.close(); }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    let file;
    try {
      file = await open(join(directory, `session.sqlite${suffix}`),
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (suffix ? 0 : constants.O_CREAT), 0o600);
    } catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid?.()) throw new Error("Unsafe storage file.");
      await file.chmod(0o600);
    } finally { await file.close(); }
  }
}

class Store {
  private tail: Promise<unknown> = Promise.resolve();
  private failed?: unknown;
  constructor(private db: ReceiptedDatabase, private pi: SqliteStorage, private release: () => Promise<void>,
    private guard: () => void, private report?: (error: unknown) => void) {}
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { this.guard(); return work(); });
    this.tail = result.catch(() => {});
    return result;
  }
  async request(r: StorageRequest): Promise<StorageReply> {
    if (this.failed) return { status: "fatal", error: "Store requires operator recovery." };
    const hash = createHash("sha256").update(JSON.stringify(r)).digest("hex");
    try {
      return await this.db.atomic(async tx => {
        const owner = await tx.get<Owner>("SELECT * FROM remote_owner WHERE singleton=1");
        if (r.method === "open") {
          if (await tx.get("SELECT session FROM remote_retired WHERE session=?", r.session))
            return { status: "conflict", error: "This storage session is retired." };
          if (owner && (!owner.closed || owner.session === r.session)) {
            return owner.session === r.session && !owner.closed && owner.sequence === 0
              ? { status: "ok" }
              : { status: "conflict", error: "Store is owned. Confirm the previous runner stopped before retiring its session." };
          }
          if (owner) await tx.run("INSERT OR IGNORE INTO remote_retired(session,reason) VALUES(?,?)", owner.session, "Closed by owner");
          await tx.run("INSERT OR REPLACE INTO remote_owner VALUES(1,?,0,'','',0)", r.session);
          return { status: "ok" };
        }
        if (!owner || owner.session !== r.session) return { status: "conflict", error: "Storage ownership changed." };
        if (r.sequence !== undefined && r.sequence === owner.sequence) {
          return hash === owner.hash ? JSON.parse(owner.reply) as StorageReply
            : { status: "conflict", error: "Storage sequence was reused with different content." };
        }
        if (owner.closed) return { status: "conflict", error: "Storage session is closed." };
        if (r.sequence !== undefined && r.sequence !== owner.sequence + 1)
          return { status: "conflict", error: "Storage requests arrived out of sequence." };
        let value: unknown;
        if (r.method === "close") value = undefined;
        else {
          // The allowlist/arity were checked before indexing the native Storage interface.
          const method = this.pi[r.method as keyof Storage] as (...args: unknown[]) => Promise<unknown>;
          value = await method.call(this.pi, ...r.args.map(arg => arg === null ? undefined : arg), context);
        }
        const reply: StorageReply = { status: "ok", ...(value === undefined ? {} : { value }) };
        if (r.sequence !== undefined) await tx.run(
          "UPDATE remote_owner SET sequence=?,hash=?,reply=?,closed=? WHERE singleton=1",
          r.sequence, hash, JSON.stringify(reply), r.method === "close" ? 1 : 0,
        );
        return reply;
      });
    } catch (error) {
      if (error instanceof StorageRequestError && r.sequence === undefined)
        return { status: "rejected", error: error.message };
      // A failed mint can advance Pi's in-memory candidate counter. Never reuse this process's
      // storage after any unexpected failure, even when the outer transaction rolled back.
      this.failed = error;
      this.report?.(error);
      return { status: "fatal", error: "Storage operation failed; operator recovery is required." };
    }
  }
  async retire(session: string, reason: string) {
    await this.db.atomic(async tx => {
      const owner = await tx.get<Owner>("SELECT * FROM remote_owner WHERE singleton=1");
      if (!owner || owner.session !== session) throw new Error("Owner does not match the confirmed session.");
      await tx.run("INSERT OR IGNORE INTO remote_retired(session,reason) VALUES(?,?)", session, reason);
      await tx.run("UPDATE remote_owner SET closed=1 WHERE singleton=1");
    });
  }
  async owner() { return this.db.get<Owner>("SELECT * FROM remote_owner WHERE singleton=1"); }
  async close() { try { await this.pi.close(context); } finally { await this.release(); } }
}

export class SqliteStorageService {
  private stores = new Map<string, Promise<Store>>();
  private closed = false;
  constructor(readonly directory: string, private allowedStores: readonly string[],
    private options: { onError?: (error: unknown) => void } = {}) {
    if (process.platform === "win32") throw new Error("The SQLite service currently requires a POSIX host.");
    if (allowedStores.some(id => !identifier(id))) throw new Error("Invalid store identifier.");
  }
  private store(id: string) {
    if (this.closed || !this.allowedStores.includes(id)) throw new Error("Store is not available.");
    let store = this.stores.get(id);
    if (!store) {
      store = this.open(id);
      this.stores.set(id, store);
    }
    return store;
  }
  private async open(id: string) {
    const directory = join(this.directory, id);
    await privateStore(directory);
    let compromised = false;
    const release = await lockfile.lock(directory, { lockfilePath: join(directory, ".service.lock"),
      onCompromised() { compromised = true; } });
    let db: ReceiptedDatabase | undefined;
    try {
      db = new ReceiptedDatabase(await openNodeSqliteDatabase(join(directory, "session.sqlite")));
      await db.exec(`PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS remote_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),session TEXT NOT NULL,sequence INTEGER NOT NULL,hash TEXT NOT NULL,reply TEXT NOT NULL,closed INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_retired(session TEXT PRIMARY KEY,reason TEXT NOT NULL);`);
      const pi = await SqliteStorage.open(db);
      return new Store(db, pi, release, () => {
        if (compromised) throw new Error("Storage service lock was lost.");
      }, this.options.onError);
    } catch (error) { try { await db?.close(); } finally { await release(); } throw error; }
  }
  async request(storeId: string, request: unknown): Promise<StorageReply> {
    let r;
    try { r = parseRequest(request); }
    catch { return { status: "conflict", error: "Invalid storage request." }; }
    const store = await this.store(storeId);
    return store.run(() => store.request(r));
  }
  /** Offline administration only. The caller must first verify the old runner is stopped. */
  async retire(storeId: string, session: string, reason: string) {
    if (!identifier(session) || !reason.trim()) throw new Error("An exact session and reason are required.");
    const store = await this.store(storeId);
    await store.run(() => store.retire(session, reason));
  }
  async owner(storeId: string) { const store = await this.store(storeId); return store.run(() => store.owner()); }
  async close() {
    this.closed = true;
    const opened = await Promise.allSettled(this.stores.values());
    const results = await Promise.allSettled(opened.flatMap(result =>
      result.status === "fulfilled" ? [result.value.run(() => result.value.close())] : []));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
