import {
  defineDoc, defineExtension, GenerationTask, hook, LiveDoc, ToolTask,
  type ConversationId, type DocumentReader, type HookApi, type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

type Evidence = { inputs: string; searched: boolean; articles: string[]; read: string[]; unavailable?: boolean };

/** Record only actual results from the host's authenticated knowledge connection. */
export function requireKnowledge(options: { namespace: string; instruction: string; allowedTools: string[] }) {
  const EvidenceDoc = defineDoc<Evidence>({
    kind: `${options.namespace}.knowledge-required`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ inputs: "", searched: false, articles: [], read: [] }), checkpointWhen: () => false,
  });
  const inputs = async (api: HookApi, ctx: Context) => (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run?.inputs.join(",") ?? "";
  const evidence = async (api: HookApi, ctx: Context) => {
    const state = await api.snapshot(EvidenceDoc, api.conversationId, ctx);
    return state?.inputs === await inputs(api, ctx) ? state : undefined;
  };
  const satisfied = (state?: Evidence | null) => !!state?.searched &&
    (!state.articles.length || state.read.some(id => state.articles.includes(id)));
  return {
    inputs,
    async record(api: ToolExecutionApi, ctx: Context, admittedInputs: string, result:
      | { search: { total: number; articles: { id: string }[] } }
      | { read: { id: string; body: string } }
      | { unavailable: true }) {
      if (!admittedInputs) return;
      await api.commit(async tx => {
        if ((await tx.doc(LiveDoc, api.conversationId)).run?.inputs.join(",") !== admittedInputs) return;
        const state = await tx.doc(EvidenceDoc, api.conversationId);
        if (state.inputs !== admittedInputs) {
          Object.assign(state, { inputs: admittedInputs, searched: false, articles: [], read: [] });
          delete state.unavailable;
        }
        if ("unavailable" in result) { state.unavailable = true; return; }
        delete state.unavailable;
        if ("search" in result) {
          const value = result.search;
          if (!Number.isInteger(value.total) || value.total < 0 || !Array.isArray(value.articles)) throw new Error("Invalid knowledge search result.");
          state.articles = value.articles.map(article => article.id).filter(id => typeof id === "string");
          state.searched = value.total === 0 || state.articles.length > 0;
        }
        if ("read" in result && result.read.body.trim() && !state.read.includes(result.read.id)) state.read.push(result.read.id);
      }, ctx);
    },
    async allowProgress(reader: DocumentReader, conversation: ConversationId, inputIds: readonly number[], ctx: Context) {
      const state = await reader.snapshot(EvidenceDoc, conversation, ctx);
      return state?.inputs === inputIds.join(",") && satisfied(state);
    },
    extension: defineExtension({
      name: `${options.namespace}.knowledge-required`,
      sections: [{ key: `${options.namespace}-knowledge-required`, render: () => options.instruction }],
      hooks: [
        hook(ToolTask, { async beforeTool(call, api, ctx) {
          if (options.allowedTools.includes(call.name) || satisfied(await evidence(api, ctx))) return;
          return { block: options.instruction };
        } }),
        hook(GenerationTask, { async onYield(_answer, api, ctx) {
          const state = await evidence(api, ctx);
          if (satisfied(state) || state?.unavailable) return;
          return { continue: options.instruction };
        } }),
      ],
    }),
  };
}
