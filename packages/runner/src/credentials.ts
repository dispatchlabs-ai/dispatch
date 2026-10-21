import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import type { AuthContext, AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { privateWindowsPaths } from "./windows-permissions.js";
import { WindowsCredentialEntry } from "./windows-credentials.js";

export type CredentialProvider = { id: string; origin: string; environmentVariable: string };
type Source = { kind: "keychain"; account: string } | { kind: "helper"; executable: string; args: string[] } | { kind: "environment" };
type Binding = { origin: string; source: Source };
type Profile = { version: 1; providers: Record<string, Binding> };
export type CredentialStatus = { provider: string; source: Source["kind"] | "session" | "unconfigured"; origin: string };

export class CredentialError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CredentialError"; }
}

export function validateSecret(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value.trim())) {
    throw new CredentialError("INVALID_SECRET", "Expected one nonempty API key. Its value was not recorded.");
  }
  return value.trim();
}

function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && part !== ".." && !isAbsolute(part));
}

function defaultConfigRoot(): string {
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Dispatch", "credentials");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dispatch", "credentials");
}

function credential(value: unknown): Credential {
  if (!value || typeof value !== "object") throw new Error("Invalid credential");
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") return { type: "api_key", key: validateSecret(candidate.key) };
  throw new Error("Invalid credential");
}

/** Host-owned credentials. Project modules and dependencies must still be trusted. */
export class UserCredentials {
  readonly store: CredentialStore;
  readonly authContext: AuthContext = { env: async () => undefined, fileExists: async () => false };
  private readonly sessions = new Map<string, Credential | "environment">();
  private readonly providers: Map<string, CredentialProvider>;
  private constructor(readonly root: string, readonly configPath: string, private readonly service: string, providers: readonly CredentialProvider[]) {
    this.providers = new Map(providers.map(provider => [provider.id, provider]));
    this.store = {
      read: (id, options) => this.read(id, options),
      list: async () => (await this.status()).filter(item => item.source !== "unconfigured").map(item => ({ providerId: item.provider, type: "api_key" as const })),
      modify: async () => { throw new CredentialError("READ_ONLY_SOURCE", "Use credential setup to change API keys. Helpers refresh their own credentials; OAuth persistence is not supported by this store."); },
      delete: id => this.remove(id),
    };
  }

  static async open(options: { root: string; providers: readonly CredentialProvider[]; configRoot?: string }): Promise<UserCredentials> {
    const root = await realpath(options.root);
    const configRoot = resolve(options.configRoot ?? defaultConfigRoot());
    if (inside(root, configRoot)) throw new CredentialError("CONFIG_UNSAFE", "Credential settings must live outside the project.");
    const ids = new Set<string>();
    for (const provider of options.providers) {
      const url = new URL(provider.origin);
      if (!/^[a-z][a-z0-9-]*$/.test(provider.id) || ids.has(provider.id) || url.protocol !== "https:"
        || url.origin !== provider.origin || !/^[A-Z][A-Z0-9_]*$/.test(provider.environmentVariable)) {
        throw new CredentialError("INVALID_PROVIDER", "Credential providers need unique IDs, HTTPS origins and explicit environment variable names.");
      }
      ids.add(provider.id);
    }
    const scope = createHash("sha256").update(root).digest("hex");
    return new UserCredentials(root, join(configRoot, `${scope}.json`), `dispatch-runner.${scope}`, options.providers);
  }

