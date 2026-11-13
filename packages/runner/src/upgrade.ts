import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, cp, lchown, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, matchesGlob, relative } from "node:path";
import { order as compare, piDurableVersion, readRuntimeSelection, selectRuntime } from "./runtime-version.js";
import { serviceRequest } from "./service.js";
import { openStore, unfinishedStores } from "./store-status.js";
import { hostSupervisor, run, supervisors, type Supervision, type Unit } from "./upgrade-supervisor.js";

/** What one machine declares: the selected releases and everything that runs them. See docs/upgrade.md. */
export type Consumer = { name: string; profile?: string; stateRoot?: string; config?: string; supervision?: Supervision };
export type Declaration = {
  schemaVersion: 1;
  stateDirectory: string;
  releases: { name: string; package: string; consumers: Consumer[]; companions?: { name: string; package: string; profile?: string }[] }[];
  retire?: { supervision?: Supervision; profile?: string; path?: string }[];
  records?: string[];
};
export type Options = { backup?: boolean; systemInventory?: string };

const PI = "@earendil-works/pi-durable/package.json";
const storeRoot = (path: string) => /^\/nix\/store\/[^/]+/.exec(path)?.[0];
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const version = (path: string): string | undefined => { try { return json(path).version; } catch { return undefined; } };
const real = (path: string) => { try { return realpathSync(path); } catch { return undefined; } };
const same = (found: Iterable<string>, expected: string | undefined) => { const all = [...found]; return all.length === 1 && all[0] === expected; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const stamp = () => new Date().toISOString().replace(/[-:]|\.\d+/g, "");
const nix = (tool: string) => existsSync(`/nix/var/nix/profiles/default/bin/${tool}`) ? `/nix/var/nix/profiles/default/bin/${tool}` : tool;
const tokens = (text: string) => text.split(/[\s=:"',;]+/).filter(token => token.startsWith("/"));

export function readDeclaration(path: string): Declaration {
  const value = json(path) as Declaration;
  const absolute = (label: string, item: unknown) => { if (typeof item !== "string" || !isAbsolute(item)) throw new Error(`${label} must be an absolute path.`); };
  const supervised = (label: string, item?: Supervision) => {
    if (item && (!(item.kind in supervisors) || typeof item.unit !== "string" || !item.unit || !["user", "system", undefined].includes(item.scope)))
      throw new Error(`${label}.supervision needs kind (launchd or systemd), unit and an optional scope (user or system).`);
    if (item?.definition !== undefined) absolute(`${label}.supervision.definition`, item.definition);
  };
  if (value?.schemaVersion !== 1 || !Array.isArray(value.releases)) throw new Error("The declaration needs schemaVersion 1 and releases.");
  absolute("stateDirectory", value.stateDirectory);
  for (const release of value.releases) {
    if (!/^[a-z][a-z0-9-]*$/.test(release.name ?? "") || !Array.isArray(release.consumers)) throw new Error("Each release needs a name and consumers.");
    absolute(`${release.name}.package`, release.package);
    // A profile or link is accepted: the selection is the package it resolves to now.
    release.package = real(release.package) ?? release.package;
    for (const consumer of release.consumers) {
      const label = `${release.name}.${consumer.name}`;
      if (typeof consumer.name !== "string" || !consumer.name) throw new Error(`Each consumer of ${release.name} needs a name.`);
      for (const field of ["profile", "stateRoot", "config"] as const) if (consumer[field] !== undefined) absolute(`${label}.${field}`, consumer[field]);
      supervised(label, consumer.supervision);
    }
    for (const companion of release.companions ?? []) {
      absolute(`${release.name}.${companion.name}.package`, companion.package);
      companion.package = real(companion.package) ?? companion.package;
      if (companion.profile !== undefined) absolute(`${release.name}.${companion.name}.profile`, companion.profile);
    }
  }
  for (const [index, item] of (value.retire ?? []).entries()) {
    if ([item.supervision, item.profile, item.path].filter(entry => entry !== undefined).length !== 1) throw new Error(`retire[${index}] names exactly one of supervision, profile or path.`);
    supervised(`retire[${index}]`, item.supervision);
    if (!item.supervision) absolute(`retire[${index}]`, item.profile ?? item.path);
  }
  return value;
}

/** Every Pi Durable version loadable from a program, package, manifest or configuration path, and what names what. */
class Reach {
  /** Store path -> who names it, directly or through its configuration. */
  readonly named = new Map<string, Set<string>>();
  /** Store paths that hold a Pi Durable themselves. */
  readonly carriers = new Set<string>();
  readonly missing = new Map<string, Set<string>>();
  readonly unresolved = new Set<string>();
  /** Who runs through which declared profile. */
  readonly through = new Map<string, Set<string>>();
  constructor(private readonly records: string[], private readonly rootCovered: boolean, private readonly profiles: { path: string; package: string }[]) {}

  /** `namespace` is the root a process sees ("/proc/PID/root"), or "container" for arguments passed into one. */
  versions(path: string, who: string, namespace = "", seen = new Set<string>()): Set<string> {
    const found = new Set<string>();
    if (!path.startsWith("/") || path.startsWith("//") || seen.has(path)) return found;
    seen.add(path);
    // Whatever names a declared profile runs what that profile selects, so it is read as the selection.
    const profile = this.profiles.find(item => path === item.path || path.startsWith(`${item.path}/`));
    if (profile) { this.through.set(who, (this.through.get(who) ?? new Set()).add(profile.path)); path = profile.package + path.slice(profile.path.length); }
    let actual: string;
    try {
      if (!existsSync(path)) { if (storeRoot(path)) this.absent(path, who, namespace); return found; }
      actual = realpathSync(path);
    } catch { this.unresolved.add(path); return found; }
    const store = storeRoot(actual), file = statSync(actual).isFile();
    const root = store ?? (file && basename(dirname(actual)) === "bin" ? dirname(dirname(actual)) : undefined);
    if (store) this.named.set(store, (this.named.get(store) ?? new Set()).add(who));
    if (root && !seen.has(`root:${root}`)) {
      seen.add(`root:${root}`);
      const lib = join(root, "lib"), inner = (directory: string) => { try { return readdirSync(directory).map(name => join(directory, name)); } catch { return []; } };
      for (const modules of [join(lib, "node_modules"), ...inner(lib).flatMap(entry => [join(entry, "node_modules"), ...inner(entry).map(deeper => join(deeper, "node_modules"))])]) {
        const carried = version(join(modules, PI));
        if (carried) { found.add(carried); if (store) this.carriers.add(store); }
      }
      for (const name of inner(join(root, "share"))) if (existsSync(join(name, "release.json"))) for (const item of this.versions(join(name, "release.json"), who, namespace, seen)) found.add(item);
    }
    if (!store && file && /\.m?js$/.test(actual)) {
      for (let directory = dirname(actual); directory !== dirname(directory) && directory !== homedir(); directory = dirname(directory)) {
        const carried = version(join(directory, "node_modules", PI));
        if (carried) { found.add(carried); break; }
      }
    }
    // Records (status output, receipts) hold history, not dependencies.
    if (file && actual.endsWith(".json") && !this.records.some(pattern => matchesGlob(path, pattern) || matchesGlob(actual, pattern))) {
      let data: unknown;
      try { data = json(actual); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EACCES") this.unresolved.add(actual); }
      // A release names its read-only viewer separately; the viewer opens no store.
      if (data && typeof data === "object" && "dispatch" in data && "watch" in data) data = { ...data, watch: undefined };
      for (const stack = [data]; stack.length;) {
        const item = stack.pop();
        if (typeof item === "string") for (const inner of this.versions(item, who, namespace, seen)) found.add(inner);
        else if (item && typeof item === "object") for (const [key, value] of Object.entries(item)) {
          // Environment PATH and release tools.path both contain search path lists.
          if ((key === "PATH" || key === "path") && typeof value === "string") stack.push(...value.split(":"));
          else stack.push(value);
        }
      }
    }
    return found;
  }

  private absent(path: string, who: string, namespace: string) {
    if (namespace === "container") return;
    if (namespace) {
      // A path that exists in the process's own mount namespace is not missing.
      try { statSync(namespace); if (existsSync(namespace + path)) return; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES" && !this.rootCovered) this.unresolved.add(`${path} (in the namespace of ${who})`);
        return;
      }
    }
    this.missing.set(path, (this.missing.get(path) ?? new Set()).add(who));
  }
  namedBy = (who: string) => [...this.named].filter(([, names]) => names.has(who)).map(([path]) => path);
}

export type Selected = { name: string; package: string; revision?: string; dispatch?: { revision: string; version: string; storePath: string };
  piDurable?: string; eval?: string; companions: { name: string; package: string; piDurable: string[] }[] };
type Service = { unit: string; kind: Supervision["kind"]; scope: "user" | "system"; definition: string; piDurable: string[]; enabled: boolean; expected: boolean;
  running: boolean; pid?: number; consumer?: string; superseded: string[]; profiles: string[] };
type Running = { pid: number; who: string; unit?: string; session?: string; piDurable: string[]; superseded: string[]; program: string };
type Owner = { root: string; session: string; pid: number; socket?: string; identity?: string; piDurable: string[]; superseded: string[] };
type Root = { root: string; recorded?: string; exists: boolean };
type Machine = { selected: Selected[]; piDurable?: string; problems: string[]; services: Service[]; running: Running[]; owners: Owner[]; roots: Root[];
  profiles: { path: string; package: string; current?: string; of: string }[]; reach: Reach; uninspected: string[];
  /** Every installed service definition, whatever it runs. */
  installed: Supervision[] };

const configOf = (consumer: Consumer): { stateRoot?: string; socket?: string } => { try { return consumer.config ? json(consumer.config) : {}; } catch { return {}; } };
const rootOf = (consumer: Consumer) => consumer.stateRoot ?? configOf(consumer).stateRoot;
const consumers = (declaration: Declaration) => declaration.releases.flatMap(release => release.consumers.map(consumer => ({ release, consumer, label: `${release.name}/${consumer.name}` })));
const sameService = (a: Supervision, b: { kind: string; unit: string; scope?: string }) => a.kind === b.kind && a.unit === b.unit && (a.scope ?? "user") === (b.scope ?? "user");

/** The live inventory: read-only, and it opens no store. */
async function inspect(declaration: Declaration, options: Options = {}): Promise<Machine> {
  const supplied = options.systemInventory ? json(options.systemInventory) as { services: Service[]; unresolved: string[]; named: string[]; missing: Record<string, string[]> } : undefined;
  const profiles = declaration.releases.flatMap(release => [...release.consumers.map(consumer => ({ ...consumer, package: release.package })), ...release.companions ?? []]
    .flatMap(item => item.profile ? [{ path: item.profile, of: `${release.name}/${item.name}`, package: item.package, current: real(item.profile) }] : []));
  const reach = new Reach(declaration.records ?? [], !!supplied, profiles), problems: string[] = [];
  const selected: Selected[] = declaration.releases.map(release => {
    const item: Selected = { name: release.name, package: release.package, companions: [] };
    try {
      const manifest = json(join(release.package, "share", release.name, "release.json"));
      Object.assign(item, { revision: manifest.revision, dispatch: manifest.dispatch, eval: manifest.eval?.version,
        piDurable: version(join(manifest.dispatch.storePath, "lib/dispatch-runner/node_modules", PI)) });
    } catch { problems.push(`${release.name}: ${release.package} is not a built release of that name on this machine`); return item; }
    const carried = reach.versions(release.package, "selected");
    if (!item.piDurable || !same(carried, item.piDurable)) problems.push(`${release.name} carries Pi Durable ${[...carried].sort().join(" and ") || "nothing"}; a release carries exactly one`);
    for (const companion of release.companions ?? []) {
      const found = [...reach.versions(companion.package, "selected")].sort();
      item.companions.push({ name: companion.name, package: companion.package, piDurable: found });
      if (!same(found, item.piDurable)) problems.push(`${release.name}: companion ${companion.name} carries Pi Durable ${found.join(" and ") || "nothing"}, not ${item.piDurable}; build it from the release's Dispatch revision`);
    }
    return item;
  });
  const carried = [...new Set(selected.map(item => item.piDurable).filter((item): item is string => !!item))];
  if (carried.length > 1) problems.push(`the selected releases need different Pi Durable versions (${selected.map(item => `${item.name}: ${item.piDurable}`).join(", ")}); one machine runs one`);
  const current = new Set(reach.namedBy("selected"));
  /** Packages holding a Pi Durable that `who` names and the selection does not include. */
  const superseded = (who: string) => reach.namedBy(who).filter(path => reach.carriers.has(path) && !current.has(path)).sort();

  const declared = consumers(declaration).filter(item => item.consumer.supervision);
  const processes = new Map<number, { ppid: number; args: string }>();
  for (const line of (await run("ps", ["-axwwo", "pid=,ppid=,args="])).stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[1]) !== process.pid) processes.set(Number(match[1]), { ppid: Number(match[2]), args: match[3].split(" --prompt ")[0] });
  }
  const services: Service[] = [], mains = new Map<number, string>(), uninspected: string[] = [];
  const units = new Map<string, Unit>();
  const known = [...declared.map(item => item.consumer.supervision!), ...(declaration.retire ?? []).flatMap(item => item.supervision ?? [])];
  for (const unit of await hostSupervisor().units(known.filter(item => supervisors[item.kind] === hostSupervisor())))
    units.set(`${unit.kind}:${unit.scope}:${unit.unit}`, unit);
  for (const unit of units.values()) {
    const consumer = declared.find(item => sameService(item.consumer.supervision!, unit));
    const versions = new Set<string>(), named = [...unit.text.flatMap(tokens), ...(consumer?.consumer.config ? [consumer.consumer.config] : [])];
    for (const token of named) for (const item of reach.versions(token, unit.unit, unit.container ? "container" : "")) versions.add(item);
    for (const item of unit.unreadable) reach.unresolved.add(item);
    if (unit.container && versions.size === 0) { uninspected.push(`${unit.unit} runs a container, which is not inspected`); continue; }
    if (!versions.size && !consumer) continue;
    const pid = await supervisors[unit.kind].pid(unit);
    if (pid) mains.set(pid, unit.unit);
    services.push({ unit: unit.unit, kind: unit.kind, scope: unit.scope, definition: unit.definition, piDurable: [...versions].sort(), enabled: unit.enabled,
      expected: unit.expected, running: !!pid, pid, consumer: consumer?.label, superseded: [], profiles: [] });
  }
  for (const item of declared) if (!services.some(service => sameService(item.consumer.supervision!, service)))
    problems.push(`${item.label}: service ${item.consumer.supervision!.unit} has no installed definition`);
  for (const row of supplied?.services ?? []) if (!services.some(service => sameService(service, row))) services.push(row);
  if (supplied) { reach.unresolved.clear(); for (const item of supplied.unresolved) reach.unresolved.add(item); }
  for (const path of supplied?.named ?? []) reach.named.set(path, (reach.named.get(path) ?? new Set()).add("system inventory"));
  for (const [path, who] of Object.entries(supplied?.missing ?? {})) reach.missing.set(path, new Set([...reach.missing.get(path) ?? [], ...who]));

  const roots: Root[] = [...new Set(consumers(declaration).map(item => rootOf(item.consumer)).filter((root): root is string => !!root))]
    .map(root => ({ root, exists: existsSync(root), recorded: undefined as string | undefined }));
  const owners: Owner[] = [];
  for (const root of roots) {
    try { root.recorded = (await readRuntimeSelection(root.root))?.piDurable; } catch { problems.push(`${root.root}: its runtime record is unreadable`); }
    for (const entry of root.exists ? readdirSync(root.root, { withFileTypes: true }) : []) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      let endpoint: { pid?: number; socket?: string; identity?: string; piDurable?: string };
      try { endpoint = json(join(root.root, entry.name, "service-endpoint.json")); } catch { continue; }
      const parts = processes.get(endpoint.pid ?? 0)?.args.split(/\s+/) ?? [];
      if (!parts.includes("--session-owner") || parts[parts.indexOf("--session") + 1] !== entry.name) continue;
      owners.push({ root: root.root, session: entry.name, pid: endpoint.pid!, socket: endpoint.socket, identity: endpoint.identity,
        piDurable: endpoint.piDurable ? [endpoint.piDurable] : [], superseded: [] });
    }
  }
  const running: Running[] = [];
  for (const [pid, { args }] of processes) {
    const owner = owners.find(item => item.pid === pid);
    let unit: string | undefined;
    for (let at = pid, depth = 0; at > 1 && depth < 32 && !unit; at = processes.get(at)?.ppid ?? 0, depth++) unit = mains.get(at);
    const who = owner ? `session ${owner.session}` : unit ? `${unit} (running)` : `process ${pid}`, versions = new Set<string>();
    for (const token of tokens(args)) for (const item of reach.versions(token, who, process.platform === "linux" ? `/proc/${pid}/root` : "")) versions.add(item);
    // An owner records the Pi Durable it loaded; what its configuration can also load (a provider module) counts as well.
    if (owner) { for (const item of owner.piDurable) versions.add(item); owner.piDurable = [...versions].sort(); }
    if (!versions.size) continue;
    running.push({ pid, who, unit, session: owner && join(owner.root, owner.session), piDurable: [...versions].sort(), superseded: [], program: args.split(" ").slice(0, 3).join(" ").slice(0, 240) });
  }
  for (const service of services) if (!supplied?.services.includes(service)) Object.assign(service, { superseded: superseded(service.unit), profiles: [...reach.through.get(service.unit) ?? []] });
  for (const owner of owners) owner.superseded = superseded(`session ${owner.session}`);
  for (const item of running) item.superseded = superseded(item.who);
  return { selected, piDurable: carried.length === 1 ? carried[0] : undefined, problems, services, running, owners, roots, profiles, reach, uninspected, installed: [...units.values()] };
}

/** Whether a live owner or service reports unfinished work. Unknown counts as unfinished. */
const busy = (socket: string | undefined, expected?: { identity?: string }) => !socket ? Promise.resolve(true)
  : serviceRequest(socket, { method: "status" }, { signal: AbortSignal.timeout(8000), expected: expected?.identity ? { identity: expected.identity } : undefined })
    .then(status => status.busy !== false, () => true);

type Plan = { machine: Machine; problems: string[]; moves: string[];
  profiles: Machine["profiles"]; restart: { label: string; supervision: Supervision; expected: boolean }[]; close: Owner[]; backup: Root[] };

/** What converge would do and why it could not. Read-only; asks live owners and services for their status. */
async function plan(declaration: Declaration, options: Options): Promise<Plan> {
  const machine = await inspect(declaration, options), problems = [...machine.problems], moves: string[] = [];
  const pi = machine.piDurable;
  const profiles = machine.profiles.filter(profile => profile.current !== profile.package);
  for (const profile of profiles) moves.push(`${profile.of}: profile ${profile.path} moves from ${profile.current ?? "nothing"} to ${profile.package}`);
  const backup: Root[] = [];
  for (const root of machine.roots) {
    const holds = root.exists && readdirSync(root.root).some(name => !name.startsWith("."));
    if (root.recorded && pi && compare(root.recorded, pi) > 0) problems.push(`${root.root} was opened by Pi Durable ${root.recorded}, newer than the selected ${pi}; restore it from a backup taken before that upgrade`);
    else if (holds && (options.backup || (pi && root.recorded !== pi))) {
      backup.push(root);
      moves.push(`${root.root}: closed-state backup${root.recorded === pi ? "" : `, then Pi Durable ${root.recorded ?? "unrecorded"} to ${pi}`}`);
    }
  }
  if (backup.length && pi && pi !== piDurableVersion)
    problems.push(`this command carries Pi Durable ${piDurableVersion} and the selection is ${pi}; run the dispatch-upgrade of the selected release`);
  const closing = (root?: string) => backup.some(item => item.root === root);
  const close: Owner[] = [], live: string[] = [];
  for (const owner of machine.owners) {
    const stale = owner.superseded.length > 0 || !same(owner.piDurable, pi);
    if (!stale && !closing(owner.root)) continue;
    live.push(join(owner.root, owner.session));
    if (!await busy(owner.socket, owner)) { close.push(owner); moves.push(`session ${owner.session}: idle owner closes; its next run starts on the selection`); }
    else if (closing(owner.root) || !same(owner.piDurable, pi)) problems.push(`session ${owner.session} under ${owner.root} has unfinished work; let it finish or stop it`);
    else moves.push(`session ${owner.session}: busy on the same Pi Durable; it stays on its release until idle`);
  }
  const restart: Plan["restart"] = [];
  for (const { consumer, label } of consumers(declaration)) {
    const service = consumer.supervision && machine.services.find(item => sameService(consumer.supervision!, item));
    if (!service) continue;
    const root = rootOf(consumer), processes = machine.running.filter(item => item.unit === service.unit);
    const moving = profiles.filter(profile => service.profiles.includes(profile.path) || machine.reach.through.get(`${service.unit} (running)`)?.has(profile.path));
    const reason = closing(root) ? "its state root is backed up closed" : moving.length ? `profile ${moving[0].path} moves`
      : processes.some(item => item.superseded.length || !same(item.piDurable, pi)) ? "its process runs a superseded package"
      : service.expected && !service.running ? "it should be running" : undefined;
    if (service.superseded.length) problems.push(`${label}: the definition or configuration of ${service.unit} names ${service.superseded.join(", ")}; point it at the selection (or a declared profile) first`);
    if (!reason) continue;
    restart.push({ label, supervision: consumer.supervision!, expected: service.expected });
    moves.push(`${label}: ${service.unit} ${service.running ? "restarts" : service.expected ? "starts" : "stays stopped"} (${reason})`);
    const socket = configOf(consumer).socket;
    if (service.running && socket ? await busy(socket) : root !== undefined && unfinishedStores(root, live).length > 0) problems.push(`${label}: ${service.unit} has unfinished work; let it finish or stop it`);
    if (root) live.push(root);
  }
  for (const root of backup) if (!live.includes(root.root)) {
    const stores = unfinishedStores(root.root, live);
    if (stores.length) problems.push(`${root.root} holds unfinished work in ${stores.length} closed store(s), for example ${stores[0]}; finish or stop it on its current release`);
  }
  for (const item of declaration.retire ?? []) {
    const present = item.supervision ? machine.installed.some(unit => sameService(item.supervision!, unit)) : !!lstatSync((item.profile ?? item.path)!, { throwIfNoEntry: false });
    if (present) moves.push(`${item.supervision?.unit ?? item.profile ?? item.path} is retired`);
  }
  return { machine, problems, moves, profiles, restart, close, backup };
}

const files = async (directory: string) => (await readdir(directory, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => relative(directory, join(entry.parentPath, entry.name))).sort();
const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
type Metadata = { uid: number; gid: number; mode: number };
type BackupManifest = { schemaVersion: 1 | 2; source: string; piDurable?: string; takenFor?: string; created: string;
  files: Record<string, { size: number; sha256: string }>; metadata?: Record<string, Metadata> };
const metadataOf = async (directory: string, names?: string[]): Promise<Record<string, Metadata>> => Object.fromEntries(
  (names ?? [".", ...(await readdir(directory, { recursive: true, withFileTypes: true })).map(entry => relative(directory, join(entry.parentPath, entry.name)))])
    .map(name => { const { uid, gid, mode } = lstatSync(join(directory, name)); return [name, { uid, gid, mode }]; }));

/** Copy a closed state root, then prove the copy: every file's digest against the source, and SQLite's own check of every store. */
async function backupRoot(root: Root, directory: string, takenFor?: string) {
  const target = join(directory, `${basename(root.root)}-${createHash("sha256").update(root.root).digest("hex").slice(0, 8)}-${stamp()}`), state = join(target, "state");
  await mkdir(target, { recursive: true, mode: 0o700 });
  const transient = (path: string) => /\.lock$|\.sock$/.test(path) || basename(path) === ".runtime-holders" || lstatSync(path).isSocket();
  await cp(root.root, state, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: source => !transient(source) });
  const manifest: BackupManifest = { schemaVersion: 2, source: root.root, piDurable: root.recorded, takenFor, created: new Date().toISOString(), files: {},
    metadata: await metadataOf(root.root, Object.keys(await metadataOf(state))) };
  for (const file of await files(state)) {
    const sha256 = await digest(join(state, file));
    if (sha256 !== await digest(join(root.root, file))) throw new Error(`Backup of ${root.root} differs from its source at ${file}; the state root was not closed.`);
    manifest.files[file] = { size: statSync(join(state, file)).size, sha256 };
  }
  const expected = (await files(root.root)).filter(file => !file.split("/").some(part => /\.lock$|\.sock$/.test(part) || part === ".runtime-holders") && !lstatSync(join(root.root, file)).isSocket());
  if (expected.length !== Object.keys(manifest.files).length) throw new Error(`Backup of ${root.root} holds ${Object.keys(manifest.files).length} files; the source has ${expected.length}.`);
  await checkStores(state, Object.keys(manifest.files));
  await writeFile(join(target, "backup.json"), JSON.stringify(manifest, null, 1) + "\n", { mode: 0o600 });
  return { root: root.root, path: target, files: expected.length, bytes: Object.values(manifest.files).reduce((sum, file) => sum + file.size, 0), piDurable: root.recorded };
}
async function checkStores(state: string, names: string[]) {
  for (const file of names.filter(name => name.endsWith(".sqlite"))) {
    const db = openStore(join(state, file));
    try { const result = db.prepare("PRAGMA quick_check").get() as { quick_check: string }; if (result.quick_check !== "ok") throw new Error(`${join(state, file)} fails SQLite's integrity check: ${result.quick_check}`); }
    finally { db.close(); }
  }
}
async function verifyBackup(path: string) {
  const manifest = json(join(path, "backup.json")) as BackupManifest, state = join(path, "state");
  const present = await files(state);
  if (present.length !== Object.keys(manifest.files).length) throw new Error(`${path} holds ${present.length} files; its manifest lists ${Object.keys(manifest.files).length}.`);
  for (const file of present) if (manifest.files[file]?.sha256 !== await digest(join(state, file))) throw new Error(`${path}: ${file} does not match the manifest.`);
  if (manifest.schemaVersion === 2) {
    const metadata = await metadataOf(state);
    if (!manifest.metadata || Object.keys(metadata).length !== Object.keys(manifest.metadata).length
      || Object.entries(metadata).some(([name, item]) => (item.mode & constants.S_IFMT) !== (manifest.metadata![name]?.mode & constants.S_IFMT)))
      throw new Error(`${path}: backup entries do not match the manifest.`);
  }
  await checkStores(state, present);
  return manifest;
}

/** Put a verified backup back in place of a closed state root. The replaced root is kept beside it. */
export async function restore(path: string, to?: string) {
  const manifest = await verifyBackup(path), root = to ?? manifest.source;
  const open = existsSync(root) ? [...readdirSync(root).flatMap(name => { try { return [json(join(root, name, "service-endpoint.json")).pid as number]; } catch { return []; } }),
    ...(existsSync(join(root, ".runtime-holders")) ? readdirSync(join(root, ".runtime-holders")).map(name => Number(name.split(".")[0])) : [])].filter(alive) : [];
  if (open.length) throw new Error(`${root} is open by process ${open.join(", ")}. Stop its consumers first; nothing was changed.`);
  const replaced = existsSync(root) ? `${root}.replaced-${stamp()}` : undefined;
  const staged = `${root}.restore-${stamp()}-${process.pid}`;
  // Older backups did not record source ownership; their copy's metadata is all that remains available.
  const metadata = manifest.metadata ?? await metadataOf(join(path, "state"));
  if (!manifest.metadata) console.error(`${path}: legacy backup; ownership comes from the backup copy, not a source ownership record.`);
  try {
    await cp(join(path, "state"), staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    for (const [file, { sha256 }] of Object.entries(manifest.files)) if (sha256 !== await digest(join(staged, file))) throw new Error(`${root}: restored ${file} does not match the backup.`);
    // Apply parents last, so private directory modes do not prevent restoring their children.
    for (const name of Object.keys(metadata).sort((a, b) => b.split("/").length - a.split("/").length || (a === "." ? 1 : b === "." ? -1 : 0))) {
      const entry = join(staged, name), saved = metadata[name], current = lstatSync(entry);
      if (current.uid !== saved.uid || current.gid !== saved.gid) await lchown(entry, saved.uid, saved.gid);
      if (!current.isSymbolicLink()) await chmod(entry, saved.mode & 0o7777);
    }
    if (replaced) await rename(root, replaced);
    try { await rename(staged, root); }
    catch (error) { if (replaced) await rename(replaced, root); throw error; }
  } catch (error) { await rm(staged, { recursive: true, force: true }); throw error; }
  return { root, from: path, piDurable: manifest.piDurable, files: Object.keys(manifest.files).length, replaced };
}

export type Receipt = { schemaVersion: 1; at: string; mode: string; piDurable?: string; selected: Selected[]; problems: string[]; planned: string[]; changed: string[];
  backups: Awaited<ReturnType<typeof backupRoot>>[]; removed: string[]; retained: { path: string; why: string }[]; failures: string[];
  services: Service[]; running: Running[]; stateRoots: Root[]; profiles: Machine["profiles"];
  onAnotherPiDurable: { services: string[]; running: string[]; profiles: string[] }; notRunning: string[]; otherProcesses: number;
  missing: Record<string, string[]>; unresolved: string[]; uninspected: string[]; receipt?: string };

/** What the machine looks like against the selection. Read-only. */
function findings(machine: Machine): Pick<Receipt, "services" | "running" | "stateRoots" | "profiles" | "onAnotherPiDurable" | "notRunning" | "otherProcesses" | "missing" | "unresolved" | "uninspected"> & { failures: string[] } {
  const pi = machine.piDurable, off = (found: string[]) => !same(found, pi);
  const installed = machine.running.filter(item => item.unit || item.session);
  const needed = new Set([...machine.services.filter(item => item.expected).map(item => item.unit), ...installed.map(item => item.who)]);
  const missing = Object.fromEntries([...machine.reach.missing].map(([path, who]) => [path, [...who].sort()]));
  const result = {
    services: machine.services, running: machine.running, stateRoots: machine.roots, profiles: machine.profiles,
    onAnotherPiDurable: { services: machine.services.filter(item => item.piDurable.length && off(item.piDurable)).map(item => item.unit),
      running: installed.filter(item => off(item.piDurable)).map(item => `${item.who}, pid ${item.pid}`),
      profiles: machine.profiles.filter(item => item.current !== item.package).map(item => item.path) },
    notRunning: machine.services.filter(item => item.consumer && item.expected && !item.running).map(item => item.unit),
    otherProcesses: machine.running.length - installed.length, missing, unresolved: [...machine.reach.unresolved].sort(), uninspected: machine.uninspected,
  };
  const blocking = Object.entries(missing).filter(([, who]) => who.some(name => needed.has(name)));
  return { ...result, failures: [
    ...result.onAnotherPiDurable.services.map(item => `installed service ${item} can load another Pi Durable`),
    ...result.onAnotherPiDurable.running.map(item => `${item} runs another Pi Durable`),
    ...result.onAnotherPiDurable.profiles.map(item => `profile ${item} does not select its declared package`),
    ...machine.services.filter(item => item.consumer && item.superseded.length).map(item => `${item.unit} still names ${item.superseded.join(", ")}`),
    ...result.notRunning.map(item => `${item} should be running and is not`),
    ...blocking.map(([path, who]) => `${who.join(", ")} needs ${path}, which is not on this machine`),
    ...result.unresolved.map(item => `could not inspect ${item}`),
  ] };
}

const receiptsOf = (declaration: Declaration): Receipt[] => {
  const directory = join(declaration.stateDirectory, "receipts");
  try { return readdirSync(directory).filter(name => name.endsWith(".json")).sort().map(name => ({ ...json(join(directory, name)), receipt: join(directory, name) })); } catch { return []; }
};
const blank = (mode: string, machine: Machine): Receipt => ({ schemaVersion: 1, at: new Date().toISOString(), mode, piDurable: machine.piDurable, selected: machine.selected,
  problems: [], planned: [], changed: [], backups: [], removed: [], retained: [], ...findings(machine), failures: [] });

/** Read-only: is the machine ready, and what would move. */
export async function preflight(declaration: Declaration, options: Options = {}): Promise<Receipt> {
  const planned = await plan(declaration, options);
  return { ...blank("preflight", planned.machine), problems: planned.problems, planned: planned.moves };
}

/** Read-only, and asks nothing of a running owner: what is installed where, with the last receipts. */
export async function status(declaration: Declaration, options: Options = {}) {
  const machine = await inspect(declaration, options), receipts = receiptsOf(declaration);
  const last = (mode: string) => { const found = receipts.findLast(item => item.mode === mode); return found && { at: found.at, receipt: found.receipt, changed: found.changed.length, failures: found.failures.length + found.problems.length, retained: found.retained.length }; };
  return { ...blank("status", machine), failures: [...machine.problems, ...findings(machine).failures], owners: machine.owners.map(({ root, session, pid, piDurable, superseded }) => ({ root, session, pid, piDurable, superseded })),
    declaration: consumers(declaration).map(({ release, consumer, label }) => ({ label, release: release.name, profile: consumer.profile, stateRoot: rootOf(consumer), supervision: consumer.supervision })),
    lastConverge: last("converge"), lastBackup: receipts.findLast(item => item.backups.length)?.backups };
}

/** The installed service definitions as this user can read them, for a privileged run to hand to an unprivileged one. */
export async function inventory(declaration: Declaration) {
  const machine = await inspect(declaration);
  return { services: machine.services, unresolved: [...machine.reach.unresolved], named: [...machine.reach.named.keys()],
    missing: Object.fromEntries([...machine.reach.missing].map(([path, who]) => [path, [...who]])) };
}

/** Bring the machine onto the declared selection, or (`only: "backup"`) take the closed-state backup and reopen. */
export async function converge(declaration: Declaration, options: Options & { only?: "backup" } = {}): Promise<Receipt> {
  const mode = options.only ?? "converge";
  const planned = await plan(declaration, options.only ? { ...options, backup: true } : options);
  const receipt = { ...blank(mode, planned.machine), problems: planned.problems, planned: planned.moves };
  const state = declaration.stateDirectory, did = (text: string) => { receipt.changed.push(text); console.error(text); };
  const save = async (result: Receipt) => {
    await mkdir(join(state, "receipts"), { recursive: true, mode: 0o700 });
    result.receipt = join(state, "receipts", `${stamp()}-${mode}.json`);
    await writeFile(result.receipt, JSON.stringify(result, null, 1) + "\n", { mode: 0o600 });
    return result;
  };
  if (planned.problems.length) return save(receipt);

  const stopped: Plan["restart"] = [], ran = new Set<Supervision>();
  try {
    for (const item of planned.restart) {
      // Stopped through its supervisor even when it has no process now, so nothing starts it during a backup.
      if (await supervisors[item.supervision.kind].pid(item.supervision)) ran.add(item.supervision);
      await supervisors[item.supervision.kind].stop(item.supervision);
      stopped.push(item);
    }
    for (const owner of planned.close) {
      // SIGTERM is an owner's ordinary shutdown; it was idle when asked, so nothing is interrupted.
      try { process.kill(owner.pid, "SIGTERM"); } catch {}
      for (let attempt = 0; alive(owner.pid) && attempt < 600; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      if (alive(owner.pid)) throw new Error(`Session owner ${owner.pid} (${owner.session}) did not close.`);
      await unlink(join(owner.root, owner.session, "service-endpoint.json")).catch(() => {});
      did(`closed idle session owner ${owner.session} (pid ${owner.pid}, Pi Durable ${owner.piDurable.join(",")})`);
    }
    for (const root of planned.backup) {
      // Under the lock every launcher takes before it opens a store here: taken closed, before the new version is recorded.
      await selectRuntime(root.root, { beforeSelect: async open => {
        if (open.length) throw new Error(`${root.root} is still open by process ${open.join(", ")}, which no declared consumer accounts for. Nothing was selected.`);
        receipt.backups.push(await backupRoot(root, join(state, "backups"), planned.machine.piDurable));
        did(`backed up ${root.root} closed to ${receipt.backups.at(-1)!.path} (${receipt.backups.at(-1)!.files} files, verified)`);
        return options.only ? false : undefined;
      } });
      if (!options.only && root.recorded !== planned.machine.piDurable) did(`${root.root}: Pi Durable ${root.recorded ?? "unrecorded"} to ${planned.machine.piDurable}`);
    }
    if (!options.only) for (const profile of planned.profiles) {
      await mkdir(dirname(profile.path), { recursive: true });
      const set = await run(nix("nix-env"), ["--profile", profile.path, "--set", profile.package]);
      if (set.code !== 0) throw new Error(`Could not select ${profile.package} in ${profile.path}: ${set.stderr.trim()}`);
      did(`${profile.of}: profile ${profile.path} selects ${profile.package}`);
    }
  } catch (error) { receipt.failures.push((error as Error).message); }
  // Restore services that were running; converge also starts services expected to be up.
  const started = new Map<Supervision, number | undefined>();
  for (const item of planned.restart) {
    if (receipt.failures.length && !stopped.includes(item)) continue;
    if (!ran.has(item.supervision) && (options.only || !item.expected)) continue;
    try {
      await supervisors[item.supervision.kind].start(item.supervision);
      did(`${item.label}: ${item.supervision.unit} ${ran.has(item.supervision) ? "restarted" : "started"}`);
      started.set(item.supervision, undefined);
    } catch (error) { receipt.failures.push((error as Error).message); }
  }
  // Started is not up: a service that exits is started again by its supervisor, so require one process to last.
  for (let attempt = 0; attempt < 12 && [...started.values()].includes(undefined); attempt++) {
    const pids = new Map<Supervision, number | undefined>();
    for (const service of started.keys()) pids.set(service, await supervisors[service.kind].pid(service));
    await new Promise(resolve => setTimeout(resolve, 5000));
    for (const [service, pid] of pids) if (pid && pid === await supervisors[service.kind].pid(service)) started.set(service, pid);
  }
  for (const [service, pid] of started) if (!pid) receipt.failures.push(`${service.unit} did not stay up after its start; see its own log`);
  if (!options.only && !receipt.failures.length) {
    for (const item of declaration.retire ?? []) {
      const keep = join(state, "retired");
      if (item.supervision) {
        const kept = await supervisors[item.supervision.kind].retire(item.supervision, keep).catch(error => { receipt.failures.push((error as Error).message); return undefined; });
        if (kept) did(`retired ${item.supervision.unit}: stopped, definition kept at ${kept}; its state and configuration are untouched`);
      } else if (item.path && lstatSync(item.path, { throwIfNoEntry: false })) {
        const link = lstatSync(item.path).isSymbolicLink(), kept = join(keep, `${basename(item.path)}-${stamp()}`);
        if (link) await unlink(item.path); else { await mkdir(keep, { recursive: true, mode: 0o700 }); await rename(item.path, kept); }
        did(link ? `retired link ${item.path}` : `retired ${item.path}: kept at ${kept}`);
      }
    }
    await removeSuperseded(declaration, options, planned, receipt, did);
  }
  // Verify against a fresh inventory, once the started services have had time to come up.
  let machine = await inspect(declaration, options), found = findings(machine);
  for (let attempt = 0; found.notRunning.length && attempt < 15; attempt++) { await new Promise(resolve => setTimeout(resolve, 2000)); machine = await inspect(declaration, options); found = findings(machine); }
  Object.assign(receipt, found, { failures: [...receipt.failures, ...(options.only ? found.notRunning.map(item => `${item} should be running and is not`) : [...machine.problems, ...found.failures])] });
  return save(receipt);
}

/** Remove what this installation selected before, keeping every package something installed, running or open still names. */
async function removeSuperseded(declaration: Declaration, options: Options, planned: Plan, receipt: Receipt, did: (text: string) => void) {
  const roots = join(declaration.stateDirectory, "roots"), candidates = new Set<string>();
  const generations = (profile: string) => { try { return readdirSync(dirname(profile)).filter(name => new RegExp(`^${basename(profile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+-link$`).test(name)).map(name => join(dirname(profile), name)); } catch { return []; } };
  const consider = (path?: string) => {
    const store = path && storeRoot(path);
    if (!store) return;
    candidates.add(store);
    for (const name of existsSync(join(store, "share")) ? readdirSync(join(store, "share")) : []) { try { candidates.add(json(join(store, "share", name, "release.json")).dispatch.storePath); } catch {} }
  };
  // Only a selection that was applied: a refused run installed nothing.
  for (const earlier of receiptsOf(declaration).filter(item => item.mode === "converge" && !item.problems.length)) {
    for (const item of earlier.selected) { consider(item.package); for (const companion of item.companions) consider(companion.package); }
    for (const item of earlier.retained) consider(item.path);
  }
  for (const profile of planned.machine.profiles) {
    const old = generations(profile.path).filter(link => real(link) !== profile.package);
    old.forEach(link => consider(real(link)));
    if (old.length && (await run(nix("nix-env"), ["--profile", profile.path, "--delete-generations", "old"])).code === 0) did(`${profile.of}: removed ${old.length} earlier generation(s) of ${profile.path}`);
  }
  for (const item of declaration.retire ?? []) if (item.profile) {
    const links = [...generations(item.profile), ...(lstatSync(item.profile, { throwIfNoEntry: false }) ? [item.profile] : [])];
    links.forEach(link => consider(real(link)));
    for (const link of links) await unlink(link);
    if (links.length) did(`retired profile ${item.profile}`);
  }
  // After the moves: what installed definitions, their configuration and running processes name now.
  const machine = await inspect(declaration, options), current = new Set(machine.reach.namedBy("selected"));
  await mkdir(roots, { recursive: true, mode: 0o700 });
  for (const path of [...candidates].sort()) {
    const root = join(roots, basename(path)), names = [...machine.reach.named.get(path) ?? []].map(name => name.startsWith("session ") ? `open ${name}` : name).sort();
    if (!existsSync(path)) await unlink(root).catch(() => {});
    if (current.has(path) || !existsSync(path)) continue;
    if (names.length) {
      // An open run keeps reading its own release while it works, so that release stays rooted until it is done.
      if (!existsSync(root)) await run(nix("nix-store"), ["--add-root", root, "--realise", path]);
      receipt.retained.push({ path, why: `named by ${names.join(", ")}` });
      continue;
    }
    await unlink(root).catch(() => {});
    const removed = await run(nix("nix-store"), ["--delete", path]);
    if (removed.code === 0) { receipt.removed.push(path); did(`removed superseded ${path}`); }
    else receipt.retained.push({ path, why: /still alive|in use|referenced/i.test(removed.stderr) ? "another installed package or garbage-collector root outside this declaration still refers to it" : removed.stderr.trim().split("\n").at(-1) ?? "could not be removed" });
  }
}
