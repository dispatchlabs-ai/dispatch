import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { DispatchRuntime } from "../../server/runtime.js";
import { openRuntime, scriptedModels, scope, waitFor, hasPartial } from "./helpers.js";

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), "dispatch-runtime-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("private independent chats, native entries and admission idempotency survive a reopen", async (t) => {
  const stateDir = await directory(t);
  const { models, faux } = scriptedModels();
  let runtime = await openRuntime(stateDir, models);
  t.after(() => runtime.close());
  const [first, duplicate] = await Promise.all([
    runtime.createChat(scope, { requestId: "create-one" }),
    runtime.createChat(scope, { requestId: "create-one" }),
  ]);
  assert.equal(first.conversation.id, duplicate.conversation.id);
  const other = await runtime.createChat(scope, { requestId: "create-two" });
  const [a, b] = await Promise.all([
    runtime.submit(scope, first.conversation.id, { requestId: "message-one", text: "First independent conversation" }),
    runtime.submit(scope, first.conversation.id, { requestId: "message-one", text: "First independent conversation" }),
  ]);
  assert.equal(a.id, b.id);
  await runtime.submit(scope, other.conversation.id, { requestId: "message-one", text: "Second independent conversation" });
  const done = await waitFor(runtime, first.conversation.id, (snapshot) => snapshot.submissions.at(-1)?.status === "done");
  await waitFor(runtime, other.conversation.id, (snapshot) => snapshot.submissions.at(-1)?.status === "done");
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(done.view.entries.map((entry) => entry.kind), ["pi.user", "pi.system", "pi.assistant"]);
  assert.equal(done.conversation.title, "First independent conversation");
  assert.equal(done.submissions.length, 1);
  assert.equal((await runtime.listChats({ ...scope, userId: "bob" })).length, 0);
  for (const outsider of [{ ...scope, userId: "bob" }, { ...scope, companyId: "other" }]) {
    await assert.rejects(runtime.getChat(outsider, first.conversation.id), /not found/);
    await assert.rejects(runtime.watchChat(outsider, first.conversation.id), /not found/);
    await assert.rejects(runtime.submit(outsider, first.conversation.id, { requestId: "attack", text: "No" }), /not found/);
    await assert.rejects(runtime.stop(outsider, first.conversation.id), /not found/);
  }
  await runtime.close();
  runtime = await openRuntime(stateDir, models);
  const restored = await runtime.getChat(scope, first.conversation.id);
  assert.deepEqual(restored.view, done.view);
  assert.equal((await runtime.submit(scope, first.conversation.id, { requestId: "message-one", text: "First independent conversation" })).id, a.id);
  assert.equal(faux.state.callCount, 2);
});

test("disconnect only stops observation; slow watchers and new attachments receive committed snapshots", async (t) => {
  const stateDir = await directory(t);
  const runtime = await openRuntime(stateDir, scriptedModels("Streaming the entire answer continues after the browser disconnects.", 50).models);
  t.after(() => runtime.close());
  const chat = await runtime.createChat(scope, { requestId: "create" });
  const watch = await runtime.watchChat(scope, chat.conversation.id);
  const seen: number[] = [];
  watch.start(async (snapshot) => { seen.push(snapshot.view.entries.length); await delay(100); });
  await runtime.submit(scope, chat.conversation.id, { requestId: "stream", text: "Keep working." });
  await waitFor(runtime, chat.conversation.id, hasPartial);
  await watch.stop();
  const finished = await waitFor(runtime, chat.conversation.id, (snapshot) => snapshot.submissions.at(-1)?.status === "done");
  const reattached = await runtime.watchChat(scope, chat.conversation.id);
  assert.deepEqual(reattached.value.view, finished.view);
  assert.equal(reattached.value.conversation.status, "idle");
  assert.ok(seen.length > 0);
  await reattached.stop();
});