  private provider(id: string): CredentialProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new CredentialError("UNKNOWN_PROVIDER", "This application has not registered that credential provider.");
    return provider;
  }

  supports(id: string): boolean { return this.providers.has(id); }

  private async safePath(path: string, directory: boolean): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
      || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new CredentialError("CONFIG_UNSAFE", "Credential settings require a private, user-owned directory and file without symlinks.");
    }
    if (inside(this.root, await realpath(path))) throw new CredentialError("CONFIG_UNSAFE", "Credential settings must live outside the project.");
  }

  private async profile(): Promise<Profile> {
    try {
      await this.safePath(dirname(this.configPath), true);
      await this.safePath(this.configPath, false);
      if (process.platform === "win32") await privateWindowsPaths([
        { path: dirname(this.configPath), directory: true, verify: true },
        { path: this.configPath, directory: false, verify: true },
      ]);
      const file = await open(this.configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let value: unknown;
      try { value = JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
      if (!value || typeof value !== "object" || (value as Profile).version !== 1 || !(value as Profile).providers
        || typeof (value as Profile).providers !== "object" || Array.isArray((value as Profile).providers)) throw new Error("Invalid profile");
      for (const binding of Object.values((value as Profile).providers)) {
        if (!binding || typeof binding.origin !== "string" || !binding.source) throw new Error("Invalid binding");
        const source = binding.source;
        if (source.kind === "keychain" && typeof source.account === "string" && /^[a-f0-9-]{36}$/.test(source.account)) continue;
        if (source.kind === "environment") continue;
        if (source.kind === "helper" && typeof source.executable === "string" && isAbsolute(source.executable)
          && Array.isArray(source.args) && source.args.every(arg => typeof arg === "string")) continue;
        throw new Error("Invalid source");
      }
      return value as Profile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, providers: {} };
      if (error instanceof CredentialError) throw error;
      throw new CredentialError("CONFIG_UNAVAILABLE", "Cannot read credential settings. Repair their format or permissions; no fallback was used.");
    }
  }

  private async locked<T>(action: (profile: Profile) => Promise<T>): Promise<T> {
    if (process.platform === "win32") {
      await privateWindowsPaths([{ path: dirname(this.configPath), directory: true, create: true }]);
    } else {
      await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    }
    await this.safePath(dirname(this.configPath), true);
    let release: () => Promise<void>;
    try { release = await lockfile.lock(this.configPath, { realpath: false }); }
    catch { throw new CredentialError("CONFIG_BUSY", "Credential settings are busy. Retry when the other credential operation finishes."); }
    try { return await action(await this.profile()); } finally { await release(); }
  }

  private async save(profile: Profile): Promise<void> {
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(profile, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
      if (process.platform === "win32") await privateWindowsPaths([{ path: temporary, directory: false }]);
      await rename(temporary, this.configPath);
      committed = true;
    } finally { if (!committed) await rm(temporary, { force: true }); }
  }

  private binding(profile: Profile, id: string): Binding | undefined {
    const provider = this.provider(id);
    const binding = Object.hasOwn(profile.providers, id) ? profile.providers[id] : undefined;
    if (binding && binding.origin !== provider.origin) throw new CredentialError("DESTINATION_CHANGED", "The provider destination changed. Configure its credentials again before using it.");
    return binding;
  }

  private async entry(account: string) {
    try {
      if (process.platform === "win32") return new WindowsCredentialEntry(this.service, account);
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(this.service, account, { linux: { store: "secret-service" } });
    } catch { throw new CredentialError("KEYCHAIN_UNAVAILABLE", "The native credential store is unavailable. Install/unlock a supported store, configure a helper, or explicitly use session-only input."); }
  }

  private async nativeRead(account: string, options?: AuthOperationOptions): Promise<Credential> {
    try {
      const value = await (await this.entry(account)).getPassword(options?.signal);
      if (value === null) throw new Error("Missing entry");
      return credential(JSON.parse(value));
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      throw new CredentialError("KEYCHAIN_UNAVAILABLE", "The configured credential is missing, locked or unreadable. No fallback was used.");
    }
  }

  private async changeNative(account: string, value: string | null, commit: () => Promise<void>): Promise<void> {
    const entry = await this.entry(account);
    let previous: string | null;
    try {
      previous = await entry.getPassword();
      if (value === null) await entry.deleteCredential();
      else await entry.setPassword(value);
    } catch {
      throw new CredentialError("KEYCHAIN_UNAVAILABLE", "Could not update the native credential store. The configured source was retained; unlock the store and retry.");
    }
    try { await commit(); }
    catch {
      try {
        if (previous === null) await entry.deleteCredential();
        else await entry.setPassword(previous);
      } catch {
        throw new CredentialError("CREDENTIAL_RECOVERY_NEEDED", `Settings could not be saved and native rollback failed. Inspect native service ${this.service}, account ${account}, before retrying setup or removal.`);
      }
      throw new CredentialError("CONFIG_WRITE_FAILED", "Credential settings could not be saved. The native change was rolled back; repair the configuration directory and retry.");
    }
  }

  private async helper(source: Extract<Source, { kind: "helper" }>, options?: AuthOperationOptions): Promise<Credential> {
    try {
      if (!isAbsolute(source.executable) || inside(this.root, await realpath(source.executable))) throw new Error("Untrusted helper location");
      const env = { ...process.env };
      const normalize = (name: string) => process.platform === "win32" ? name.toUpperCase() : name;
      const privateNames = new Set(["NODE_OPTIONS", ...[...this.providers.values()].map(provider => provider.environmentVariable)].map(normalize));
      for (const name of Object.keys(env)) if (privateNames.has(normalize(name))) delete env[name];
      const result = await promisify(execFile)(source.executable, source.args, {
        shell: false, cwd: homedir(), env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024, signal: options?.signal,
      });
      return { type: "api_key", key: validateSecret(result.stdout) };
    } catch {
      throw new CredentialError("HELPER_FAILED", "The credential helper failed or returned an invalid key. Its output was withheld; check its installation, login and configuration.");
    }
  }

  private environment(id: string): Credential {
    const name = this.provider(id).environmentVariable;
    if (!process.env[name]) throw new CredentialError("ENVIRONMENT_MISSING", `The explicitly selected environment variable ${name} is missing.`);
    return { type: "api_key", key: validateSecret(process.env[name]) };
  }

  private async resolveSource(id: string, source: Source, options?: AuthOperationOptions): Promise<Credential> {
    if (source.kind === "keychain") return this.nativeRead(source.account, options);
    if (source.kind === "helper") return this.helper(source, options);
    return this.environment(id);
  }

  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.provider(id);
    options?.signal?.throwIfAborted();
    const session = this.sessions.get(id);
    if (session) return session === "environment" ? this.environment(id) : session;
    const binding = this.binding(await this.profile(), id);
    return binding ? this.resolveSource(id, binding.source, options) : undefined;
  }

  async status(id?: string): Promise<CredentialStatus[]> {
    const profile = await this.profile();
    return (id ? [this.provider(id)] : [...this.providers.values()]).map(provider => ({
      provider: provider.id, origin: provider.origin,
      source: this.sessions.get(provider.id) === "environment" ? "environment"
        : this.sessions.has(provider.id) ? "session" : this.binding(profile, provider.id)?.source.kind ?? "unconfigured",
    }));
  }

  useSession(id: string, key: string): void { this.provider(id); this.sessions.set(id, { type: "api_key", key: validateSecret(key) }); }
  useEnvironment(id: string): void { this.provider(id); this.sessions.set(id, "environment"); }
  clearSession(): void { this.sessions.clear(); }

  async setKey(id: string, key: string): Promise<void> {
    const provider = this.provider(id);
    const value = { type: "api_key", key: validateSecret(key) };
    await this.locked(async profile => {
      const previous = profile.providers[id]?.source;
      const account = previous?.kind === "keychain" ? previous.account : randomUUID();
      profile.providers[id] = { origin: provider.origin, source: { kind: "keychain", account } };
      await this.changeNative(account, JSON.stringify(value), () => this.save(profile));
    });
    this.sessions.delete(id);
  }

  async setHelper(id: string, executable: string, args: string[]): Promise<void> {
    const provider = this.provider(id);
    const source = { kind: "helper" as const, executable, args };
    await this.helper(source);
    await this.locked(async profile => {
      const previous = profile.providers[id]?.source;
      profile.providers[id] = { origin: provider.origin, source };
      if (previous?.kind === "keychain") await this.changeNative(previous.account, null, () => this.save(profile));
      else await this.save(profile);
    });
    this.sessions.delete(id);
  }

  async remove(id: string): Promise<void> {
    this.provider(id);
    await this.locked(async profile => {
      const source = profile.providers[id]?.source;
      delete profile.providers[id];
      if (source?.kind === "keychain") await this.changeNative(source.account, null, () => this.save(profile));
      else await this.save(profile);
    });
    this.sessions.delete(id);
  }

}
