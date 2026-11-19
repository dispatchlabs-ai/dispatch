import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { loadAgent } from "./definition.js";
import { hostModels } from "./host-models.js";
import { retainedRun } from "./run-evidence.js";
import { reviewRun } from "./run-review.js";
import type { ServiceConfig } from "./service.js";
import { serviceSettings } from "./settings.js";
import { terminalText } from "./terminal-output.js";

import { ReviewPending } from "./review-group.js";
import { configuredReviewActions } from "./review-actions.js";

export async function reviewCommand(config: ServiceConfig, name: string, submission: number, action?: "prepare" | "publish") {
  // A chat's runs are in the chat's own store. An agent's scheduled runs are in the agent's.
  const [agentName, chat] = name.split(":");
  if (chat !== undefined && !/^[0-9]+$/.test(chat)) throw new Error("Name an agent, or a chat such as researcher:12.");
  const agent = await loadAgent(config.root, agentName);
  const directory = chat ? join(config.stateRoot, agent.id, "chats", chat) : join(config.stateRoot, agent.id);
  const run = retainedRun(join(directory, "session.sqlite"), submission);
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const connection = hostModels(config, config.cwd);
  try {
    await connection.connect(models);
    const model = config.demo ? { provider: "faux", id: "faux-1", thinking: "off" as const } : agent.model;
    const result = await reviewRun({ directory, agent: agent.id, model, models, settings: serviceSettings(config, models) }, run, BACKGROUND_CONTEXT, true);
    console.log(terminalText(result.text));
    console.error(terminalText(`Saved: ${result.report}`));
    if (action) {
      const handler = configuredReviewActions(config);
      if (!handler) throw new Error("Configure a review action in the host file first.");
      const output = await handler({ directory, agent: agent.id, run, report: result.report, model, models, settings: serviceSettings(config, models) }, undefined, action === "prepare")
        .catch(error => { if (error instanceof ReviewPending) return error.message; throw error; });
      if (output) console.error(terminalText(output));
    }
  } finally { await connection.close(); }
}