test("Stop preserves native partial output and withdraws queued work", async (t) => {
  const stateDir = await directory(t);
  const runtime = await openRuntime(stateDir, scriptedModels("A long response that should be explicitly stopped before it finishes. ".repeat(30), 30).models);
  t.after(() => runtime.close());
  const chat = await runtime.createChat(scope, { requestId: "stop-chat" });
  await runtime.submit(scope, chat.conversation.id, { requestId: "running", text: "Start." });
  await waitFor(runtime, chat.conversation.id, hasPartial);
  await runtime.submit(scope, chat.conversation.id, { requestId: "queued", text: "Follow up." });
  const stopped = await runtime.stop(scope, chat.conversation.id);
  assert.equal(stopped.conversation.status, "stopped");
  assert.ok(stopped.submissions.every((submission) => submission.status === "unanswered" && submission.reason === "aborted"));
  assert.equal(stopped.view.docs["pi.live"]?.run, undefined);
  const lastAssistant = stopped.view.entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "assistant").at(-1);
  assert.equal(lastAssistant?.stopReason, "aborted");
});

test("Stop before the first token is distinguishable from a completed answer", async (t) => {
  const stateDir = await directory(t);
  const runtime = await openRuntime(stateDir, scriptedModels("This answer must not complete.", 1).models);
  t.after(() => runtime.close());
  const chat = await runtime.createChat(scope, { requestId: "early-stop-chat" });
  await runtime.submit(scope, chat.conversation.id, { requestId: "early-stop", text: "Begin." });
  const stopped = await runtime.stop(scope, chat.conversation.id);
  assert.equal(stopped.conversation.status, "stopped");
  assert.equal(stopped.submissions[0]!.status, "unanswered");
  assert.equal(stopped.submissions[0]!.reason, "aborted");
});

test("independent conversations generate concurrently without sharing history", async (t) => {
  const stateDir = await directory(t);
  const runtime = await openRuntime(stateDir, scriptedModels("Separate concurrent work. ".repeat(20), 30).models);
  t.after(() => runtime.close());
  const chats = await Promise.all(["one", "two"].map((requestId) => runtime.createChat(scope, { requestId })));
  await Promise.all(chats.map((chat, index) => runtime.submit(scope, chat.conversation.id, { requestId: "work", text: `Input ${index}` })));
  await Promise.all(chats.map((chat) => waitFor(runtime, chat.conversation.id, hasPartial)));
  const active = await Promise.all(chats.map((chat) => runtime.getChat(scope, chat.conversation.id)));
  assert.ok(active.every((snapshot) => snapshot.conversation.status === "running"));
  assert.notEqual(active[0]!.view.entries[0]!.id, active[1]!.view.entries[0]!.id);
  await Promise.all(chats.map((chat) => runtime.stop(scope, chat.conversation.id)));
});

test("provider errors remain failed native submissions, including before usable output", async (t) => {
  const stateDir = await directory(t);
  const { models, faux } = scriptedModels();
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Test provider unavailable" })]);
  const runtime = await openRuntime(stateDir, models);
  t.after(() => runtime.close());
  const chat = await runtime.createChat(scope, { requestId: "failed-chat" });
  await runtime.submit(scope, chat.conversation.id, { requestId: "failure", text: "Try." });
  const failed = await waitFor(runtime, chat.conversation.id, (snapshot) => snapshot.conversation.status === "failed");
  assert.match(failed.conversation.error!, /Test provider unavailable/);
  assert.equal(failed.submissions.at(-1)?.reason, "model_error");
});

