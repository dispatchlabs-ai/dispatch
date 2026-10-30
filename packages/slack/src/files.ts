import { defineDoc, defineTask, type PhaseHandler } from "@earendil-works/pi-durable";
import type { WebClient } from "@slack/web-api";
import { type Artifact, type ArtifactSink, type ChatService, type Runner } from "@dispatch/runner";

type Input = { chat: string; artifact: Artifact; channel: string; thread: string; resume?: State };
type State = { phase: "allocate" | "upload" | "complete" | "verify"; retryAt: number; fileId?: string; uploadUrl?: string };
type Receipt = { fileId: string; permalink: string; channel: string; thread: string; sha256: string; size: number };
const code = (error: unknown) => (error as { data?: { error?: string } })?.data?.error;

/** One retained Slack file ID across upload/completion retries; never repost blindly. */
export function slackArtifacts(runner: Runner, client: WebClient, teamId: string, ready: Promise<ChatService>) {
  const Uploads = defineDoc<{ files: Record<string, State> }>({
    kind: `${runner.namespace}.slack-uploads`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ files: {} }), checkpointWhen: () => false,
  });
  const deliver: PhaseHandler<Input, State, State, Receipt, object> = async (saved, runtime, ctx) => {
    const state = saved.state.checkpoint;
    if (state.retryAt > runtime.now()) return runtime.sleepUntil(state.retryAt, state, ctx);
    const input = saved.input;
    const next = (value: State) => runtime.commit(async tx => {
      (await tx.doc(Uploads, runtime.conversationId)).files[input.artifact.id] = value;
      return { status: "running", checkpoint: value };
    }, ctx);
    const retained = await (await ready).artifact(input.chat, input.artifact.id).catch(() => undefined);
    if (!retained || retained.artifact.sha256 !== input.artifact.sha256) {
      return runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: {
        message: "Retained artifact is missing or failed integrity verification; this attempt made no external request.",
      } } }), ctx);
    }
    try {
      // Read through the conversation manifest and verify retained bytes before
      // any external effect. No model path or destination controls this read.
      const { bytes, artifact } = retained;
      if (state.phase === "allocate") {
        const response = await client.files.getUploadURLExternal({ filename: artifact.name, length: artifact.size });
        if (!response.file_id || !response.upload_url || new URL(response.upload_url).origin !== "https://files.slack.com") {
          throw new Error("Slack returned an invalid upload allocation.");
        }
        return next({ phase: "upload", retryAt: 0, fileId: response.file_id, uploadUrl: response.upload_url });
      }
      // Reconcile a completion accepted before its local checkpoint committed.
      const info = await client.files.info({ file: state.fileId! }).catch(error => {
        const failure = code(error);
        // Slack also reports unfinished external allocations as file_deleted.
        // After completion, that code is a failure, not permission to reupload.
        if (failure === "file_not_found" || failure === "file_deleted" && state.phase !== "verify") return undefined;
        throw error;
      });
      const file = info?.file;
      const shares = [...(file?.shares?.public?.[input.channel] ?? []), ...(file?.shares?.private?.[input.channel] ?? [])];
      if (file && file.id === state.fileId && shares.some(share => share.thread_ts === input.thread) && file.permalink) {
        return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: {
          fileId: state.fileId!, permalink: file.permalink!, channel: input.channel, thread: input.thread,
          sha256: artifact.sha256, size: artifact.size,
        } } }), ctx);
      }
      if (state.phase === "upload") {
        const response = await fetch(state.uploadUrl!, { method: "POST", body: new Uint8Array(bytes),
          redirect: "error", signal: runtime.signal });
        if (!response.ok) {
          // An expired/invalid URL needs operator reconciliation, not a new ID
          // that might duplicate an accepted upload.
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            return runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: {
              message: `Slack upload HTTP ${response.status}; file ${state.fileId} and original artifact retained. Reconcile before retrying.`,
            } } }), ctx);
          }
          const error = new Error(`Slack upload HTTP ${response.status}.`) as Error & { retryAfter?: number };
          error.retryAfter = Number(response.headers.get("retry-after")) || undefined;
          throw error;
        }
        return next({ phase: "complete", retryAt: 0, fileId: state.fileId });
      }
      if (state.phase === "complete") {
        try {
          await client.files.completeUploadExternal({ files: [{ id: state.fileId!, title: artifact.name }],
            channel_id: input.channel, thread_ts: input.thread });
        } catch (error) { if (!["already_complete", "file_already_complete"].includes(code(error) ?? "")) throw error; }
        return next({ phase: "verify", retryAt: 0, fileId: state.fileId });
      }
      return next({ ...state, retryAt: runtime.now() + 5_000 });
    } catch (error) {
      if (runtime.signal.aborted) throw error;
      const failure = code(error);
      // Return only safe provider codes, never token-bearing request objects.
      const message = `Slack artifact ${state.phase}: ${failure ?? "request failed"}; original bytes and any allocated upload identity retained.`;
      runtime.report(new Error(message));
      if (failure && !["ratelimited", "internal_error", "service_unavailable", "request_timeout"].includes(failure)) {
        return runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }), ctx);
      }
      const retryAfter = (error as { retryAfter?: number })?.retryAfter;
      return next({ ...state, retryAt: runtime.now() + (retryAfter && retryAfter > 0 ? retryAfter * 1000 : 30_000) });
    }
  };
  const task = defineTask<Input, State, Receipt>({
    name: `${runner.namespace}.slack-artifact`, version: 1,
    initial: input => input.resume ?? { phase: "allocate", retryAt: 0 },
    phases: { allocate: deliver, upload: deliver, complete: deliver, verify: deliver },
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
  const queue: ArtifactSink = async (tx, conversationId, artifact) => {
    const chats = await tx.doc(runner.Chats);
    const chat = Object.values(chats.byId).find(chat => chat.conversationId === conversationId);
    if (chat?.source !== "slack") return [];
    const route = chat.origin?.slack as { teamId?: string; channelId?: string; threadTs?: string } | undefined;
    if (!route || route.teamId !== teamId || !route.channelId || !route.threadTs) {
      throw new Error("Artifact delivery requires this conversation's authenticated Slack origin.");
    }
    const taskId = await tx.createTask(task, {
      chat: chat.id, artifact, channel: route.channelId, thread: route.threadTs,
      resume: (await tx.doc(Uploads, conversationId)).files[artifact.id],
    }, { conversationId, ownership: { kind: "conversation" }, background: true });
    return [{ transport: "slack", taskId }];
  };
  return { task, queue };
}
