import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AgentDoc, configure, defineDoc, type Agent, type AgentState, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import type { EvaluationFixtureBinding, EvaluationRun } from "../src/shared/evaluations.js";
import { SkillBindingsDoc, type SkillSnapshot } from "./extensions/skills.js";
import { ProjectInstructionsBindingDoc, type ProjectInstructionsBinding } from "./collaboration/project-instructions.js";

export type EvaluationBackend = "pi" | "muse-code" | "claude-agent-sdk";
type FrozenAgent = Required<Pick<AgentState, "model" | "thinkingLevel" | "instructions" | "cwd">> & {
  extensions: string[];
  tools: string[];
};

/** Execution snapshot only: no evaluator answers, credentials, or grants. Admission owns authorization and fixture claims. */
export type EvaluationBinding = {
  runId: string;
  roomId: ConversationId;
  participantId: string;
  ownerUserId: string;
  agentDefinitionId: string;
  agentRevision: number;
  profileRevision: number;
  backend: EvaluationBackend;
  configuration: EvaluationRun["configuration"];
  fixture: EvaluationFixtureBinding;
  agent: FrozenAgent;
  skills: SkillSnapshot[];
  project: ProjectInstructionsBinding;
};

export const EvaluationBindingDoc = defineDoc<{ binding: EvaluationBinding | null }>({
  kind: "dispatch.evaluation-binding", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ binding: null }),
});

/** JSON detachment must happen before a Pi transaction settles; structuredClone cannot clone Chord drafts. */
function detached<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Called only by explicit admission after independently claiming/verifying the fixture.
 * agentState is the fully configured participant (including mandatory collaboration tools),
 * not a latest catalog lookup. Candidate instructions replace, rather than append to, its instructions.
 * The existing run configuration is metadata, not a substitute for these executable snapshots.
 */
export function resolveEvaluationBinding(input: Omit<EvaluationBinding, "agent"> & {
  agentState: AgentState; instructions: string;
}): EvaluationBinding {
  const { agentState, instructions, ...binding } = input;
  if (!binding.runId || !binding.participantId || !binding.ownerUserId || !binding.agentDefinitionId
    || !Number.isSafeInteger(binding.agentRevision) || binding.agentRevision < 1
    || !Number.isSafeInteger(binding.profileRevision) || binding.profileRevision < 1)
    throw new Error("Evaluation binding requires an admitted run and pinned definition/profile identities.");
  if (!isAbsolute(binding.fixture.effectivePath) || normalize(binding.fixture.effectivePath) !== binding.fixture.effectivePath)
    throw new Error("Evaluation fixture path must be canonicalized by admission.");
  if (!agentState.model || agentState.thinkingLevel === undefined
    || !Array.isArray(agentState.extensions) || !Array.isArray(agentState.tools))
    throw new Error("Evaluation agent configuration must be explicit; inherited defaults are not frozen.");
  if (binding.configuration.model !== agentState.model.modelId || binding.configuration.provider !== agentState.model.provider
    || !isDeepStrictEqual(detached(binding.configuration.skills), binding.skills.map(({ id, revision }) => ({ id, revision }))))
    throw new Error("Evaluation metadata disagrees with its executable model or skill snapshot.");
  return detached({ ...binding, agent: {
    model: agentState.model, thinkingLevel: agentState.thinkingLevel,
    extensions: agentState.extensions, tools: agentState.tools, instructions, cwd: binding.fixture.effectivePath,
  } });
}

/**
 * Same transaction as participant creation and its admission receipt. No task is created here.
 * An identical retry checks the existing snapshot; it never repairs changed execution state.
 */
export async function bindEvaluation(tx: Tx, conversationId: ConversationId, binding: EvaluationBinding): Promise<void> {
  const doc = await tx.doc(EvaluationBindingDoc, conversationId);
  if (doc.binding) {
    if (!isDeepStrictEqual(detached(doc.binding), binding)) throw new Error("Evaluation conversation is already bound to another snapshot.");
    await assertEvaluationBinding(tx, conversationId);
    return;
  }
  // Admission has already configured the base revision's extensions/tools; only the variant
  // instructions and fixture directory differ. Refuse any other accidental configuration drift.
  const current = detached(await tx.doc(AgentDoc, conversationId));
  if (!isDeepStrictEqual({ ...current, instructions: binding.agent.instructions, cwd: binding.agent.cwd }, binding.agent))
    throw new Error("Evaluation participant does not match the frozen agent configuration.");
  await configure(tx, conversationId, { instructions: binding.agent.instructions, cwd: binding.agent.cwd });
  (await tx.doc(SkillBindingsDoc, conversationId)).skills = detached(binding.skills);
  const project = await tx.doc(ProjectInstructionsBindingDoc, conversationId);
  delete project.projectId;
  Object.assign(project, detached(binding.project));
  doc.binding = detached(binding);
}

