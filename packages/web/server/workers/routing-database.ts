import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client, type ClientConfig } from "pg";
import { acquireRuntimeOwner } from "../runtime-owner.js";

export type RoutingPostgresOptions = { database: ClientConfig; installationId: string; recoverOwnerId?: string };
type Change<T> = { body?: string; blocked?: boolean; result: T };

/** One controller, one non-reconnecting connection. Cache publication follows COMMIT.
 * This fences journal ownership, not old executors or external side effects.
 */
export class RoutingDatabase {
  private records = new Map<string, string>();
  private blocked = true;
  private tail: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private failure?: Error;
  private constructor(private readonly installation: string, private readonly sqlite?: DatabaseSync,
    private readonly release?: () => void, private readonly postgres?: Client, readonly ownerId?: string) {
    postgres?.on("error", () => { this.fail(); });
    postgres?.on("end", () => { this.fail(); });
  }

  static async openSqlite(directory: string, installation: string) {
    const owner = await acquireRuntimeOwner(directory);
    let db: DatabaseSync | undefined;
    try {
      const filename = join(owner.directory, "routes.sqlite");
      db = new DatabaseSync(filename); await chmod(filename, 0o600);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), installation TEXT NOT NULL); CREATE TABLE IF NOT EXISTS routes (conversation TEXT PRIMARY KEY, body TEXT NOT NULL)");
      const row = db.prepare("SELECT installation FROM identity WHERE id=1").get();
      if (row && row.installation !== installation) throw new Error("Routing state belongs to another installation.");
      if (!row) db.prepare("INSERT INTO identity VALUES (1, ?)").run(installation);
      db.exec("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK(id=1), blocked INTEGER NOT NULL); INSERT OR IGNORE INTO admission VALUES (1, 1)");
      const store = new RoutingDatabase(installation, db, owner.release);
      store.blocked = db.prepare("SELECT blocked FROM admission WHERE id=1").get()?.blocked !== 0;
      store.records = new Map(db.prepare("SELECT conversation, body FROM routes ORDER BY conversation").all().map(row => [String(row.conversation), String(row.body)]));
      return store;
    } catch (error) { try { db?.close(); } finally { owner.release(); } throw error; }
  }

  static async openPostgres(options: RoutingPostgresOptions) {
    if (!options.installationId || options.installationId.length > 200) throw new Error("Routing storage requires an installation identity.");
    const client = new Client({ connectionTimeoutMillis: 60_000, ...options.database, application_name: "dispatch-worker-routes" });
    const store = new RoutingDatabase(options.installationId, undefined, undefined, client, randomUUID());
    try {
      await client.connect();
      const lock = await client.query<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('dispatch-worker-routes-owner', 0)) AS held");
      if (!lock.rows[0]?.held) throw new Error("Routing owner already exists.");
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA IF NOT EXISTS dispatch_routing;
        REVOKE ALL ON SCHEMA dispatch_routing FROM PUBLIC;
        SET search_path TO dispatch_routing, pg_catalog;
        CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), installation TEXT NOT NULL, owner_id TEXT);
        CREATE TABLE IF NOT EXISTS routes (conversation TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK(id=1), blocked BOOLEAN NOT NULL);
        REVOKE ALL ON ALL TABLES IN SCHEMA dispatch_routing FROM PUBLIC;`);
      const identity = (await client.query<{ installation: string; owner_id: string | null }>("SELECT * FROM identity WHERE id=1 FOR UPDATE")).rows[0];
      if (identity) {
        if (identity.installation !== options.installationId) throw new Error("Routing installation mismatch.");
        if (identity.owner_id && identity.owner_id !== options.recoverOwnerId) throw new Error("Previous routing owner requires confirmed retirement.");
        if (options.recoverOwnerId !== undefined && identity.owner_id !== options.recoverOwnerId) throw new Error("Routing recovery identity mismatch.");
      } else {
        if (options.recoverOwnerId !== undefined) throw new Error("Cannot recover an unknown routing installation.");
        await client.query("INSERT INTO identity (id,installation) VALUES (1,$1)", [options.installationId]);
      }
      await client.query("UPDATE identity SET owner_id=$1 WHERE id=1", [store.ownerId]);
      await client.query("INSERT INTO admission (id,blocked) VALUES (1,TRUE) ON CONFLICT(id) DO NOTHING");
      const admission = (await client.query<{ blocked: boolean }>("SELECT blocked FROM admission WHERE id=1")).rows[0];
      if (!admission || typeof admission.blocked !== "boolean") throw new Error("Invalid routing admission state.");
      const rows = (await client.query<{ conversation: string; body: string }>("SELECT conversation,body FROM routes ORDER BY conversation")).rows;
      await client.query("COMMIT");
      store.assertHealthy();
      store.blocked = admission.blocked;
      store.records = new Map(rows.map(row => [row.conversation, row.body]));
      return store;
    } catch {
      await client.end().catch(() => {});
      throw new Error("Cannot open routing database; check installation, database access and confirmed retired-owner recovery.");
    }
  }

  private fail() {
    this.failure ??= new Error("Routing database failed; cached routes are unavailable. Retire the controller before recovery.");
    return this.failure;
  }
  private assertHealthy() { if (this.failure) throw this.failure; }
  private assertOpen() { this.assertHealthy(); if (this.closing) throw new Error("Routing database is closing."); }
  row(id: string) { this.assertOpen(); return this.records.get(id); }
  list() { this.assertOpen(); return [...this.records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); }
  admissionBlocked() { this.assertOpen(); return this.blocked; }

  /** compute runs synchronously under the mutation queue, before any SQL effects.
   * Invalid/stale caller input rejects only that operation; SQL failure poisons all reads/writes.
   */
  change<T>(conversation: string | undefined, compute: (body: string | undefined) => Change<T>): Promise<T> {
    try { this.assertOpen(); } catch (error) { return Promise.reject(error); }
    const result = this.tail.then(async () => {
      this.assertHealthy();
      const change = compute(conversation === undefined ? undefined : this.records.get(conversation));
      if (change.body !== undefined && conversation === undefined) throw new Error("Route mutation requires a conversation identity.");
      try {
        if (this.sqlite) {
          this.sqlite.exec("BEGIN IMMEDIATE");
          if (change.body !== undefined) this.sqlite.prepare("INSERT INTO routes VALUES (?, ?) ON CONFLICT(conversation) DO UPDATE SET body=excluded.body").run(conversation!, change.body);
          if (change.blocked !== undefined) {
            if (this.sqlite.prepare("UPDATE admission SET blocked=? WHERE id=1").run(change.blocked ? 1 : 0).changes !== 1) throw new Error("Routing admission disappeared.");
          }
          this.sqlite.exec("COMMIT");
        } else {
          const client = this.postgres!;
          await client.query("BEGIN");
          const owner = await client.query("SELECT id FROM identity WHERE id=1 AND installation=$1 AND owner_id=$2 FOR UPDATE", [this.installation, this.ownerId]);
          if (owner.rowCount !== 1) throw new Error("Routing ownership changed.");
          if (change.body !== undefined) await client.query("INSERT INTO routes VALUES ($1,$2) ON CONFLICT(conversation) DO UPDATE SET body=excluded.body", [conversation, change.body]);
          if (change.blocked !== undefined) {
            if ((await client.query("UPDATE admission SET blocked=$1 WHERE id=1", [change.blocked])).rowCount !== 1) throw new Error("Routing admission disappeared.");
          }
          await client.query("COMMIT");
        }
        this.assertHealthy();
        if (change.body !== undefined) this.records.set(conversation!, change.body);
        if (change.blocked !== undefined) this.blocked = change.blocked;
        return change.result;
      } catch {
        this.fail();
        try { if (this.sqlite) this.sqlite.exec("ROLLBACK"); else await this.postgres!.query("ROLLBACK"); } catch {}
        throw this.failure;
      }
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  close(): Promise<void> {
    return this.closing ??= this.tail.then(async () => {
      try {
        if (this.postgres && !this.failure) {
          const result = await this.postgres.query("UPDATE identity SET owner_id=NULL WHERE id=1 AND installation=$1 AND owner_id=$2", [this.installation, this.ownerId]);
          if (result.rowCount !== 1) throw this.fail();
        }
      } finally {
        try { if (this.sqlite) this.sqlite.close(); else await this.postgres!.end(); }
        finally { this.records.clear(); this.release?.(); }
      }
    });
  }
}
