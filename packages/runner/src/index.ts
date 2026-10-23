import { createProgress } from "./progress.js";
import { createReplies } from "./replies.js";
import { createCoding } from "./coding.js";
import { createHandoffs } from "./handoff.js";
import { createConfiguration } from "./configuration.js";
import { createRuntime } from "./runtime.js";
import { createChats } from "./chat.js";
import type { LoadedAgent } from "./definition.js";

export * from "./definition.js";
export { loadRepositoryInstructions } from "./instructions.js";
export { loadSkills } from "./skills.js";
export type { Skill } from "./skills.js";
export { chatInTerminal } from "./terminal.js";
export type { TerminalOptions } from "./terminal.js";
export { UserCredentials, CredentialError } from "./credentials.js";
export type { CredentialProvider, CredentialStatus } from "./credentials.js";
export { credentialCommand, promptForSecret } from "./credential-cli.js";
export { withPrivateProviderErrors } from "./private-provider-errors.js";
export type { AgentHost, OpenOptions, RunnerState, StatusFile, StartOptions, StorageFactory } from "./runtime.js";
export type { AgentSetup } from "./configuration.js";
export type { Chat, ChatInitializer, ChatMessage, ChatService, ChatSnapshot } from "./chat.js";
export type { ReplyDestination, ReplySink } from "./replies.js";
export { context } from "./chat.js";
export { run } from "./run.js";
export type { Adapter, PreparedAdapter, RunOptions } from "./run.js";

/** Keep a namespace fixed for the lifetime of its persisted native sessions. */
export function createRunner(options: { namespace?: string; workspacePrefix?: string; progressInstructions?: (agent: LoadedAgent) => string } = {}) {
  const namespace = options.namespace ?? "dispatch";
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new Error("Invalid durable namespace.");
  const progress = createProgress(namespace);
  const replies = createReplies(namespace);
  const coding = createCoding(namespace, options.workspacePrefix);
  const handoffs = createHandoffs(namespace, progress.Progress, replies.publishReply);
  const configuration = createConfiguration(coding.codingExtension, handoffs.handoffExtension, options.progressInstructions);
  const runtime = createRuntime(namespace, configuration.agentConfiguration, handoffs.Handoffs, coding.codingEnvironment);
  const chats = createChats(namespace, runtime.openAgent, handoffs.Handoffs);
  return { namespace, ...progress, ...replies, ...coding, ...handoffs, ...configuration, ...runtime, ...chats };
}

export type Runner = ReturnType<typeof createRunner>;
