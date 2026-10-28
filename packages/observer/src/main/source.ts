import { Client, types } from "pg";
import { readFile } from "node:fs/promises";
import { checkServerIdentity } from "node:tls";
import type {
  Connection,
  Probe,
  ReadRequest,
  RawReadRequest,
  Snapshot,
} from "../shared/contracts";
import {
  openRemoteReader,
  openTunnel,
  type RemoteReader,
  type Tunnel,
} from "./transports";
import { readSqlite } from "./sqlite";
import { readRecords } from "./records";
import { project } from "./projection";

export class Source {
  private tunnel?: Tunnel;
  private remote?: RemoteReader;
  private postgres?: Client;
  private failure?: Error;
  private cached?: {
    conversationId?: number;
    limit: number;
    snapshot: Snapshot;
  };
  constructor(
    readonly connection: Connection,
    private password?: string,
  ) {}
  async open(): Promise<Probe> {
    const connection = this.connection;
    try {
      if (connection.kind === "sqlite") {
        if (connection.transport.kind !== "direct")
          this.remote = await openRemoteReader(connection);
        await this.raw({ limit: 1 });
        return {
          stores: [],
          message:
            "The SQLite database is readable. No execution owner was opened.",
        };
      }
      const pg = connection.postgres;
      if (connection.transport.kind !== "direct")
        this.tunnel = await openTunnel(connection.transport, pg.host, pg.port);
      const client = new Client({
        host: this.tunnel ? "127.0.0.1" : pg.host,
        port: this.tunnel?.port ?? pg.port,
        database: pg.database,
        user: pg.user,
        password: this.password,
        ssl:
          pg.tls === "verify"
            ? {
                rejectUnauthorized: true,
                servername: pg.host,
                ...(pg.caFile ? { ca: await readFile(pg.caFile, "utf8") } : {}),
                checkServerIdentity: (_host, cert) =>
                  checkServerIdentity(pg.host, cert),
              }
            : false,
        application_name: "dispatch-observer-readonly",
        connectionTimeoutMillis: 15_000,
        statement_timeout: 30_000,
        options: "-c default_transaction_read_only=on",
        types: {
          getTypeParser: (oid, format) =>
            oid === 20 && format !== "binary"
              ? (value: string) => {
                  const number = Number(value);
                  if (!Number.isSafeInteger(number))
                    throw new Error(
                      "Stored integer exceeds the supported range",
                    );
                  return number;
                }
              : types.getTypeParser(oid, format),
        },
      });
      this.postgres = client;
      client.on("error", (error) => {
        this.failure = error;
      });
      await client.connect();
      const schema = await client.query(
        "SELECT version FROM dispatch_pi.schema_version WHERE singleton=1",
      );
      if (schema.rows[0]?.version !== 1)
        throw new Error(
          "Unsupported Postgres schema. Observer supports dispatch_pi schema 1 and never creates or migrates it.",
        );
      const stores = (
        await client.query(
          pg.storeId
            ? "SELECT store_id FROM dispatch_pi.durable_metadata WHERE store_id=$1"
            : "SELECT store_id FROM dispatch_pi.durable_metadata ORDER BY store_id",
          pg.storeId ? [pg.storeId] : [],
        )
      ).rows.map((row) => String(row.store_id));
      if (pg.storeId && !stores.includes(pg.storeId))
        throw new Error(
          "The selected store is not visible to this database identity.",
        );
      return {
        stores,
        message: `${stores.length} authorized logical ${stores.length === 1 ? "store" : "stores"} available. Transactions are read-only.`,
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async raw(request: RawReadRequest) {
    if (this.failure)
      throw new Error(`Database connection lost: ${this.failure.message}`);
    this.tunnel?.assertHealthy();
    if (this.connection.kind === "sqlite")
      return this.remote
        ? this.remote.read(request)
        : readSqlite(this.connection.path, request);
    const client = this.postgres;
    if (!client) throw new Error("Connect to the database first");
    if (!this.connection.postgres.storeId)
      throw new Error("Select a logical store in the connection settings");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const schema = await client.query(
        "SELECT version FROM dispatch_pi.schema_version WHERE singleton=1",
      );
      if (schema.rows[0]?.version !== 1)
        throw new Error(
          "The Postgres schema changed. Observer supports dispatch_pi schema 1 and never migrates it.",
        );
      return await readRecords(
        {
          table: (name) => `dispatch_pi.${name}`,
          scope: "store_id=$1",
          assistantText: `EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.record::jsonb->'model','[]'::jsonb)) m
            WHERE m->>'role'='assistant' AND (
              (jsonb_typeof(m->'content')='string' AND length(trim(m->>'content'))>0)
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m->'content')='array' THEN m->'content' ELSE '[]'::jsonb END) p
                WHERE p->>'type'='text' AND length(trim(p->>'text'))>0)))`,
          rows: async (sql, ...values) => {
            let index = 1;
            return (
              await client.query(
                sql.replace(/\?/g, () => `$${++index}`),
                [this.connection.postgres.storeId, ...values],
              )
            ).rows;
          },
        },
        request,
      );
    } finally {
      await client.query("ROLLBACK");
    }
  }
  async read(request: ReadRequest) {
    const cached =
      !request.before &&
      this.cached?.conversationId === request.conversationId &&
      this.cached?.limit === request.limit
        ? this.cached
        : undefined;
    const raw = await this.raw({
      ...request,
      since: cached?.snapshot.sequence,
    });
    const snapshot =
      raw.unchanged && cached
        ? { ...cached.snapshot, observedAt: raw.observedAt }
        : {
            ...project(raw, this.connection),
            conversationId: request.conversationId,
          };
    if (!request.before)
      this.cached = {
        conversationId: request.conversationId,
        limit: request.limit,
        snapshot,
      };
    return snapshot;
  }
  async close() {
    this.cached = undefined;
    await this.remote?.close();
    this.remote = undefined;
    await this.postgres?.end().catch(() => {});
    this.postgres = undefined;
    await this.tunnel?.close();
    this.tunnel = undefined;
  }
}
