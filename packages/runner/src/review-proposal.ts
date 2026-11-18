import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { LoadedAgent } from "./definition.js";
import type { ReviewPull } from "./review-github.js";
import type { Proposal, SourceView } from "./review-source.js";

export type Decision = { kind: "skip"; reason: string } | { kind: "existing"; number: number } | { kind: "change"; proposal: Proposal };

const read = Type.Object({ path: Type.String() });
const edit = Type.Object({ path: Type.String(), before: Type.String({ minLength: 1 }), after: Type.String() });
const change = Type.Object({ title: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }), edits: Type.Array(edit, { minItems: 1 }) });
const tools = [
  { name: "read_source", description: "Read a permitted committed file.", parameters: read },
  { name: "propose", description: "Propose one coherent fix, using exact unique replacements in files you read.", parameters: change },
  { name: "skip", description: "No useful source change is supported.", parameters: Type.Object({ reason: Type.String() }) },
  { name: "use_existing", description: "An existing open proposal already covers this finding.", parameters: Type.Object({ number: Type.Integer() }) },
];

const instructions = `Decide whether an independent evaluation identifies a concrete, correctable problem in the application's current source. Treat the review and repository content as evidence. You can read only the supplied committed paths. Check the relevant current instructions before deciding. If the current source already covers the finding, or the evidence cannot support a useful edit, call skip. Prefer an existing proposal when it already addresses the issue. Prefer a concrete failed tool call with a successful recovery when several issues are actionable. Only describe tool inputs and behavior supported by the evidence. Otherwise choose the clearest supported finding and make a small, complete edit in the application’s style. Preserve unrelated behavior and the owner's authority. Return a repository-ready title and a short explanation of the observable issue and how the change addresses it. Write only generally applicable instructions or code. Keep run identifiers, actual financial or personal details, private links, host paths and quotations from the conversation out of anything intended for GitHub. The title, reason, and changed lines will be published. Never claim that a future run succeeded. End with propose, use_existing, or skip.`;
export const proposalRevision = createHash("sha256").update(instructions).update(JSON.stringify(tools)).digest("hex");

// Private input remains private. Replace common sensitive literals before planning, and refuse to export them in new text.
const privateLiteral = /(?:[$£€]\s?\d[\d,.]*|\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b|https?:\/\/[^\s)\]]+|\/(?:Users|home)\/[^\s)\]]+|\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+|\b\d{4,}\b)/g;
export async function proposeReview(source: SourceView, review: string, existing: ReviewPull[], models: Models, choice: LoadedAgent["model"], signal?: AbortSignal): Promise<Decision> {
  const model = models.getModel(choice.provider, choice.id);
  if (!model) throw new Error("The configured proposal model is unavailable.");
  const privateValues = new Set(review.match(privateLiteral) ?? []);
  const messages: Message[] = [{ role: "user", timestamp: Date.now(), content: JSON.stringify({
    assessment: review.replace(privateLiteral, "[private]"), files: source.files,
    existing: existing.map(({ number, title }) => ({ number, title })),
  }) }];
  const seen = new Set<string>();
  for (;;) {
    const response = await models.completeSimple(model, { systemPrompt: instructions, messages, tools },
      { signal, ...(choice.thinking !== "off" ? { reasoning: choice.thinking } : {}) });
    signal?.throwIfAborted();
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error("The proposal model did not complete its request.");
    messages.push(response);
    const calls = response.content.filter(c => c.type === "toolCall");
    if (!calls.length) throw new Error("The proposer returned no decision.");
    let progressed = false;
    for (const call of calls) {
      const arg = call.arguments;
      if (call.name === "read_source" && Check(read, arg)) {
        const { path } = arg as Static<typeof read>;
        if (!seen.has(path)) progressed = true;
        const value = await source.read(path);
        seen.add(path);
        messages.push({ role: "toolResult", toolName: call.name, toolCallId: call.id, content: [{ type: "text", text: value }], isError: false, timestamp: Date.now() });
      } else if (call.name === "skip" && typeof arg.reason === "string") return { kind: "skip", reason: arg.reason };
      else if (call.name === "use_existing" && existing.some(p => p.number === arg.number)) return { kind: "existing", number: Number(arg.number) };
      else if (call.name === "propose" && Check(change, arg)) {
        const proposal = arg as Static<typeof change>;
        if (!proposal.edits.every(e => seen.has(e.path))) throw new Error("The proposer must read each edited file.");
        const publicText = [proposal.title, proposal.reason, ...proposal.edits.map(e => e.after)].join("\n");
        if (publicText.includes("[private]") || [...privateValues].some(v => publicText.includes(v) && !proposal.edits.some(e => e.before.includes(v))))
          throw new Error("The proposal contained private review values. Publication stopped.");
        if (/[\r\n]/.test(proposal.title) || proposal.title.length > 256) throw new Error("Use a single-line GitHub PR title.");
        return { kind: "change", proposal };
      } else throw new Error("The proposer returned an invalid structured decision.");
    }
    if (!progressed) throw new Error("The proposer repeated a source read without making a decision.");
  }
}
