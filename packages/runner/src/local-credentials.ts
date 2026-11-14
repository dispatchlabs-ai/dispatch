import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { privateWindowsPaths } from "./windows-permissions.js";

type SavedAuth = { version: 1; hostId: string; providers: Record<string, Credential> };

export function localAuthDirectory(): string {
  const base = process.platform === "win32"
    ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Dispatch")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dispatch");
  return resolve(process.env.DISPATCH_AUTH_DIR ?? base);
}

/** Application-owned persistence; Pi owns login, token resolution and refresh. */
export class LocalCredentials implements CredentialStore {
  readonly path: string;
  constructor(readonly directory = localAuthDirectory()) { this.path = join(directory, "auth.json"); }

  private async checkPath(path: string, directory: boolean): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
      || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) {
      throw new Error("Dispatch sign-in storage must be private and owned by your user, without symlinks.");
    }
    if (process.platform === "win32") await privateWindowsPaths([{ path, directory, verify: true }]);
  }

  private async load(): Promise<SavedAuth | undefined> {
    try {
      await this.checkPath(this.directory, true);
      await this.checkPath(this.path, false);
      const file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let value: SavedAuth;
      try { value = JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
      if (value?.version !== 1 || !/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value.hostId)
        || !value.providers || typeof value.providers !== "object" || Array.isArray(value.providers)) throw new Error();
      for (const [id, credential] of Object.entries(value.providers)) {
        if (!id || !credential || typeof credential !== "object") throw new Error();
        if (credential.type === "oauth") {
          if (typeof credential.access !== "string" || !credential.access || typeof credential.refresh !== "string"
            || !credential.refresh || !Number.isFinite(credential.expires)) throw new Error();
        } else if (credential.type !== "api_key") throw new Error();
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot read Dispatch sign-in storage. Check its format and private permissions; no other credentials were substituted.");
    }
  }

  private async save(value: SavedAuth): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); }
      if (process.platform === "win32") await privateWindowsPaths([{ path: temporary, directory: false }]);
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }

  private async change<T>(action: (value: SavedAuth) => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    if (process.platform === "win32") await privateWindowsPaths([{ path: this.directory, directory: true, create: true }]);
    else await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkPath(this.directory, true);
    let release: (() => Promise<void>) | undefined;
    let compromised: Error | undefined;
    while (!release) {
      options?.signal?.throwIfAborted();
      try { release = await lockfile.lock(this.path, { realpath: false, onCompromised: error => { compromised = error; } }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw new Error("Cannot lock Dispatch sign-in storage.");
        await setTimeout(100, undefined, { signal: options?.signal });
      }
    }
    try {
      options?.signal?.throwIfAborted();
      const value = await this.load() ?? { version: 1, hostId: randomUUID(), providers: {} };
      const result = await action(value);
      if (compromised) throw new Error("Dispatch sign-in storage lock was lost.");
      // Persist a completed refresh even if the requesting turn was cancelled: its token may have rotated.
      await this.save(value);
      return result;
    } finally { await release(); }
  }

  async hostId(): Promise<string> { return this.change(async value => value.hostId); }
  async read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const saved = await this.load();
    return saved && Object.hasOwn(saved.providers, id) ? saved.providers[id] : undefined;
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries((await this.load())?.providers ?? {}).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (!id) throw new Error("Invalid sign-in provider.");
    return this.change(async value => {
      const current = Object.hasOwn(value.providers, id) ? value.providers[id] : undefined;
      const next = await fn(current);
      if (next !== undefined) Object.defineProperty(value.providers, id, { value: next, enumerable: true, writable: true, configurable: true });
      return next ?? current;
    }, options);
  }
  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    await this.change(async value => { delete value.providers[id]; }, options);
  }
}
