import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { AuthEvent, AuthPrompt, AuthInteraction } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { promptForSecret } from "./credential-cli.js";
import { LocalCredentials } from "./local-credentials.js";
import { localModels } from "./local-provider.js";
import { terminalText } from "./terminal-output.js";

function openBrowser(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  execFile(command, args, error => { if (error) console.error("Open the sign-in URL above in your browser."); });
}

/** Render Pi's native prompts for both sign-in and provider setup. */
export function terminalInteraction(options: { noBrowser?: boolean } = {}): AuthInteraction & { signal: AbortSignal; close(): void } {
  if (!process.stdin.isTTY) throw new Error("Setup needs an interactive terminal; never pass credentials as arguments.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const notify = (event: AuthEvent) => {
    if (event.type === "auth_url") {
      console.log(terminalText(`${event.instructions ?? "Sign in in your browser:"}\n${event.url}`));
      if (!options.noBrowser && !process.env.SSH_CONNECTION) openBrowser(event.url);
    } else if (event.type === "device_code") {
      console.log(terminalText(`Open ${event.verificationUri} and enter code ${event.userCode}.`));
    } else {
      console.log(terminalText(event.message));
      if (event.type === "info") for (const link of event.links ?? []) console.log(terminalText(`${link.label ?? "More information"}: ${link.url}`));
    }
  };
  const prompt = async (request: AuthPrompt): Promise<string> => {
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
    try {
      if (request.type === "secret" || request.type === "manual_code") return await promptForSecret(terminalText(request.message), signal);
      signal.throwIfAborted();
      const input = createInterface({ input: process.stdin, output: process.stderr });
      input.once("SIGINT", cancel);
      input.once("close", cancel);
      try {
        if (request.type === "select") {
          console.error(terminalText(request.message));
          request.options.forEach((option, index) => console.error(terminalText(`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`)));
          while (true) {
            const answer = (await input.question("Choose a number: ", { signal })).trim();
            const selected = request.options.find(option => option.id === answer) ?? request.options[Number(answer) - 1];
            if (selected) return selected.id;
          }
        }
        return await input.question(`${terminalText(request.message)}: `, { signal });
      } finally {
        input.removeListener("SIGINT", cancel);
        input.removeListener("close", cancel);
        input.close();
      }
    } catch (error) {
      // A browser callback may cancel just the manual-code prompt; keep that login alive.
      if (!request.signal?.aborted) cancel();
      throw error;
    }
  };
  return { signal: controller.signal, prompt, notify, close: () => {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  } };
}

export async function loginCommand(providerId: string, options: { apiKey?: boolean; noBrowser?: boolean } = {}): Promise<void> {
  const { models, provider, credentials } = await localModels(providerId);
  const type = options.apiKey || !provider.auth.oauth ? "api_key" : "oauth";
  if (type === "api_key" && !provider.auth.apiKey?.login) throw new Error(`${providerId} uses credentials supplied in the host environment.`);
  const hostId = await credentials.hostId();
  const interaction = terminalInteraction(options);
  try {
    await models.login(providerId, type, interaction, { getDeviceId: () => hostId, agentName: "Dispatch" });
    console.log(`Signed in to ${providerId}. Start or restart your Dispatch host to use this account.`);
  } catch {
    throw new Error(interaction.signal.aborted ? "Sign-in cancelled; existing credentials were kept."
      : `Could not complete ${providerId} sign-in. Retry dispatch login ${providerId}; check provider eligibility and the browser result. Raw credential errors were withheld.`);
  } finally { interaction.close(); }
}

export async function authStatus(): Promise<void> {
  const saved = await new LocalCredentials().list();
  if (!saved.length) console.log("No saved sign-ins. Run dispatch login openai for ChatGPT, or configure a provider API key in the host environment.");
  else for (const item of saved) console.log(terminalText(`${item.providerId}\t${item.type}`));
}

export async function logoutCommand(providerId: string): Promise<void> {
  const models = createModels({ credentials: new LocalCredentials() });
  await models.logout(providerId);
  console.log(terminalText(`Removed the saved ${providerId} sign-in. Provider-side access was not revoked; environment API keys are unchanged.`));
}
