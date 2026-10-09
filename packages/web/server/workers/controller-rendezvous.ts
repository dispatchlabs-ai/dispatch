import { randomUUID } from "node:crypto";
import { Client, type ClientConfig } from "pg";
import { z } from "zod";

export const controllerIdentitySchema = z.object({
  installationId: z.string().min(1).max(200),
  role: z.enum(["backend", "launcher"]),
  instanceId: z.string().uuid(),
  endpoint: z.string().url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && url.pathname === "/" && !url.search && !url.hash;
  }, "Controller endpoint must be an HTTP(S) origin without credentials"),
}).strict();
export type ControllerIdentity = Readonly<z.infer<typeof controllerIdentitySchema>>;
export type ControllerDiscovery = Readonly<{
  owner: ControllerIdentity;
  phase: "starting" | "ready" | "releasing" | "released";
  successor: ControllerIdentity | null;
}>;
export const controllerDiscoverySchema = z.object({
  owner: controllerIdentitySchema,
  phase: z.enum(["starting", "ready", "releasing", "released"]),
  successor: controllerIdentitySchema.nullable(),
});

/** Planned transfer only. A durable owner record never expires. Connection loss,
 * an absent peer, or an available store lock cannot authorize another owner.
 * Existing stores still enforce their own ownership and recovery latches.
 */
export class ControllerRendezvous {
  readonly identity: ControllerIdentity;
  private failure?: Error;
  private closing?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private transfer?: { target: ControllerIdentity | null; promise: Promise<void> };

  private constructor(private readonly client: Client, identity: ControllerIdentity) {
    this.identity = Object.freeze(identity);
    client.on("error", () => { this.fail(); });
    client.on("end", () => { if (!this.closing) this.fail(); });
  }

  static async open(options: {
    database: ClientConfig; installationId: string;
    role: ControllerIdentity["role"]; endpoint: string;
  }): Promise<ControllerRendezvous> {
    const identity = controllerIdentitySchema.parse({
      installationId: options.installationId, role: options.role,
      instanceId: randomUUID(), endpoint: options.endpoint,
    });
    identity.endpoint = new URL(identity.endpoint).origin;
    const client = new Client({ ...options.database, connectionTimeoutMillis: 10_000, application_name: "dispatch-controller-rendezvous" });
    const rendezvous = new ControllerRendezvous(client, identity);
    try {
      await client.connect();
      await rendezvous.serial(async () => {
        const { rows: [lock] } = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held", [instanceLock(identity)]);
        if (!lock?.held) throw new Error("Controller instance is already connected.");
        // Serialize schema creation across the overlapping processes as well.
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(1684632432, 8)");
        await client.query(`CREATE SCHEMA IF NOT EXISTS dispatch_controller;
          REVOKE ALL ON SCHEMA dispatch_controller FROM PUBLIC;
          CREATE TABLE IF NOT EXISTS dispatch_controller.owners (
            installation text NOT NULL, role text NOT NULL CHECK (role IN ('backend', 'launcher')),
            owner jsonb NOT NULL, phase text NOT NULL CHECK (phase IN ('starting', 'ready', 'releasing', 'released')),
            successor jsonb,
            PRIMARY KEY (installation, role),
            CHECK ((phase IN ('starting', 'ready') AND successor IS NULL)
              OR phase='releasing' OR (phase='released' AND successor IS NOT NULL))
          );
          REVOKE ALL ON dispatch_controller.owners FROM PUBLIC`);
        await client.query("COMMIT");
      });
      return rendezvous;
    } catch {
      await client.end().catch(() => {});
      throw new Error("Cannot open controller rendezvous; check database access and installation configuration.");
    }
  }

  /** Returns discovery, not proof that an HTTP path is ready or authenticated. */
  discover(): Promise<ControllerDiscovery | null> {
    this.assertOpen();
    return this.serial(async () => {
      const { rows: [row] } = await this.client.query(
        "SELECT owner, phase, successor FROM dispatch_controller.owners WHERE installation=$1 AND role=$2", this.key());
      if (!row) return null;
      const discovery = controllerDiscoverySchema.parse(row);
      this.requireScope(discovery.owner);
      if (discovery.successor) this.requireScope(discovery.successor);
      return discovery;
    });
  }