/** Runtime adoption must return early for a bound participant, but must retain all independent authorization/Stop checks. */
export async function hasEvaluationBinding(tx: Tx, conversationId: ConversationId): Promise<boolean> {
  return (await tx.doc(EvaluationBindingDoc, conversationId)).binding !== null;
}

/** Never silently restore a changed snapshot: fail closed and leave the evidence inspectable. */
export async function assertEvaluationBinding(tx: Tx, conversationId: ConversationId): Promise<EvaluationBinding | null> {
  const binding = (await tx.doc(EvaluationBindingDoc, conversationId)).binding;
  if (!binding) return null;
  if (!isDeepStrictEqual(detached(await tx.doc(AgentDoc, conversationId)), detached(binding.agent))
    || !isDeepStrictEqual(detached((await tx.doc(SkillBindingsDoc, conversationId)).skills), detached(binding.skills))
    || !isDeepStrictEqual(detached(await tx.doc(ProjectInstructionsBindingDoc, conversationId)), detached(binding.project)))
    throw new Error("Frozen evaluation configuration changed; execution cannot continue.");
  return detached(binding);
}

/** Kept with the native preparation checkpoint. Not a permission grant or an execution receipt. */
export type NativeEvaluationPreparation = { runId: string; systemPromptSha256: string };
type NativePrepared = { cwd: string; model: string; userId: string; systemPrompt: string; evaluation?: NativeEvaluationPreparation };
type NativeScope = { roomId: ConversationId; participantId: string };

/** Capture after host preparation, before external execution. Existing owner/membership authorization remains host-owned. */
export async function prepareNativeEvaluation(tx: Tx, conversationId: ConversationId, scope: NativeScope,
  backend: Exclude<EvaluationBackend, "pi">, prepared: NativePrepared, agent: Agent | undefined): Promise<EvaluationBinding | null> {
  const binding = await assertEvaluationBinding(tx, conversationId);
  if (!binding) {
    if (prepared.evaluation) throw new Error("Native evaluation preparation has no admitted binding.");
    return null;
  }
  if (binding.roomId !== scope.roomId || binding.participantId !== scope.participantId || binding.backend !== backend
    || binding.ownerUserId !== prepared.userId || binding.agent.cwd !== prepared.cwd || binding.agent.model.modelId !== prepared.model)
    throw new Error("Native evaluation preparation disagrees with the admitted binding.");
  // A binding installed after the caller's read cannot silently convert an ordinary turn into an eval.
  if (!agent) throw new Error("Evaluation binding appeared after native configuration preparation.");
  assertEvaluationAgent(binding, agent);
  return binding;
}

/** Also check resolved selections: missing installed extensions/tools must not silently shrink an experiment. */
export function assertEvaluationAgent(binding: EvaluationBinding, agent: Agent): void {
  const resolved = { model: agent.model, thinkingLevel: agent.thinkingLevel,
    extensions: agent.extensions.map(extension => extension.name), tools: agent.tools.map(tool => tool.name),
    instructions: agent.instructions, cwd: agent.cwd };
  if (!isDeepStrictEqual(resolved, binding.agent))
    throw new Error("Frozen evaluation agent no longer resolves to its admitted configuration.");
}

export function nativeEvaluationPreparation(binding: EvaluationBinding, systemPrompt: string): NativeEvaluationPreparation {
  return { runId: binding.runId, systemPromptSha256: digest(systemPrompt) };
}

/** Recheck on every execute phase, including restart and contribution-review continuations. */
export async function assertNativeEvaluation(tx: Tx, conversationId: ConversationId, scope: NativeScope,
  backend: Exclude<EvaluationBackend, "pi">, prepared: NativePrepared, agent: Agent | undefined): Promise<void> {
  const binding = await prepareNativeEvaluation(tx, conversationId, scope, backend, prepared, agent);
  if (binding && (!prepared.evaluation || binding.runId !== prepared.evaluation.runId
    || prepared.evaluation.systemPromptSha256 !== digest(prepared.systemPrompt)))
    throw new Error("Native evaluation checkpoint does not match its frozen preparation.");
}
