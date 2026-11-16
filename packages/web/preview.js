import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "./package.json" with { type: "json" };

/** Serve a private set of preview installations with the normal Web sign-in and client. */
export async function previewWeb({ installations, port, username, signal }) {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(await realpath(tmpdir()), "dispatch-preview-"));
  const write = async (name, contents) => {
    const path = join(directory, name);
    await writeFile(path, contents, { mode: 0o600, flag: "wx" });
    return path;
  };
  try {
    const config = await write("web.json", JSON.stringify({ installations }));
    const password = randomBytes(12).toString("base64url");
    const salt = randomBytes(16);
    const credential = await write("credential.json", JSON.stringify({
      username, salt: salt.toString("hex"), hash: scryptSync(password, salt, 64).toString("hex"),
    }));
    const signIn = process.stdout.isTTY ? `Preview password: ${password}`
      : `Private preview password file: ${await write("sign-in-code", password + "\n")}`;
    const cli = new URL(manifest.bin["dispatch-web"], import.meta.url);
    signal.throwIfAborted();
    const web = spawn(process.execPath, [fileURLToPath(cli), "--port", String(port)], {
      cwd: directory, stdio: "inherit", env: { HOME: homedir(), PATH: process.env.PATH, DISPATCH_CONFIG: config,
        DISPATCH_AUTH_MODULE: fileURLToPath(new URL("session-auth.js", cli)), DISPATCH_SESSION_AUTH_FILE: credential,
        DISPATCH_SESSION_STATE_FILE: join(directory, "sessions.json") },
    });
    const stop = () => web.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    try {
      console.log(`Preview: http://127.0.0.1:${port}\nUsername: ${username}\n${signIn}`);
      const [code, exitSignal] = await once(web, "close");
      if (!signal.aborted && code !== 0) throw new Error(`Preview Web stopped (${exitSignal ?? code}).`);
    } finally { signal.removeEventListener("abort", stop); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
