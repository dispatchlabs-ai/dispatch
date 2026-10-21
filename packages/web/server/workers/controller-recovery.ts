import { parseArgs } from "node:util";
import { Client } from "pg";
import { readRestrictedConfigurationFile } from "../storage/restricted-config-file.js";
import { verifiedPostgresConfig } from "../storage/postgres/tls.js";
import { readRoutingStoreConfig } from "./routing-config.js";
import { controllerDiscoverySchema, recoverControllerRendezvous } from "./controller-rendezvous.js";

/** Operator-only CLI, never a startup action. Config has the same restricted-file
 * shape as routing config but points to the selected controller's own database.
 */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, strict: true,
    options: {
      config: { type: "string" }, role: { type: "string" }, expected: { type: "string" },
      "confirm-controllers-stopped": { type: "boolean" },
    },
  });
  const [command] = positionals;
  if (positionals.length !== 1 || !["inspect", "recover"].includes(command)
    || !values.config?.startsWith("/") || !["backend", "launcher"].includes(values.role ?? ""))
    throw new Error("Invalid controller recovery arguments.");
  if (command === "recover" && (!values.expected?.startsWith("/") || values["confirm-controllers-stopped"] !== true))
    throw new Error("Recovery requires a restricted expected snapshot and confirmed stopped controllers.");
  if (command === "inspect" && (values.expected || values["confirm-controllers-stopped"]))
    throw new Error("Inspect does not accept recovery arguments.");
  const config = await readRoutingStoreConfig(values.config);
  const url = await readRestrictedConfigurationFile(config.databaseUrlFile, true);
  try {
    const ca = (await readRestrictedConfigurationFile(config.databaseCaFile, false)).toString("utf8");
    const database = verifiedPostgresConfig(url.toString("utf8").trim(), ca);
    if (command === "recover") {
      const expected = controllerDiscoverySchema.parse(JSON.parse((await readRestrictedConfigurationFile(values.expected!, false)).toString("utf8")));
      if (expected.owner.installationId !== config.installationId || expected.owner.role !== values.role)
        throw new Error("Expected recovery identity differs from the selected installation or role.");
      await recoverControllerRendezvous({ database, expected, confirmControllersStopped: true });
      console.log("Controller rendezvous cleared. Existing store latches are unchanged; reconcile them before normal startup.");
      return;
    }
    const client = new Client({ ...database, connectionTimeoutMillis: 60_000, application_name: "dispatch-controller-inspect" });
    let failed = false;
    client.on("error", () => { failed = true; });
    try {
      await client.connect();
      const { rows: [row] } = await client.query("SELECT owner, phase, successor FROM dispatch_controller.owners WHERE installation=$1 AND role=$2", [config.installationId, values.role]);
      const discovery = row ? controllerDiscoverySchema.parse(row) : null;
      if (failed) throw new Error("Controller inspection connection failed.");
      if (discovery && (discovery.owner.installationId !== config.installationId || discovery.owner.role !== values.role))
        throw new Error("Persisted controller identity differs from its installation or role.");
      console.log(JSON.stringify(discovery, null, 2));
    } finally { await client.end(); }
  } finally { url.fill(0); }
}

try { await main(); }
catch {
  // No raw PostgreSQL diagnostics, connection strings, or configuration contents.
  console.error("Controller inspection/recovery failed or is uncertain. Check arguments, restricted files, stopped controllers and a fresh exact snapshot; do not blindly retry recovery.");
  process.exitCode = 1;
}
