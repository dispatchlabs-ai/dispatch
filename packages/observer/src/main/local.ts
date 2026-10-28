import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, realpath, lstat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { Connection, LocalWork } from "../shared/contracts";
import { readSqlite } from "./sqlite";
import { project, redact } from "./projection";

const exec = promisify(execFile);
const identities = new Map<string, string>();

/** Discover agent-runtime writable files, not OS application databases. Other
 * hosts remain reachable through saved sources without a filesystem crawl. */
export async function localWork(saved: Connection[]): Promise<LocalWork> {
  const issues: string[] = [];
  let output = "";
  if (process.platform === "win32") {
    issues.push(
      "Local process discovery is not available on Windows. Showing saved local sources.",
    );
  } else {
    try {
      const result = await exec(
        process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
        ["-n", "-P", "-a", "-u", String(process.getuid!()), "-F", "pcfan"],
        { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
      );
      output = result.stdout;
    } catch {
      issues.push(
        "Could not inspect local processes. Showing saved local sources; check that lsof is available.",
      );
    }
  }
  const paths = new Map<string, Set<number>>();
  let pid = 0;
  let access = "";
  let runtime = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      runtime = false;
    } else if (line.startsWith("c"))
      runtime = /^(?:node|bun|deno|pi|dispatch|electron)(?:$|[ ._-])/i.test(
        line.slice(1),
      );
    else if (line.startsWith("f")) access = "";
    else if (line.startsWith("a")) access = line.slice(1);
    else if (
      runtime &&
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
  const canonicalPath = async (path: string) =>
    realpath(path).catch(() => path);
  for (const [path, owners] of [...paths]) {
    const canonical = await canonicalPath(path);
    if (canonical === path) continue;
    paths.delete(path);
    paths.set(canonical, new Set([...(paths.get(canonical) ?? []), ...owners]));
  }
  const savedByPath = new Map<string, Connection>();
  for (const connection of saved)
    if (connection.kind === "sqlite" && connection.transport.kind === "direct")
      savedByPath.set(await canonicalPath(connection.path), connection);
  for (const path of savedByPath.keys())
    if (!paths.has(path)) paths.set(path, new Set());
  const stores: LocalWork["stores"] = [];
  const scanned = new Set<string>();
  const siblingNamespaces = new Map<string, Set<string>>();
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
    } catch (error) {
      if (savedByPath.has(path) || siblingNamespaces.has(path))
        issues.push(
          `${savedByPath.get(path)?.name ?? basename(dirname(path))}: ${redact(error instanceof Error ? error.message : "Could not read source")}`,
        );
      continue;
    } finally {
      db?.close();
    }
    if (!pi) {
      if (savedByPath.has(path) || siblingNamespaces.has(path))
        issues.push(
          `${savedByPath.get(path)?.name ?? basename(dirname(path))}: Not a supported Pi store.`,
        );
      continue;
    }
    const id = identities.get(path) ?? randomUUID();
    identities.set(path, id);
    const connection: Connection = savedByPath.get(path) ?? {
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
      const snapshot = project(
        await readSqlite(path, { limit: 1 }),
        connection,
      );
      const runner =
        basename(path) === "session.sqlite" &&
        snapshot.conversations.some(
          (c) => c.agent === basename(dirname(path)) && c.namespace,
        );
      const expected = siblingNamespaces.get(path);
      if (
        expected &&
        (!runner ||
          !snapshot.conversations.some(
            (c) => c.namespace && expected.has(c.namespace),
          ))
      ) {
        issues.push(
          `${connection.name}: Sibling store does not match this Runner installation.`,
        );
        continue;
      }
      // A validated Runner store establishes its installation directory. Inspect
      // only immediate sibling agent/session.sqlite files, never transcript paths.
      if (runner) {
        const root = await realpath(dirname(dirname(path)));
        if (!scanned.has(root)) {
          scanned.add(root);
          try {
            for (const child of await readdir(root, {
              withFileTypes: true,
            })) {
              if (!child.isDirectory() || child.isSymbolicLink()) continue;
              const sibling = join(root, child.name, "session.sqlite");
              try {
                const stat = await lstat(sibling);
                if (!stat.isFile() || stat.isSymbolicLink()) continue;
                if (!paths.has(sibling)) {
                  paths.set(sibling, new Set());
                  siblingNamespaces.set(
                    sibling,
                    new Set(
                      snapshot.conversations.flatMap((c) =>
                        c.namespace ? [c.namespace] : [],
                      ),
                    ),
                  );
                }
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                  issues.push(
                    `${child.name}: Could not inspect sibling store.`,
                  );
              }
            }
          } catch {
            issues.push(
              `${connection.name}: Could not discover sibling Runner stores.`,
            );
          }
        }
      }
      stores.push({
        connection,
        scope: runner ? await realpath(dirname(dirname(path))) : path,
        pids: [...owners],
        conversations: snapshot.conversations,
        handoffs: snapshot.handoffs,
        documents: snapshot.documents.filter(
          (doc) => doc.kind === "observer.workflow",
        ),
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
