import { StringDecoder } from "node:string_decoder";
import { CredentialError, UserCredentials, validateSecret } from "./credentials.js";

/** Read from the terminal without echoing the value or adding it to history. */
export async function promptForSecret(message = "API key"): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) throw new CredentialError("TTY_REQUIRED", "Hidden credential input needs a terminal. For setup, use --stdin with a trusted secret-manager pipe.");
  const previousRaw = input.isRaw;
  const decoder = new StringDecoder("utf8");
  process.stderr.write(`${message}: `);
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let escape = "";
    const cleanup = () => {
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", end);
      process.removeListener("SIGTERM", end);
      process.removeListener("SIGINT", end);
      input.setRawMode(previousRaw);
      input.pause();
      process.stderr.write("\n");
    };
    const end = () => { cleanup(); reject(new CredentialError("CANCELLED", "Credential input cancelled.")); };
    const data = (chunk: Buffer) => {
      for (const char of decoder.write(chunk)) {
        if (char === "\u0003" || char === "\u0004") { end(); return; }
        if (escape) {
          if (escape === "\u001b" && (char === "[" || char === "O")) escape += char;
          else if (escape === "\u001b" || (char >= "@" && char <= "~")) escape = "";
          continue;
        }
        if (char === "\u001b") { escape = char; continue; }
        if (char === "\r" || char === "\n") {
          cleanup();
          try { resolve(validateSecret(value)); } catch (error) { reject(error); }
          return;
        }
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    input.on("data", data);
    input.once("end", end);
    input.once("error", end);
    process.once("SIGTERM", end);
    process.once("SIGINT", end);
  });
}

async function secretFromPipe(): Promise<string> {
  if (process.stdin.isTTY) throw new CredentialError("PIPE_REQUIRED", "--stdin requires a pipe. Omit it for hidden terminal input.");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk.toString();
    if (Buffer.byteLength(value) > 1024 * 1024) throw new CredentialError("INVALID_SECRET", "Credential input is too large.");
  }
  return validateSecret(value);
}

const usage = `Credential commands:
  login PROVIDER [--stdin]                 Save a key in the native OS store
  helper PROVIDER /absolute/program ARGS  Register and verify an existing vault helper
  status [PROVIDER] [--json]               Show source metadata without retrieving secrets
  check PROVIDER                         Resolve a key without displaying it or making an API call
  logout PROVIDER                        Remove this project's key/source (not provider-side revocation)

Keys never belong in command arguments. Helpers must print one API key; their output
is captured privately. Helper configuration is stored outside the project.\n`;

/** Optional reusable CLI; callers choose their command prefix and registered providers. */
export async function credentialCommand(credentials: UserCredentials, args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help") { process.stdout.write(usage); return; }
  if (command === "status") {
    const json = rest.includes("--json");
    const ids = rest.filter(arg => arg !== "--json");
    if (ids.length > 1) throw new CredentialError("USAGE", "status accepts at most one provider.");
    const status = await credentials.status(ids[0]);
    if (json) console.log(JSON.stringify(status));
    else for (const item of status) console.log(`${item.provider}\t${item.source}\t${item.origin}`);
    return;
  }
  const [provider, ...options] = rest;
  if (!provider) throw new CredentialError("USAGE", "A provider is required; use status to list providers.");
  if (!credentials.supports(provider)) throw new CredentialError("UNKNOWN_PROVIDER", "This application has not registered that credential provider.");
  if (command === "login") {
    if (options.some(option => option !== "--stdin") || options.length > 1) throw new CredentialError("USAGE", "login accepts only --stdin. Never put a key in an argument.");
    const key = options[0] === "--stdin" ? await secretFromPipe() : await promptForSecret(`${provider} API key (saved in your OS credential store)`);
    await credentials.setKey(provider, key);
    console.log(`Configured ${provider} with native credential storage.`);
  } else if (command === "helper") {
    const [executable, ...helperArgs] = options;
    if (!executable) throw new CredentialError("USAGE", "helper requires an absolute executable path and optional arguments.");
    await credentials.setHelper(provider, executable, helperArgs);
    console.log(`Configured ${provider} with a credential helper. The key was not saved by this application.`);
  } else if (command === "check") {
    if (options.length) throw new CredentialError("USAGE", "check accepts one provider.");
    if (!await credentials.read(provider)) throw new CredentialError("NOT_CONFIGURED", "No credential source is configured for that provider.");
    console.log(`Credential resolution succeeded for ${provider}; no provider API request was made.`);
  } else if (command === "logout") {
    if (options.length) throw new CredentialError("USAGE", "logout accepts one provider.");
    await credentials.remove(provider);
    console.log(`Removed this project's credential source for ${provider}. Revoke the key at the provider if needed.`);
  } else throw new CredentialError("USAGE", "Unknown credential command. Use help.");
}
