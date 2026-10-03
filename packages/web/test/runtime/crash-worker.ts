import { openRuntime, scriptedModels, scope, waitFor, hasPartial } from "./helpers.js";
const stateDir = process.argv[2]!;
const { models } = scriptedModels("This response is deliberately long and slow so the process can die during committed streaming. ".repeat(15), 25);
const runtime = await openRuntime(stateDir, models);
const chat = await runtime.createChat(scope, { requestId: "crash-chat" });
const submission = await runtime.submit(scope, chat.conversation.id, { requestId: "crash-input", text: "Recover this input once." });
await waitFor(runtime, chat.conversation.id, hasPartial);
process.send?.({ id: chat.conversation.id, submissionId: submission.id });
