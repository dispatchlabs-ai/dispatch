import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ChatSnapshot, RuntimeScope } from "../../src/shared/contracts.js";
import { DispatchRuntime } from "../../server/runtime.js";

export const scope: RuntimeScope = { companyId: "dispatch", userId: "alice" };
export function scriptedModels(text = "A completed response.", tokensPerSecond?: number) {
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond, tokenSize: { min: 1, max: 1 } });
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage(text)));
  models.setProvider(faux.provider);
  return { models, faux };
}
export function openRuntime(stateDir: string, models = scriptedModels().models) {
  return DispatchRuntime.open({ stateDir, models, provider: "faux", modelId: "faux-1", settings: { retry: { maxRetries: 0 } } });
}
export async function waitFor(runtime: DispatchRuntime, id: string, predicate: (snapshot: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
  const watch = await runtime.watchChat(scope, id);
  try {
    if (predicate(watch.value)) return watch.value;
    return await new Promise<ChatSnapshot>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for a conversation state.")), 15_000);
      watch.start(async (snapshot) => { if (predicate(snapshot)) { clearTimeout(timeout); resolve(snapshot); } });
      watch.closed.then((end) => { clearTimeout(timeout); if (end.reason !== "stopped") reject(new Error(`Watch ended: ${end.reason}`)); });
    });
  } finally { await watch.stop(); }
}
export function hasPartial(snapshot: ChatSnapshot) {
  const live = snapshot.view.docs["pi.live"] as { generation?: { message?: { content?: unknown[] } } } | undefined;
  return (live?.generation?.message?.content?.length ?? 0) > 0;
}
