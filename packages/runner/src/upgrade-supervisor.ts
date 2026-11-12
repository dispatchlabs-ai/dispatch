import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** A supervised service as an installation declares it. `scope` defaults to the invoking user's services. */
export type Supervision = { kind: "launchd" | "systemd"; unit: string; scope?: "user" | "system"; definition?: string };
/** An installed service definition, running or not. `text` is everything in it that can name a program or its configuration. */
export type Unit = { kind: Supervision["kind"]; unit: string; scope: "user" | "system"; definition: string; text: string[];
  enabled: boolean; expected: boolean; container: boolean; unreadable: string[] };

export interface Supervisor {
  /** Every installed definition in the standard locations, and the declared ones wherever they are. */
  units(declared: Supervision[]): Promise<Unit[]>;
  /** The service's main process when it is running. */
  pid(service: Supervision): Promise<number | undefined>;
  stop(service: Supervision): Promise<void>;
  /** Start from the definition as it is now, so a changed definition takes effect. */
  start(service: Supervision): Promise<void>;
  /** Stop the service and move its definition into `keep`. Returns the kept file, or nothing when it was not installed. */
  retire(service: Supervision, keep: string): Promise<string | undefined>;
}

export const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>(resolve =>
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, env: options.env }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr: stderr || (error && typeof error.code !== "number" ? error.message : "") })));

const move = async (file: string, keep: string) => {
  await mkdir(keep, { recursive: true, mode: 0o700 });
  const kept = join(keep, basename(file));
  await rename(file, kept);
  return kept;
};
const waitUntil = async (test: () => Promise<boolean>, seconds: number) => {
  for (let attempt = 0; attempt < seconds * 5; attempt++) { if (await test()) return true; await new Promise(resolve => setTimeout(resolve, 200)); }
  return false;
};

const launchd: Supervisor = (() => {
  const domain = (service: Supervision) => service.scope === "system" ? "system" : `gui/${process.getuid!()}`;
  const plist = (service: Supervision) => service.definition
    ?? (service.scope === "system" ? `/Library/LaunchDaemons/${service.unit}.plist` : join(homedir(), "Library/LaunchAgents", `${service.unit}.plist`));
  const loaded = async (service: Supervision) => (await run("/bin/launchctl", ["print", `${domain(service)}/${service.unit}`])).code === 0;
  const unescape = (text: string) => text.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[name]!);
  return {
    async units(declared) {
      const files = new Map<string, "user" | "system">();
      for (const [directory, scope] of [[join(homedir(), "Library/LaunchAgents"), "user"], ["/Library/LaunchAgents", "user"], ["/Library/LaunchDaemons", "system"]] as const)
        for (const name of await readdir(directory).catch(() => [] as string[])) if (name.endsWith(".plist")) files.set(join(directory, name), scope);
      for (const service of declared) files.set(plist(service), service.scope ?? "user");
      const disabled = new Map<string, string>();
      for (const scope of new Set(files.values()))
        disabled.set(scope, (await run("/bin/launchctl", ["print-disabled", domain({ kind: "launchd", unit: "", scope })])).stdout);
      const units: Unit[] = [];
      for (const [definition, scope] of files) {
        const shown = await run("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", definition]);
        const unit = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(shown.stdout)?.[1] ?? basename(definition, ".plist");
        const off = new RegExp(`"${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=>\\s*(disabled|true)`).test(disabled.get(scope)!);
        units.push({ kind: "launchd", unit: unescape(unit), scope, definition, enabled: !off, container: false,
          text: [...shown.stdout.matchAll(/<string>([^<]*)<\/string>/g)].map(match => unescape(match[1])),
          expected: !off && (/<key>KeepAlive<\/key>\s*<(true|dict)/.test(shown.stdout) || /<key>RunAtLoad<\/key>\s*<true/.test(shown.stdout)),
          unreadable: shown.code !== 0 && /permission|not permitted/i.test(shown.stdout + shown.stderr) ? [definition] : [] });
      }
      return units;
    },
    async pid(service) {
      const pid = /^\s*pid = (\d+)/m.exec((await run("/bin/launchctl", ["print", `${domain(service)}/${service.unit}`])).stdout)?.[1];
      return pid ? Number(pid) : undefined;
    },
    async stop(service) {
      await run("/bin/launchctl", ["bootout", `${domain(service)}/${service.unit}`]);
      if (!await waitUntil(async () => !await loaded(service), 60)) throw new Error(`${service.unit} did not stop.`);
    },
    async start(service) {
      const result = await run("/bin/launchctl", ["bootstrap", domain(service), plist(service)]);
      if (result.code !== 0 && !await loaded(service)) throw new Error(`Could not start ${service.unit}: ${result.stderr.trim()}`);
    },
    async retire(service, keep) {
      if (await loaded(service)) await this.stop(service);
      return await readFile(plist(service)).then(() => move(plist(service), keep), () => undefined);
    },
  };
})();

