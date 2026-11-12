#!/usr/bin/env node
import { parseArgs } from "node:util";
import { converge, inventory, preflight, readDeclaration, restore, status, type Receipt } from "./upgrade.js";

const usage = `dispatch-upgrade status    --declaration MACHINE.json [--json]
dispatch-upgrade preflight --declaration MACHINE.json [--backup] [--json]
dispatch-upgrade backup    --declaration MACHINE.json [--json]
dispatch-upgrade converge  --declaration MACHINE.json [--backup] [--json]
dispatch-upgrade restore   --from BACKUP [--to STATE_ROOT]
dispatch-upgrade inventory --declaration MACHINE.json

status, preflight and inventory change nothing. backup closes each declared state root, copies and
verifies it, and reopens it. converge moves every declared consumer to its selected release, takes
that backup first whenever the Pi Durable version changes (or with --backup), removes what the
selection supersedes and fails unless nothing installed or running can load another Pi Durable.
--system-inventory FILE supplies the inventory output of a privileged run for services this user
cannot read. Receipts and backups are kept under the declaration's stateDirectory.`;

const lines = (title: string, items: string[]) => items.length ? [`${title}:`, ...items.map(item => `  ${item}`)] : [];
function report(receipt: Receipt) {
  const refused = receipt.problems.length > 0;
  return [
    `Selected Pi Durable: ${receipt.piDurable ?? "none"}`,
    ...receipt.selected.map(item => `  ${item.name} ${item.revision?.slice(0, 12) ?? "?"}: Dispatch ${item.dispatch?.version ?? "?"} (${item.dispatch?.revision.slice(0, 12) ?? "?"})`),
    ...lines(refused ? "Not ready; nothing was changed" : "Problems", receipt.problems),
    ...(receipt.mode === "preflight" ? (receipt.planned.length ? lines("Would move", receipt.planned) : ["Nothing would move."])
      : refused ? [] : receipt.changed.length ? lines("Changed", receipt.changed) : ["No changes."]),
    ...lines("Retained", receipt.retained.map(item => `${item.path}: ${item.why}`)),
    ...lines("Not inspected", receipt.uninspected),
    ...lines("Failed", receipt.failures),
    ...(receipt.receipt ? [`Receipt: ${receipt.receipt}`] : []),
  ].join("\n");
}

function overview(found: Awaited<ReturnType<typeof status>>) {
  const out: string[] = [];
  for (const release of found.selected) {
    out.push(`${release.name}  revision ${release.revision ?? "unknown"}`,
      `  package     ${release.package}`,
      `  Dispatch    ${release.dispatch?.version ?? "unknown"} (${release.dispatch?.revision ?? "unknown"})`,
      `  Pi Durable  ${release.piDurable ?? "unknown"}    kit ${release.kit ?? "absent"}    eval ${release.eval ?? "absent"}`);
    for (const companion of release.companions) out.push(`  companion   ${companion.name}: ${companion.package} (Pi Durable ${companion.piDurable.join(", ") || "none"})`);
    for (const consumer of found.declaration.filter(item => item.release === release.name)) {
      out.push(`  consumer    ${consumer.label}`);
      const profile = found.profiles.find(item => item.path === consumer.profile);
      if (profile) out.push(`    profile     ${profile.path}: ${profile.current === profile.package ? "selects this release" : `selects ${profile.current ?? "nothing"}`}`);
      const service = found.services.find(item => item.consumer === consumer.label);
      if (consumer.supervision) out.push(`    service     ${consumer.supervision.unit}: ${!service ? "not installed" : [service.enabled ? "enabled" : "disabled",
        service.running ? `running (pid ${service.pid})` : "not running", `Pi Durable ${service.piDurable.join(", ") || "none"}`,
        ...(service.superseded.length ? [`names superseded ${service.superseded.join(", ")}`] : [])].join(", ")}`);
      const root = found.stateRoots.find(item => item.root === consumer.stateRoot);
      const owners = found.owners.filter(item => item.root === consumer.stateRoot);
      if (root) out.push(`    state root  ${root.root}: ${root.exists ? `Pi Durable ${root.recorded ?? "not recorded"}` : "not created"}, ${owners.length} session owner(s) running${
        owners.some(item => item.superseded.length) ? `, ${owners.filter(item => item.superseded.length).length} on an earlier release` : ""}`);
    }
  }
  const others = found.services.filter(item => !item.consumer && item.piDurable.length);
  out.push(...lines("Other installed services that load Pi Durable", others.map(item => `${item.unit}: ${item.running ? "running" : "not running"}, Pi Durable ${item.piDurable.join(", ")}`)),
    `Other running processes that load Pi Durable: ${found.otherProcesses}`,
    ...lines("Attention", found.failures), ...lines("Not inspected", found.uninspected),
    found.lastConverge ? `Last converge: ${found.lastConverge.at}, ${found.lastConverge.changed} change(s), ${found.lastConverge.failures} failure(s), ${found.lastConverge.retained} retained (${found.lastConverge.receipt})` : "Last converge: none recorded",
    ...lines("Last backup", (found.lastBackup ?? []).map(item => `${item.root} -> ${item.path}`)));
  return out.join("\n");
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    declaration: { type: "string" }, json: { type: "boolean" }, backup: { type: "boolean" }, "system-inventory": { type: "string" },
    from: { type: "string" }, to: { type: "string" }, help: { type: "boolean" } } });
  const [mode] = positionals;
  if (values.help) console.log(usage);
  else if (mode === "restore" && values.from) console.log(JSON.stringify(await restore(values.from, values.to), null, 1));
  else if (positionals.length !== 1 || !values.declaration || !["status", "preflight", "backup", "converge", "inventory"].includes(mode)) throw new Error(usage);
  else {
    const declaration = readDeclaration(values.declaration), options = { backup: values.backup, systemInventory: values["system-inventory"] };
    if (mode === "inventory") console.log(JSON.stringify(await inventory(declaration)));
    else if (mode === "status") { const found = await status(declaration, options); console.log(values.json ? JSON.stringify(found, null, 1) : overview(found)); }
    else {
      const receipt = mode === "preflight" ? await preflight(declaration, options) : await converge(declaration, { ...options, only: mode === "backup" ? "backup" : undefined });
      console.log(values.json ? JSON.stringify(receipt, null, 1) : report(receipt));
      if (receipt.problems.length || receipt.failures.length) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 2;
}
