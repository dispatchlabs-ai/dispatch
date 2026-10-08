import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { openConfiguredProviderCredentials, readProviderCredentialConfig } from "./storage/provider-credential-config.js";

const help = `Stopped-backend provider authorization (operator credential authority)

  node build/service/server/provider-auth-cli.js list --config /absolute/config.json --confirm-backend-retired
  node build/service/server/provider-auth-cli.js login --provider PROVIDER --type oauth|api_key --config /absolute/config.json --confirm-backend-retired
  node build/service/server/provider-auth-cli.js logout --provider PROVIDER --config /absolute/config.json --confirm-backend-retired

Config: {installationId, databaseUrlFile, databaseCaFile, encryptionKeyFile}.
Key: separate 32 raw random bytes; key and URL files must be private regular files
owned by this service UID, mode 0600. Run under the backend service UID. TLS is mandatory.

Stop and confirm retirement of the backend AND any previous maintenance process.
Draining or losing a DB session is not retirement. After a crash only, pass
--recover-owner-id UUID matching the retained installation owner_id. Recovery is
an operator assertion, not automatic detection of old-process/container death.

Login requires a private interactive terminal (no recording). All input is hidden;
authorization URLs/device codes appear only on that terminal. Native Pi owns login,
PKCE, callbacks and token exchange. Callbacks bind only to 127.0.0.1. When remote,
use Pi's manual-code flow or an authenticated loopback-only SSH tunnel, never a
public port mapping. No native auth.json is read or copied. No tokens in argv.

Existing/pending credentials require explicit logout before fresh login. Logout
only deletes local credentials; revoke at the provider separately when needed.
SIGINT/SIGTERM cancel prompts but wait for an admitted exchange and persistence.
Do not restart the backend until this command exits; never force takeover.
`;

class UsageError extends Error {}
const safeText = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
const line = (message: string) => process.stderr.write(`${safeText(message)}\n`);

/** UUIDv5: public, stable installation device identity without another state file. */
function deviceId(installation: string) {
  const bytes = createHash("sha1").update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex")).update(`urn:dispatch:provider-auth:${installation}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Suppress echo for every prompt: providers can request secrets as text too. */
async function prompt(input: AuthPrompt, stop: AbortController): Promise<string> {
  const signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
  signal.throwIfAborted();
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  // Enter raw/no-echo mode before publishing the prompt. Otherwise an immediate
  // paste can reach the terminal driver while echo is still enabled.
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  line(input.message);
  if (input.type === "select") input.options.forEach((option, index) => line(`${index + 1}. ${option.label}`));
  line("Input is hidden; press Enter to submit.");
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      const abort = () => reject(new UsageError("Authorization prompt cancelled."));
      const interrupt = () => stop.abort();
      signal.addEventListener("abort", abort, { once: true });
      terminal.once("SIGINT", interrupt);
      terminal.once("close", abort);
      terminal.question("", value => {
        signal.removeEventListener("abort", abort);
        terminal.off("SIGINT", interrupt);
        terminal.off("close", abort);
        resolve(value);
      });
      if (signal.aborted) abort();
      // Removed for both success and cancellation by the enclosing finally.
      terminal.once("close", () => signal.removeEventListener("abort", abort));
    });
    if (input.type !== "select") return answer;
    const index = Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || !input.options[index]) throw new UsageError("Invalid login selection; start a fresh authorization attempt.");
    return input.options[index]!.id;
  } finally {
    terminal.close();
    output.destroy();
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

function notify(event: AuthEvent) {
  // Called only for interactive login. Do not forward generic provider messages:
  // they may contain response bodies. Print only the interaction's necessary fields.
  if (event.type === "auth_url") {
    if (new URL(event.url).protocol !== "https:") throw new UsageError("Authorization requires an HTTPS provider URL.");
    line("Open this URL privately in your browser:"); line(event.url);
  } else if (event.type === "device_code") {
    if (new URL(event.verificationUri).protocol !== "https:") throw new UsageError("Authorization requires an HTTPS verification URL.");
    line(event.verificationUri); line(`Device code: ${event.userCode}`);
  } else {
    line("Provider authorization in progress.");
  }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: "string" }, provider: { type: "string" }, type: { type: "string" },
    "confirm-backend-retired": { type: "boolean" }, "recover-owner-id": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["list", "login", "logout"].includes(command!) || !values.config?.startsWith("/"))
    throw new UsageError("Use list, login or logout with an absolute --config path. See --help.");
  if (!values["confirm-backend-retired"]) throw new UsageError("Confirm backend and previous maintenance-owner retirement before opening credentials.");
  const recovery = values["recover-owner-id"];
  if (recovery && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recovery)) throw new UsageError("Recovery requires the exact recorded owner UUID.");
  if (command !== "list" && !values.provider) throw new UsageError("Specify --provider.");
  if (command === "list" && (values.provider || values.type) || command === "logout" && values.type) throw new UsageError("Unexpected provider/type option for this command.");
  if (command === "login" && (values.type !== "oauth" && values.type !== "api_key")) throw new UsageError("Login requires --type oauth or --type api_key.");
  if (command === "login" && (!process.stdin.isTTY || !process.stderr.isTTY)) throw new UsageError("Login requires a private interactive terminal; piped credentials are not accepted.");
  // Set before importing Pi: some native providers capture this at module load.
  process.env.PI_OAUTH_CALLBACK_HOST = "127.0.0.1";
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const config = await readProviderCredentialConfig(values.config);
  const stop = new AbortController();
  const onStop = () => {
    if (!stop.signal.aborted) line("Stop requested; cancelling prompts, awaiting admitted provider work and persistence.");
    stop.abort();
  };
  process.on("SIGINT", onStop); process.on("SIGTERM", onStop);
  let store: Awaited<ReturnType<typeof openConfiguredProviderCredentials>> | undefined;
  try {
    store = await openConfiguredProviderCredentials(config, recovery);
    line(`Credential maintenance owner: ${store.ownerId}`);
    stop.signal.throwIfAborted();
    const models = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    if (command === "list") {
      console.log(JSON.stringify({ credentials: await models.listCredentials(), note: "Stored metadata only; not a token-validity or pending-intent check." }));
    } else if (command === "logout") {
      await models.logout(values.provider!);
      line("Stored credential deleted. Upstream revocation was not performed.");
    } else {
      // Pi performs interactive login outside CredentialStore.modify(). Never
      // risk silently retaining an old grant during an uncertain new authorization.
      if (await store.read(values.provider!)) throw new UsageError("Existing credential found. Explicitly logout before authorizing again.");
      // Do not abort Pi's outer login promise mid-exchange: it races cancellation
      // and could discard returned credentials. Only cancel prompts; join login.
      await models.login(values.provider!, values.type as "oauth" | "api_key", {
        prompt: input => prompt(input, stop), notify,
      }, { getDeviceId: () => deviceId(config.installationId) });
      line("Provider credential persisted.");
    }
  } finally {
    try { await store?.close(); }
    finally {
      process.off("SIGINT", onStop); process.off("SIGTERM", onStop);
      if (stop.signal.aborted) process.exitCode = 130;
    }
  }
}

try { await main(); }
catch (error) {
  // Native provider errors may contain tokens, URLs, response bodies or a
  // CredentialSynchronizationError. Never print the error or its nested cause.
  console.error(error instanceof UsageError ? error.message : "Provider maintenance failed; outcome may be uncertain. Inspect stored metadata and owner state before explicit recovery or reauthorization.");
  process.exitCode = 1;
}
