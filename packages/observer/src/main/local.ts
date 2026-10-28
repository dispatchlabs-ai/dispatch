import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { Connection, LocalWork } from "../shared/contracts";
import { readSqlite } from "./sqlite";
import { project, redact } from "./projection";

const exec = promisify(execFile);
const identities = new Map<string, string>();

/** Discover open writable files, not stale saved tasks or a filesystem crawl. */
export async function localWork(): Promise<LocalWork> {
  if (process.platform === "win32")
    throw new Error(
      "Local discovery currently needs macOS or Linux with lsof. Use Add connection to open a store.",
    );
  let output: string;
  try {
    const result = await exec(
      process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      ["-n", "-P", "-a", "-u", String(process.getuid!()), "-F", "pfan"],
      { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
    );
    output = result.stdout;
  } catch {
    throw new Error(
      "Could not inspect local processes. Check that lsof is available, or use Add connection.",
    );
  }
  const paths = new Map<string, Set<number>>();
  let pid = 0;
  let access = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("f")) access = "";
    else if (line.startsWith("a")) access = line.slice(1);
    else if (
      line.startsWith("n/") &&
      (access === "u" || access === "w") &&
      /\.(sqlite3?|db)$/.test(line)
    ) {
      const path = line.slice(1);
      const owners = paths.get(path) ?? new Set<number>();
      owners.add(pid);
      paths.set(path, owners);
    }
  }
  const stores: LocalWork["stores"] = [];
  const issues: string[] = [];
  for (const [path, owners] of paths) {
    // Identify Pi before loading records; unrelated application databases are ignored.
    let db: DatabaseSync | undefined;
    let pi = false;
    try {
      db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      pi = Boolean(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='durable_schema'",
          )
          .get(),
      );
    } catch {
      continue;
    } finally {
      db?.close();
    }
    if (!pi) continue;
    const id = identities.get(path) ?? randomUUID();
    identities.set(path, id);
    const connection: Connection = {
      id,
      name: basename(dirname(path)).replace(/[-_]/g, " "),
      kind: "sqlite",
      transport: { kind: "direct" },
      path,
      postgres: {
        host: "localhost",
        port: 5432,
        database: "postgres",
        user: "postgres",
        storeId: "",
        tls: "verify",
        caFile: "",
      },
    };
    try {
      let snapshot = project(await readSqlite(path, { limit: 1 }), connection);
      // Session documents can supply the integration's human-authored chat titles.
      const first = snapshot.conversations[0];
      if (first)
        snapshot = project(
          await readSqlite(path, { conversationId: first.id, limit: 1 }),
          connection,
        );
      stores.push({
        connection,
        pids: [...owners],
        conversations: snapshot.conversations,
      });
    } catch (error) {
      issues.push(
        `${connection.name}: ${redact(error instanceof Error ? error.message : "Could not read store")}`,
      );
    }
  }
  stores.sort(
    (a, b) =>
      Number(b.conversations.some((c) => c.active > 0)) -
        Number(a.conversations.some((c) => c.active > 0)) ||
      a.connection.name.localeCompare(b.connection.name) ||
      a.connection.path.localeCompare(b.connection.path),
  );
  return { observedAt: new Date().toISOString(), stores, issues };
}