  /** Call before opening ANY exclusive store. True permits opening fresh state,
   * not serving traffic; markReady follows successful application startup.
   * A released row is claimable only by its named successor, never a restarted
   * process with another UUID. A crash requires explicit operator reconciliation.
   */
  claim(): Promise<boolean> {
    this.assertOpen();
    if (this.transfer) return Promise.resolve(false);
    return this.serial(async () => {
      await this.client.query("BEGIN");
      await this.client.query(`INSERT INTO dispatch_controller.owners (installation, role, owner, phase)
        VALUES ($1,$2,$3,'starting') ON CONFLICT DO NOTHING`, [...this.key(), this.identity]);
      const { rows: [row] } = await this.client.query(`SELECT owner, phase, successor FROM dispatch_controller.owners
        WHERE installation=$1 AND role=$2 FOR UPDATE`, this.key());
      const discovery = controllerDiscoverySchema.parse(row);
      this.requireScope(discovery.owner);
      if (discovery.successor) this.requireScope(discovery.successor);
      let claimed = sameIdentity(discovery.owner, this.identity) && ["starting", "ready"].includes(discovery.phase);
      if (discovery.phase === "released" && discovery.successor && sameIdentity(discovery.successor, this.identity)) {
        await this.client.query(`UPDATE dispatch_controller.owners SET owner=$3, phase='starting', successor=NULL
          WHERE installation=$1 AND role=$2`, [...this.key(), this.identity]);
        claimed = true;
      }
      await this.client.query("COMMIT");
      return claimed;
    });
  }

  markReady(): Promise<void> {
    this.assertOpen();
    if (this.transfer) return Promise.reject(new Error("Controller is retiring."));
    return this.serial(async () => {
      const result = await this.client.query(`UPDATE dispatch_controller.owners SET phase='ready'
        WHERE installation=$1 AND role=$2 AND owner=$3::jsonb AND phase IN ('starting','ready')`, [...this.key(), this.identity]);
      if (result.rowCount !== 1) throw new Error("Controller does not own ready publication.");
    });
  }

  /** Caller authenticates the target instance and its direct endpoint first.
   * closeOwned must permanently seal local admission, join ALL admitted effects,
   * and close every exclusive store without draining conversation workers.
   * Throwing/uncertain close retains phase=releasing; the callback is never retried.
   * Completion publishes permission to claim, NOT successor readiness. Keep the old
   * listener until the exact successor is observed ready and forwarding works.
   * A null target means clean shutdown/startup cleanup: remove the row only after
   * the same successful close, allowing a later cold start without recovery flags.
   */
  handover(target: ControllerIdentity | null, closeOwned: () => Promise<void>): Promise<void> {
    this.assertOpen();
    const candidate = target === null ? null : controllerIdentitySchema.parse(target);
    if (candidate) {
      candidate.endpoint = new URL(candidate.endpoint).origin;
      this.requireScope(candidate);
      if (candidate.instanceId === this.identity.instanceId || candidate.endpoint === this.identity.endpoint)
        return Promise.reject(new Error("Handover requires a distinct controller instance and direct endpoint."));
    }
    if (this.transfer) {
      if (!sameTarget(this.transfer.target, candidate)) return Promise.reject(new Error("Another controller handover is already selected."));
      return this.transfer.promise;
    }
    const promise = this.serial(async () => {
      const result = await this.client.query(`UPDATE dispatch_controller.owners SET phase='releasing', successor=$4
        WHERE installation=$1 AND role=$2 AND owner=$3::jsonb
          AND (phase='ready' OR (phase='starting' AND $4::jsonb IS NULL))`, [...this.key(), this.identity, candidate]);
      if (result.rowCount !== 1) throw new Error("Controller cannot begin handover.");
    }).then(async () => {
      // No open SQL transaction or query queue held while joining application work.
      await closeOwned();
      await this.serial(async () => {
        const result = await this.client.query(`${candidate ? "UPDATE dispatch_controller.owners SET phase='released'" : "DELETE FROM dispatch_controller.owners"}
          WHERE installation=$1 AND role=$2 AND owner=$3::jsonb AND phase='releasing' AND successor IS NOT DISTINCT FROM $4::jsonb`,
        [...this.key(), this.identity, candidate]);
        if (result.rowCount !== 1) throw new Error("Controller release publication failed.");
      });
    }).catch(() => { throw this.fail(); });
    this.transfer = { target: candidate && Object.freeze(candidate), promise };
    return promise;
  }