test("company-shared named agent revisions are copied to independent native conversations", async (t) => {
  const stateDir = await directory(t);
  let runtime = await openRuntime(stateDir);
  t.after(() => runtime.close());
  const draft = { name: "Reviewer", description: "Checks an argument.", instructions: "Find gaps in the supplied reasoning.", provider: "faux", modelId: "faux-1", thinkingLevel: "off" as const };
  const v1 = await runtime.saveAgent(scope, draft);
  const original = await runtime.createChat(scope, { requestId: "original", agentDefinitionId: v1.id });
  const v2 = await runtime.saveAgent({ ...scope, userId: "bob" }, { ...draft, id: v1.id, expectedRevision: 1, instructions: "Use a different reviewing instruction." });
  const revised = await runtime.createChat(scope, { requestId: "revised", agentDefinitionId: v1.id });
  assert.equal(v2.revision, 2);
  assert.equal(original.view.docs["pi.agent"]!.instructions, draft.instructions);
  assert.equal(revised.view.docs["pi.agent"]!.instructions, v2.instructions);
  assert.equal(original.conversation.agentRevision, 1);
  await assert.rejects(runtime.saveAgent(scope, { ...draft, id: v1.id, expectedRevision: 1 }), /changed/);
  await assert.rejects(runtime.saveAgent({ ...scope, companyId: "other" }, { ...draft, id: v1.id, expectedRevision: 2 }), /not found/);
  assert.equal((await runtime.listAgents({ ...scope, companyId: "other" })).length, 1);
  await runtime.archiveAgent(scope, v1.id, 2);
  await assert.rejects(runtime.createChat(scope, { requestId: "archived", agentDefinitionId: v1.id }), /not found/);
  await runtime.close();
  runtime = await openRuntime(stateDir);
  assert.equal((await runtime.listAgents(scope)).find((agent) => agent.id === v1.id)?.archived, true);
  assert.equal((await runtime.getChat(scope, original.conversation.id)).view.docs["pi.agent"]!.instructions, draft.instructions);
  await runtime.submit(scope, original.conversation.id, { requestId: "still-works", text: "Use the old configuration." });
  await waitFor(runtime, original.conversation.id, (snapshot) => snapshot.submissions.at(-1)?.status === "done");
});

test("missing provider credentials reject admission without inventing an answer", async (t) => {
  const stateDir = await directory(t);
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(openaiProvider());
  const runtime = await DispatchRuntime.open({ stateDir, models });
  t.after(() => runtime.close());
  const chat = await runtime.createChat(scope, { requestId: "unconfigured" });
  await assert.rejects(runtime.submit(scope, chat.conversation.id, { requestId: "no-key", text: "Hello" }), /not configured/);
  assert.equal((await runtime.getChat(scope, chat.conversation.id)).view.entries.length, 0);
});

test("a process crash releases exclusive ownership and Pi resumes a response already streaming", async (t) => {
  const stateDir = await directory(t);
  const child = fork(fileURLToPath(new URL("./crash-worker.ts", import.meta.url)), [stateDir], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const started = await new Promise<{ id: string; submissionId: number }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Worker did not stream: ${stderr}`)), 15_000);
    child.once("message", (message) => { clearTimeout(timeout); resolve(message as { id: string; submissionId: number }); });
    child.once("exit", (code, signal) => { clearTimeout(timeout); reject(new Error(`Worker exited ${code}/${signal}: ${stderr}`)); });
  });
  await assert.rejects(openRuntime(stateDir), /already owned/);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const { models, faux } = scriptedModels("Recovered from the committed native checkpoint.");
  const recovered = await openRuntime(stateDir, models);
  t.after(() => recovered.close());
  const finished = await waitFor(recovered, started.id, (snapshot) => snapshot.submissions.at(-1)?.status === "done");
  assert.equal(faux.state.callCount, 1);
  assert.equal(finished.view.entries.filter((entry) => entry.kind === "pi.user").length, 1);
  assert.equal(finished.submissions.length, 1);
  assert.equal(finished.submissions[0]!.id, started.submissionId);
  const messages = finished.view.entries.flatMap((entry) => entry.model ?? []).filter((message) => message.role === "assistant");
  assert.ok(messages.some((message) => message.stopReason === "aborted"));
  assert.equal(messages.at(-1)?.stopReason, "stop");
  const retried = await recovered.submit(scope, started.id, { requestId: "crash-input", text: "Recover this input once." });
  assert.equal(retried.id, started.submissionId);
  assert.equal(faux.state.callCount, 1);
});
