import { Type } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension, defineTool,
  type AgentChange, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { delegationResult, delegationReceipts, observations } from "./delegation-receipts.js";
import { createDelegationWorkers } from "./delegation-workers.js";

type Delegate = { name: string; description: string; fingerprint: string; configuration: AgentChange };

/** Owned native workers; new input releases the foreground wait without abandoning the child. */
export function delegationExtension(owner: string, agents: Delegate[], clones = false) {
  const workers = createDelegationWorkers(owner);
  async function runChild(agent: string, task: string, configuration: AgentChange | undefined, api: ToolExecutionApi, context: Context, fingerprint?: string): Promise<ToolExecutionResult> {
    // Old persisted calls own their child directly. Ownership is immutable: recover
    // that exact child with the old wait rather than duplicate or reparent its work.
    const childId = await api.commit(async tx =>
      (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0]?.id, context);
    if (childId === undefined) return workers.run(agent, task, configuration, api, context, fingerprint);
    const startedAt = await api.memo("startedAt", api.now(), context);
    await api.details({ agent, conversationId: childId }, context);
    const child = await api.conversation(childId, context);
    if (!child) throw new Error("Delegate conversation disappeared.");
    // Preserve the existing request identity for interrupted delegate calls.
    const submission = await (await child.submit({ type: "input", content: task, requestId: `delegate:${api.taskId}` }, context)).wait(context);
    const parent = await api.agent(context);
    return delegationResult(api, childId, submission, {
      agent, ...(fingerprint ? { fingerprint } : {}), startedAt,
      model: configuration?.model ?? parent.model,
      thinking: configuration?.thinkingLevel ?? parent.thinkingLevel,
    }, context);
  }
  const tools: ToolRegistration[] = [];
  if (agents.length) tools.push(
    defineTool({
      name: "list_agents",
      description: "Inspect your configured delegates and your own model: purpose, model/thinking, declared tools, host catalog prices and observations from this conversation's retained delegation receipts. No inference or credential probe. Use before choosing unfamiliar workers; refresh when availability or prices matter.",
      parameters: Type.Object({}),
      replay: "safe",
      async execute(_args, api, context) {
        const parent = await api.agent(context);
        const receipts = await delegationReceipts(api, context);
        const modelCard = (ref: AgentChange["model"]) => {
          const model = ref ? api.models.getModel(ref.provider, ref.modelId) : undefined;
          return {
            selection: ref ?? null, registered: !!model,
            ...(model ? { contextWindow: model.contextWindow, input: model.input, rates: model.cost } : {}),
          };
        };
        const catalog = {
          observedAt: new Date(api.now()).toISOString(),
          pricing: { currency: "USD", unit: "per_million_tokens", source: "host_model_catalog", billingVerified: false },
          notes: "Registration is not a live availability check. Catalog rates can be stale or zero placeholders; subscription billing can differ. Declared tools remain subject to inherited filters and host permissions. Observations cover recorded receipts for this exact definition in this conversation; answered is not a quality verdict or comparable-task benchmark. Receipt costs exclude the coordinator; include coordination and retry costs in your choice.",
          coordinator: { agent: owner, thinking: parent.thinkingLevel, ...modelCard(parent.model) },
          agents: agents.map(agent => ({
            agent: agent.name, description: agent.description, thinking: agent.configuration.thinkingLevel,
            ...modelCard(agent.configuration.model),
            declaredTools: [...new Set((Array.isArray(agent.configuration.extensions) ? agent.configuration.extensions : [])
              .flatMap(extension => extension.tools?.map((tool: ToolRegistration) => tool.name) ?? []))],
            observations: observations(receipts, agent.name, agent.fingerprint),
          })),
        };
        return { output: [{ type: "text", text: JSON.stringify(catalog) }] };
      },
    }),
    defineTool({
      name: "delegate",
      description: `Delegate a complete assignment; wait for its result and recorded usage/cost receipt. New user input releases the wait while the child continues; use steer_child, cancel_child or wait_for_child with its conversationId. list_agents provides model prices and capabilities. Parallel calls create independent children, including multiple instances of the same definition. Assign disjoint files to concurrent editors. Available agents: ${agents.map(agent => agent.name).join(", ")}`,
      parameters: Type.Object({ agent: Type.String(), task: Type.String({ minLength: 1 }), reason: Type.Optional(Type.String({ description: "Brief reason this worker fits the task and expected total cost." })) }),
      replay: "safe",
      async execute({ agent, task }, api, context) {
        const target = agents.find(candidate => candidate.name === agent);
        if (!target) throw new Error(`Unknown delegate: ${agent}`);
        return runChild(agent, task, target.configuration, api, context, target.fingerprint);
      },
    }));
  if (clones) tools.push(defineTool({
      name: "clone_agent",
      description: "Create a fresh, private child with your current instructions, model, thinking level, extensions and tool filters, but no conversation history. Send a complete bounded assignment and necessary context. Waits for its report, but new user input releases the wait while the child continues. Use steer_child, cancel_child or wait_for_child with its conversationId. Completion is not acceptance. Replaying this call recovers the same child. Host permissions still apply; use isolated resources for concurrent work.",
      parameters: Type.Object({ task: Type.String({ minLength: 1 }) }),
      replay: "safe",
      execute({ task }, api, context) {
        return runChild(owner, task, undefined, api, context);
      },
    }));
  return defineExtension({ name: `dispatch.delegation.${owner}`,
    tasks: [workers.task], tools: [...tools, ...workers.tools],
    sections: [{ key: "delegated-work", render: () =>
      "A new user message releases a delegation wait; it does not stop the child. Handle the latest instruction, use steer_child or cancel_child as needed, then use wait_for_child for each outstanding assignment before claiming completion. Keep the original request active through status questions; give a brief commentary update and resume waiting. Results are retained durably but are not sent automatically. A worker report is evidence to assess, not proof that the user's goal is complete." }],
  });
}