  /** Disconnect only; never clear an owner or release another process's latch.
   * This also cannot turn an unsuccessful startup into a claimable vacancy.
   */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (this.transfer) await this.transfer.promise.catch(() => {});
      await this.tail;
      await this.client.end();
    })();
  }

  private key() { return [this.identity.installationId, this.identity.role]; }
  private requireScope(identity: ControllerIdentity) {
    if (identity.installationId !== this.identity.installationId || identity.role !== this.identity.role)
      throw new Error("Controller identity belongs to another installation or role.");
  }
  private fail() {
    return this.failure ??= new Error("Controller ownership is uncertain; automatic takeover is disabled. Reconcile the retained owner before recovery.");
  }
  private assertOpen() {
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error("Controller rendezvous is closing.");
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      try {
        const value = await operation();
        if (this.failure) throw this.failure;
        return value;
      } catch {
        this.fail();
        await this.client.query("ROLLBACK").catch(() => {});
        throw this.failure;
      }
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

function sameIdentity(a: ControllerIdentity, b: ControllerIdentity) {
  return a.installationId === b.installationId && a.role === b.role
    && a.instanceId === b.instanceId && a.endpoint === b.endpoint;
}

function sameTarget(a: ControllerIdentity | null, b: ControllerIdentity | null) {
  return a === null || b === null ? a === b : sameIdentity(a, b);
}
function instanceLock(identity: ControllerIdentity) {
  return `dispatch-controller-instance:${JSON.stringify([identity.installationId, identity.role, identity.instanceId])}`;
}

/** Invocation-only stopped-controller recovery. The assertion is operator evidence,
 * not automatic fencing. Hold both the owner and named successor stopped, with
 * their supervisors disabled. Connected-instance locks are an additional refusal,
 * never sufficient evidence of retirement. Existing store latches are untouched.
 */
export async function recoverControllerRendezvous(options: {
  database: ClientConfig; expected: ControllerDiscovery; confirmControllersStopped: true;
}): Promise<void> {
  if (options.confirmControllersStopped !== true) throw new Error("Confirmed controller retirement is required.");
  const expected = controllerDiscoverySchema.parse(options.expected);
  if (expected.successor && (expected.successor.installationId !== expected.owner.installationId || expected.successor.role !== expected.owner.role))
    throw new Error("Recovery identities must belong to the same installation and role.");
  const client = new Client({ ...options.database, connectionTimeoutMillis: 10_000, application_name: "dispatch-controller-recovery" });
  let failed = false;
  client.on("error", () => { failed = true; });
  try {
    await client.connect();
    await client.query("BEGIN");
    for (const identity of [expected.owner, ...(expected.successor ? [expected.successor] : [])]) {
      const { rows: [lock] } = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS held", [instanceLock(identity)]);
      if (!lock?.held) throw new Error("A controller instance is still connected.");
    }
    const result = await client.query(`DELETE FROM dispatch_controller.owners
      WHERE installation=$1 AND role=$2 AND owner=$3::jsonb AND phase=$4 AND successor IS NOT DISTINCT FROM $5::jsonb`,
    [expected.owner.installationId, expected.owner.role, expected.owner, expected.phase, expected.successor]);
    if (result.rowCount !== 1 || failed) throw new Error("Retained controller state changed or recovery connection failed.");
    await client.query("COMMIT");
    if (failed) throw new Error("Controller recovery result is uncertain.");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Controller recovery failed or is uncertain; inspect the retained state again. Never retry without checking stopped instances and the exact snapshot.");
  } finally { await client.end(); }
}
