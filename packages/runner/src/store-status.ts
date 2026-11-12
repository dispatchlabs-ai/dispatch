import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** Open a store without writing beside it: SQLite treats a store with no pending log as immutable, so it creates no sidecar files. */
export function openStore(path: string) {
  const location = pathToFileURL(path);
  if (!statSync(`${path}-wal`, { throwIfNoEntry: false })?.size) location.searchParams.set("immutable", "1");
  return new DatabaseSync(location, { readOnly: true });
}

/** Store files under a closed state root that hold unfinished work, by Runner's own definition of busy. Read-only. */
export function unfinishedStores(root: string, skip: string[] = []): string[] {
  const found: string[] = [];
  const walk = (directory: string, depth: number) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < 4 && !entry.name.startsWith(".") && entry.name !== "artifacts" && !skip.includes(path)) walk(path, depth + 1);
      if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
      try {
        const db = openStore(path);
        try {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()) continue;
          // A calendar schedule asleep until its next occurrence is not work in progress.
          const pending = db.prepare(`SELECT (SELECT count(*) FROM tasks WHERE status<>'terminal' AND NOT (status='sleeping' AND kind LIKE '%.calendar-schedule'))
            + (SELECT count(*) FROM submissions WHERE status IN ('queued','placed')) AS n`).get() as { n: number };
          if (pending.n) found.push(path);
        } finally { db.close(); }
      } catch { found.push(`${path} (unreadable)`); }
    }
  };
  if (existsSync(root)) walk(root, 0);
  return found;
}
