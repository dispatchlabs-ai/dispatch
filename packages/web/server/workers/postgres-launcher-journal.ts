import { randomUUID } from "node:crypto";
import { Client } from "pg";

/** One non-reconnecting controller connection. A durable owner latch survives
 * connection loss: releasing the advisory lock is NOT proof the controller died.
 * Recovery requires an operator-confirmed stopped controller and its exact owner ID.
 */
export class PostgresLauncherJournal {
  private failure?: Error;
  private closing?: Promise<void>;
  private revision = "0";
  private readonly ownerId = randomUUID();
  body = "";

  private constructor(private readonly client: Client, private readonly installationId: string) {
    client.on("error", () => { this.failure ??= new Error("Launcher database connection lost; confirm controller retirement before recovery."); });
    client.on("end", () => { this.failure ??= new Error("Launcher database connection ended."); });
  }

  static async open(options: { connectionString: string; installationId: string; initial: string; recoverOwnerId?: string }) {
    const client = new Client({ connectionString: options.connectionString, connectionTimeoutMillis: 10_000, application_name: "dispatch-launcher-journal" });
    const store = new PostgresLauncherJournal(client, options.installationId);
    try {
      await client.connect();
      // Dedicated control-plane database; never grant workers access to this schema.
      const { rows: [lock] } = await client.query("SELECT pg_try_advisory_lock(1684632432, 3) AS acquired");
      if (!lock?.acquired) throw new Error("Launcher database already has a controller.");
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA IF NOT EXISTS dispatch_launcher;
        REVOKE ALL ON SCHEMA dispatch_launcher FROM PUBLIC;
        CREATE TABLE IF NOT EXISTS dispatch_launcher.journal (
          singleton integer PRIMARY KEY CHECK(singleton=1), installation text NOT NULL,
          body text NOT NULL, revision bigint NOT NULL DEFAULT 0, owner_id uuid);
        REVOKE ALL ON dispatch_launcher.journal FROM PUBLIC`);
      await client.query("INSERT INTO dispatch_launcher.journal(singleton, installation, body) VALUES(1,$1,$2) ON CONFLICT DO NOTHING", [options.installationId, options.initial]);
      const { rows: [row] } = await client.query("SELECT installation, body, revision::text, owner_id FROM dispatch_launcher.journal WHERE singleton=1 FOR UPDATE");
      if (row.installation !== options.installationId) throw new Error("Launcher database belongs to another installation.");
      if (row.owner_id && row.owner_id !== options.recoverOwnerId) throw new Error(`Launcher owner ${row.owner_id} requires confirmed retirement and explicit recovery.`);
      if (options.recoverOwnerId && row.owner_id !== options.recoverOwnerId) throw new Error("Launcher recovery owner does not match persisted owner.");
      await client.query("UPDATE dispatch_launcher.journal SET owner_id=$1 WHERE singleton=1", [store.ownerId]);
      await client.query("COMMIT");
      store.assertHealthy();
      store.body = row.body;
      store.revision = row.revision;
      return store;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      await client.end().catch(() => {});
      // PostgreSQL diagnostics can contain credentials or journal contents.
      if (error instanceof Error && !("code" in error)) throw error;
      throw new Error("Launcher database initialization failed.");
    }
  }

  assertHealthy() {
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error("Launcher database is closing.");
  }

  async save(body: string) {
    this.assertHealthy();
    try {
      const { rows: [row] } = await this.client.query(`UPDATE dispatch_launcher.journal SET body=$1, revision=revision+1
        WHERE singleton=1 AND installation=$2 AND owner_id=$3 AND revision=$4 RETURNING revision::text`,
      [body, this.installationId, this.ownerId, this.revision]);
      if (!row) throw new Error("Launcher journal ownership/version changed.");
      this.assertHealthy();
      this.revision = row.revision;
      this.body = body;
    } catch {
      this.failure ??= new Error("Launcher journal write uncertain; confirm controller retirement before recovery.");
      throw this.failure;
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        // Called only after launcher queue/effects settle. Never clear a failed owner's latch.
        if (!this.failure) {
          const result = await this.client.query("UPDATE dispatch_launcher.journal SET owner_id=NULL WHERE singleton=1 AND installation=$1 AND owner_id=$2", [this.installationId, this.ownerId]);
          if (result.rowCount !== 1) throw new Error("Launcher owner changed while closing.");
        }
      } finally { await this.client.end(); }
    })();
    return this.closing;
  }
}