const systemd: Supervisor = (() => {
  const ctl = (scope: Supervision["scope"], ...args: string[]) => run("systemctl", [...(scope === "system" ? [] : ["--user"]), ...args]);
  const act = async (service: Supervision, ...args: string[]) => {
    const result = await ctl(service.scope, ...args, service.unit);
    if (result.code !== 0) throw new Error(`systemctl ${args.join(" ")} ${service.unit}: ${result.stderr.trim()}`);
  };
  return {
    async units() {
      const units: Unit[] = [];
      for (const scope of ["system", "user"] as const) {
        const listed = (await ctl(scope, "list-unit-files", "--type=service", "--no-legend", "--no-pager")).stdout;
        for (const unit of [...new Set(listed.split("\n").map(line => line.trim().split(/\s+/)[0]).filter(name => name && !name.includes("@.")))].sort()) {
          // The effective unit: its file together with every drop-in that overrides it.
          const shown = await ctl(scope, "cat", "--no-pager", unit);
          if (shown.code !== 0) continue;
          const effective = new Map<string, string[]>(), unreadable: string[] = [];
          let definition = "";
          for (const line of shown.stdout.split("\n")) {
            if (line.startsWith("# /")) { definition ||= line.slice(2); continue; }
            const at = line.indexOf("="), key = line.slice(0, at), value = line.slice(at + 1).trim();
            if (at < 0 || !["ExecStart", "ExecStartPre", "Environment", "EnvironmentFile"].includes(key)) continue;
            // An empty assignment in a later file resets everything assigned before it.
            if (!value) effective.set(key, []); else effective.set(key, [...effective.get(key) ?? [], value]);
          }
          const text = [...effective.values()].flat();
          for (const value of effective.get("EnvironmentFile") ?? []) {
            const file = value.replace(/^-/, "");
            await readFile(file, "utf8").then(body => text.push(body), error => { if ((error as NodeJS.ErrnoException).code === "EACCES") unreadable.push(`${file} (environment of ${unit})`); });
          }
          const enabled = (await ctl(scope, "is-enabled", unit)).stdout.trim() === "enabled";
          units.push({ kind: "systemd", unit, scope, definition, text, enabled, unreadable,
            expected: enabled && !/^Type=oneshot/m.test(shown.stdout),
            container: text.some(value => /\b(docker|podman)\s+(run|exec|compose)\b/.test(value)) });
        }
      }
      return units;
    },
    async pid(service) {
      const pid = Number((await ctl(service.scope, "show", "-p", "MainPID", "--value", service.unit)).stdout.trim());
      return pid > 0 ? pid : undefined;
    },
    stop: service => act(service, "stop"),
    async start(service) {
      await ctl(service.scope, "daemon-reload");
      await act(service, "start");
    },
    async retire(service, keep) {
      const definition = service.definition ?? (await ctl(service.scope, "show", "-p", "FragmentPath", "--value", service.unit)).stdout.trim();
      if (!definition || !await readFile(definition).then(() => true, () => false)) return;
      await act(service, "disable", "--now");
      const kept = await move(definition, keep);
      await ctl(service.scope, "daemon-reload");
      return kept;
    },
  };
})();

export const supervisors: Record<Supervision["kind"], Supervisor> = { launchd, systemd };
/** The supervisor whose installed definitions are inventoried on this platform. */
export const hostSupervisor = (): Supervisor => process.platform === "darwin" ? launchd : systemd;
