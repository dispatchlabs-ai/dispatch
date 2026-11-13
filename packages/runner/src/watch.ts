import { readHostConfig } from "./local-host.js";
import { parseArgs } from "node:util";
import { discoverWatchRuns, isWatchSessionKey, readWatchRun } from "./watch-reader.js";
import { terminalText } from "./terminal-output.js";
import type { WatchOptions } from "./watch-types.js";

const usage = `dispatch-watch --config HOST.json [--session KEY] [--json]

Discover local running sessions and inspect their saved activity without starting
or controlling agents. --session also opens saved work with no observed process;
use a relative directory, or . for agents directly under the configured stateRoot.
--json prints one observation. Redirected output prints a plain-text observation.
In the viewer: arrows select, Enter inspects, Esc goes back, q or Ctrl+C quits.
Quitting the viewer leaves the agents running.`;

export async function watchCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: "string" }, session: { type: "string" }, json: { type: "boolean" },
    root: { type: "string" }, "release-manifest": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(usage); return; }
  if (positionals.length || !values.config) throw new Error(usage);
  if (values.session !== undefined && !isWatchSessionKey(values.session)) {
    throw new Error("Invalid session key.");
  }
  const { stateRoot, namespace } = await readHostConfig(values.config);
  if (namespace !== undefined && typeof namespace !== "string") throw new Error("namespace must be a string.");
  const options: WatchOptions = { stateRoot, namespace, session: values.session };
  if (values.json || !process.stdin.isTTY || !process.stdout.isTTY) {
    const discovery = await discoverWatchRuns(options);
    const snapshots = await Promise.all(discovery.runs.map(run => readWatchRun(run)));
    if (values.json) console.log(JSON.stringify({ observedAt: new Date().toISOString(),
      runs: snapshots, issues: discovery.issues }, null, 2));
    else {
      const lines = snapshots.flatMap(snapshot => [
        `${snapshot.run.session} · ${snapshot.run.pids.length ? "owner observed" : "no process observed"}`,
        ...snapshot.conversations.map(c => `  ${c.key} · ${c.status} · ${c.activity || c.title}`),
        ...snapshot.issues.map(issue => `  Notice: ${issue}`), "",
      ]);
      console.log(terminalText([...discovery.issues.map(issue => `Notice: ${issue}`),
        ...(lines.length ? lines : ["No running sessions found."]),
        "Open watch in a terminal for the interactive viewer."].join("\n")));
    }
    return;
  }
  const { watchInTerminal } = await import("./watch-ui.js");
  await watchInTerminal(options);
}
