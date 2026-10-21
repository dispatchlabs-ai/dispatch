import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** Windows ships this bridge; users need neither an SDK nor a permissions command. */
export async function privateWindowsPaths(paths: { path: string; directory: boolean; create?: boolean; verify?: boolean }[]): Promise<void> {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = fileURLToPath(new URL("../native/windows-permissions.ps1", import.meta.url));
  const payload = Buffer.from(JSON.stringify(paths.map(path => ({ ...path, path: resolve(path.path) })))).toString("base64");
  try {
    await promisify(execFile)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, payload], {
      windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("Cannot protect local files for your Windows account. Use a local folder you own on an NTFS drive and keep Windows PowerShell available.");
  }
}
