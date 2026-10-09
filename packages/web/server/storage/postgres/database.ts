import { createHash } from "node:crypto";
import { Client, types } from "pg";
import { verifiedPostgresConfig } from "./tls.js";
import { migrate } from "./migrations.js";
import { verifyWorkerAccess } from "./worker-access.js";

export type PostgresStorageOptions = {
  connectionString: string;
  /** Explicit verified TLS trust; omission preserves legacy local configurations. */
  ca?: string;
  storeId: string;
  /** Only backend-provisioned, RLS-bound workers use this mode; no schema migration privileges. */
  access?: "worker";
};
export type PostgresValue = null | number | string;
export interface PostgresExecutor {
  run(sql: string, ...params: PostgresValue[]): Promise<void>;
  get<T extends object>(sql: string, ...params: PostgresValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: PostgresValue[]): Promise<T[]>;
}

/** One SQL execution scope. $1 is always the store; ? placeholders start at $2. */
class Executor implements PostgresExecutor {
  constructor(private client: Client, private storeId: string, private assertActive: () => void) {}

  async all<T extends object>(sql: string, ...params: PostgresValue[]): Promise<T[]> {
    this.assertActive();
    let index = 1;
    // Only repository-owned SQL uses this helper; no quoted question marks or JSON operators.
    const query = sql.replace(/\?/g, () => `$${++index}`);
    if (index !== params.length + 1) throw new Error("Invalid PostgreSQL parameter count");
    const result = await this.client.query(query, [this.storeId, ...params]);
    return result.rows as T[];
  }
  async get<T extends object>(sql: string, ...params: PostgresValue[]): Promise<T | undefined> {
    return (await this.all<T>(sql, ...params))[0];
  }
  async run(sql: string, ...params: PostgresValue[]): Promise<void> {
    await this.all(sql, ...params);
  }
}

/**
 * One owned connection: all queries/transactions run in admission order. Never reconnect.
 * The advisory lock prevents duplicate storage owners, not external-effect fencing or safe takeover.
 */
export class PostgresDatabase implements PostgresExecutor {
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private failure?: Error;
  private readonly executor: Executor;

  private constructor(private client: Client, private storeId: string) {
    this.executor = new Executor(client, storeId, () => this.assertHealthy());
    client.on("error", error => { this.failure ??= new Error("PostgreSQL storage connection lost; reopen only after stopping the old executor", { cause: error }); });
    client.on("end", () => { this.failure ??= new Error("PostgreSQL storage connection ended"); });
  }

  get healthy(): boolean { return !this.failure && !this.closing; }

  static async open(options: PostgresStorageOptions): Promise<PostgresDatabase> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(options.storeId)) {
      throw new Error("PostgreSQL store ID must be 1–200 ASCII letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit");
    }
    const client = new Client({
      ...(options.ca === undefined ? { connectionString: options.connectionString } : verifiedPostgresConfig(options.connectionString, options.ca)),
      application_name: "dispatch-pi-storage",
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      // Scope decoding to this client; never mutate pg's process-global parsers.
      types: {
        getTypeParser(oid, format) {
          if (oid === 20 && format !== "binary") return (value: string) => {
            const number = Number(value);
            if (!Number.isSafeInteger(number)) {
              throw new Error("PostgreSQL integer exceeds Pi's numeric storage range");
            }
            return number;
          };
          return types.getTypeParser(oid, format);
        },
      },
    });
    const database = new PostgresDatabase(client, options.storeId);
    try {
      await client.connect();
      if (options.access === "worker") await verifyWorkerAccess(client, options.storeId);
      // Fixed 64-bit digest; collisions conservatively reject an unrelated store, never share it.
      const key = createHash("sha256").update(`dispatch-pi-store:${options.storeId}`).digest().readBigInt64BE().toString();
      const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [key]);
      if (!lock.rows[0]?.acquired) throw new Error("This PostgreSQL Pi store already has an owner");
      if (options.access !== "worker") await migrate(client);
      await client.query(
        "INSERT INTO dispatch_pi.durable_metadata (store_id, next_id, next_seq) VALUES ($1, 2, 1) ON CONFLICT (store_id) DO NOTHING",
        [options.storeId],
      );
      database.assertHealthy();
      return database;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }

  private assertHealthy() {
    if (this.failure) throw this.failure;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("PostgreSQL storage is closing"));
    const result = this.tail.then(() => { this.assertHealthy(); return operation(); });
    this.tail = result.catch(() => {});
    return result;
  }

  run(sql: string, ...params: PostgresValue[]): Promise<void> {
    return this.enqueue(() => this.executor.run(sql, ...params));
  }
  get<T extends object>(sql: string, ...params: PostgresValue[]): Promise<T | undefined> {
    return this.enqueue(() => this.executor.get<T>(sql, ...params));
  }
  all<T extends object>(sql: string, ...params: PostgresValue[]): Promise<T[]> {
    return this.enqueue(() => this.executor.all<T>(sql, ...params));
  }

  transaction<T>(callback: (transaction: PostgresExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      let active = true;
      const transaction = new Executor(this.client, this.storeId, () => {
        this.assertHealthy();
        if (!active) throw new Error("PostgreSQL transaction is no longer active");
      });
      let result: T;
      try {
        result = await callback(transaction);
      } catch (error) {
        active = false;
        try {
          await this.client.query("ROLLBACK");
          this.assertHealthy();
        } catch (rollbackError) {
          this.failure = new AggregateError([error, rollbackError], "PostgreSQL rollback failed; storage is unusable");
          throw this.failure;
        }
        // StorageRejected is preserved only after rollback is positively acknowledged.
        throw error;
      }
      active = false;
      try {
        const committed = await this.client.query("COMMIT");
        if (committed.command !== "COMMIT") throw new Error("PostgreSQL did not confirm COMMIT");
        this.assertHealthy();
      } catch (error) {
        // No retries or StorageRejected: COMMIT may already have taken effect.
        this.failure = new Error("PostgreSQL COMMIT outcome is uncertain; storage must be reopened", { cause: error });
        throw this.failure;
      }
      return result;
    });
  }

  close(): Promise<void> {
    // Closing the connection releases the advisory lock only after admitted database work settles.
    this.closing ??= this.tail.then(() => this.client.end());
    return this.closing;
  }
}
