import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../native/windows-credentials.ps1", import.meta.url));
const failure = () => new Error("Windows Credential Manager is unavailable or the credential operation failed. Native output was withheld.");

/** Use the Windows credential APIs without a separately installed native runtime. */
export class WindowsCredentialEntry {
  private readonly target: string;

  constructor(service: string, private readonly account: string) {
    // Preserve @napi-rs/keyring 2.1.2's default Windows target and UTF-16LE blob format.
    this.target = `${account}.${service}`;
  }

  private async run(operation: "read" | "write" | "delete", signal?: AbortSignal | null, value?: string): Promise<unknown> {
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
          shell: false, windowsHide: true, cwd: homedir(), encoding: "utf8",
          timeout: 30_000, maxBuffer: 1024 * 1024, signal: signal ?? undefined,
        }, (error, stdout) => error ? reject(failure()) : resolve(stdout));
        child.stdin!.on("error", () => { child.kill(); reject(failure()); });
        // Neither command arguments nor the environment ever receive the secret.
        child.stdin!.end(JSON.stringify({ operation, target: this.target, account: this.account, value }), "utf8");
      });
      return JSON.parse(output);
    } catch { throw failure(); }
  }

  async getPassword(signal?: AbortSignal | null): Promise<string | null> {
    const value = await this.run("read", signal);
    if (value !== null && typeof value !== "string") throw failure();
    return value;
  }

  async setPassword(value: string, signal?: AbortSignal | null): Promise<void> {
    if (await this.run("write", signal, value) !== true) throw failure();
  }

  async deleteCredential(signal?: AbortSignal | null): Promise<boolean> {
    const deleted = await this.run("delete", signal);
    if (typeof deleted !== "boolean") throw failure();
    return deleted;
  }
}
