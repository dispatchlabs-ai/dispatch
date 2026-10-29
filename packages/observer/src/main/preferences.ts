import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  connectionSchema,
  type ConnectionDraft,
  type Preferences,
  type SavedConnection,
} from "../shared/contracts";

type Stored = { connection: SavedConnection; encrypted?: string };
export class PreferenceStore {
  private items: Stored[] = [];
  private passwords = new Map<string, string>();
  private selected?: string;
  private appearance: Preferences["theme"] = "system";
  private path = join(app.getPath("userData"), "connections.json");
  private pendingWrite: Promise<void> = Promise.resolve();
  private async secure() {
    return (
      (await safeStorage.isAsyncEncryptionAvailable()) &&
      (process.platform !== "linux" ||
        safeStorage.getSelectedStorageBackend() !== "basic_text")
    );
  }
  async load() {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const data = JSON.parse(content);
    if (data.version !== 1 || !Array.isArray(data.connections))
      throw new Error(
        "Connection preferences have an unsupported format. They have been preserved.",
      );
    this.items = data.connections.map((item: Stored) => ({
      connection: {
        ...connectionSchema.parse(item.connection),
        hasSecret: Boolean(item.encrypted),
        secretSaved: Boolean(item.encrypted),
      },
      encrypted:
        typeof item.encrypted === "string" ? item.encrypted : undefined,
    }));
    this.selected =
      typeof data.lastConnection === "string"
        ? data.lastConnection
        : undefined;
    if (["system", "light", "dark"].includes(data.theme))
      this.appearance = data.theme;
  }
  get(): Preferences {
    // Checking encryption availability can prompt; ordinary preferences must not.
    return {
      connections: this.items.map((item) => ({
        ...item.connection,
        hasSecret:
          Boolean(item.encrypted) || this.passwords.has(item.connection.id),
        secretSaved: Boolean(item.encrypted),
      })),
      lastConnection: this.selected,
      theme: this.appearance,
      platform: process.platform,
    };
  }
  find(id: string) {
    const item = this.items.find((item) => item.connection.id === id);
    if (!item) throw new Error("This connection no longer exists");
    return item.connection;
  }
  async password(id: string): Promise<string | undefined> {
    if (this.passwords.has(id)) return this.passwords.get(id);
    const encrypted = this.items.find(
      (item) => item.connection.id === id,
    )?.encrypted;
    if (!encrypted) return undefined;
    if (!(await this.secure()))
      throw new Error(
        "The operating system credential store is unavailable. Unlock it or enter a session-only password in Edit connection.",
      );
    try {
      return (
        await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"))
      ).result;
    } catch {
      throw new Error(
        "The saved password could not be unlocked. Re-enter it in Edit connection.",
      );
    }
  }
  async save(draft: ConnectionDraft): Promise<SavedConnection> {
    const password =
      draft.password ?? (await this.password(draft.connection.id));
    if (draft.rememberSecret && password && !(await this.secure()))
      throw new Error(
        "Protected credential storage is unavailable. Turn off Save password to use it only for this app session.",
      );
    const encrypted =
      draft.rememberSecret && password
        ? (await safeStorage.encryptStringAsync(password)).toString("base64")
        : undefined;
    const connection = {
      ...draft.connection,
      hasSecret: Boolean(password),
      secretSaved: Boolean(encrypted),
    };
    const previous = this.items;
    this.items = [
      ...this.items.filter((item) => item.connection.id !== connection.id),
      { connection, encrypted },
    ];
    try {
      await this.write();
    } catch (error) {
      this.items = previous;
      throw error;
    }
    if (password !== undefined) this.passwords.set(connection.id, password);
    return connection;
  }
  async remove(id: string) {
    this.items = this.items.filter((item) => item.connection.id !== id);
    this.passwords.delete(id);
    if (this.selected === id) this.selected = undefined;
    await this.write();
  }
  async select(id: string) {
    this.selected = id;
    await this.write();
  }
  async theme(value: Preferences["theme"]) {
    this.appearance = value;
    await this.write();
  }
  private write() {
    const content = `${JSON.stringify({ version: 1, connections: this.items, lastConnection: this.selected, theme: this.appearance }, null, 2)}\n`;
    const write = this.pendingWrite
      .catch(() => {})
      .then(async () => {
        await mkdir(app.getPath("userData"), {
          recursive: true,
          mode: 0o700,
        });
        const temporary = `${this.path}.tmp`;
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, this.path);
      });
    this.pendingWrite = write;
    return write;
  }
}
