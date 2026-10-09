import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { AUTH_SCHEMA } from "./schema.js";

export type AuthValue = SQLInputValue;

/** A connection queue keeps unrelated requests outside an awaited transaction. */
export abstract class AsyncAuthStore {
  private readonly context = new AsyncLocalStorage<{ active: boolean }>();
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  protected failure?: Error;

  protected abstract execute(sql: string, parameters: AuthValue[]): Promise<{ rows: unknown[]; changes: number }>;
  protected abstract begin(): Promise<void>;
  protected abstract commit(): Promise<void>;
  protected abstract rollback(): Promise<void>;
  protected abstract disconnect(): Promise<void>;

  get healthy(): boolean { return !this.failure && !this.closing; }

  protected assertHealthy(): void { if (this.failure) throw this.failure; }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    const context = this.context.getStore();
    if (context) {
      if (!context.active) return Promise.reject(new Error("Authentication transaction has ended"));
      this.assertHealthy();
      return operation();
    }
    if (this.closing) return Promise.reject(new Error("Authentication store is closing"));
    const result = this.tail.then(async () => {
      this.assertHealthy();
      await this.begin();
      const scope = { active: true };
      let value: T;
      try {
        value = await this.context.run(scope, operation);
      } catch (error) {
        scope.active = false;
        try { await this.rollback(); }
        catch (rollbackError) {
          this.failure = new AggregateError([error, rollbackError], "Authentication rollback failed; reopen the store");
          throw this.failure;
        }
        throw error;
      }
      scope.active = false;
      try { await this.commit(); this.assertHealthy(); }
      catch (error) {
        this.failure = new Error("Authentication commit outcome is uncertain; reopen the store without retrying the operation", { cause: error });
        throw this.failure;
      }
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }

  async one<T>(sql: string, ...parameters: AuthValue[]): Promise<T | undefined> {
    return (await this.all<T>(sql, ...parameters))[0];
  }
  all<T>(sql: string, ...parameters: AuthValue[]): Promise<T[]> {
    return this.transaction(async () => (await this.execute(sql, parameters)).rows as T[]);
  }
  run(sql: string, ...parameters: AuthValue[]): Promise<number> {
    return this.transaction(async () => (await this.execute(sql, parameters)).changes);
  }
  close(): Promise<void> {
    return this.closing ??= this.tail.then(() => this.disconnect());
  }
}

export class AuthStore extends AsyncAuthStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    super();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec(`PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; ${AUTH_SCHEMA}`);
  }
  protected async execute(sql: string, parameters: AuthValue[]) {
    const statement = this.database.prepare(sql);
    if (/^\s*SELECT\b/i.test(sql)) return { rows: statement.all(...parameters), changes: 0 };
    return { rows: [], changes: Number(statement.run(...parameters).changes) };
  }
  protected async begin() { this.database.exec("BEGIN IMMEDIATE"); }
  protected async commit() { this.database.exec("COMMIT"); }
  protected async rollback() { this.database.exec("ROLLBACK"); }
  protected async disconnect() { this.database.close(); }
}
