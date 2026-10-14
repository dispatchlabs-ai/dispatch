import { importSqlite } from "../packages/web/server/storage/import-sqlite.js";

const [snapshot, storeId, ...extra] = process.argv.slice(2);
if (!snapshot || !storeId || extra.length || !process.env.DISPATCH_POSTGRES_URL) {
  console.error("Usage: DISPATCH_POSTGRES_URL=<private environment> npx tsx scripts/import-sqlite.ts SNAPSHOT.sqlite STORE_ID");
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(await importSqlite(snapshot, process.env.DISPATCH_POSTGRES_URL, storeId)));
  } catch {
    // PostgreSQL errors can contain credential-bearing document values.
    console.error("Import failed; target transaction rolled back unless commit outcome was uncertain. Preserve source and target for inspection; do not start the target.");
    process.exitCode = 1;
  }
}
