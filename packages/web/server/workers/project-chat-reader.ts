import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, LiveDoc, type ConversationId, type EntryRecord, type Cursor } from "@earendil-works/pi-durable";
import type { Attachment } from "../../src/shared/contracts.js";
import { AttachmentsDoc } from "../attachments.js";
import { SharedDoc } from "../collaboration/shared.js";
import { RuntimeError } from "../runtime.js";
import { readProjectChat } from "../project-chat-reader.js";
import type { ProjectChatMetadata, ProjectChatReadInput } from "../project-chat-context.js";
import { PostgresStorage } from "../storage/postgres/storage.js";
import type { PostgresStorageOptions } from "../storage/postgres/database.js";
import type { WorkerRoute } from "./routes.js";

/** Read an existing worker store without a Harness, provisioning or worker RPC. */
export async function readWorkerProjectChat(options: PostgresStorageOptions, route: WorkerRoute, projectId: string, metadata: ProjectChatMetadata, input: ProjectChatReadInput, bytes: (attachment: Attachment) => Promise<Buffer>) {
  const room = route.nativeRoomId;
  if (!room || !/^[1-9]\d*$/.test(room) || !Number.isSafeInteger(Number(room))) throw new RuntimeError(503, "Chat history is unavailable.");
  const roomId = Number(room) as ConversationId;
  return PostgresStorage.readSnapshot(options, async storage => {
    if (!await storage.conversation(roomId, BACKGROUND_CONTEXT)) throw new RuntimeError(503, "Chat history is unavailable.");
    const session = createSession(storage);
    try {
      const state = await session.snapshot(SharedDoc, roomId, BACKGROUND_CONTEXT);
      if (!state || state.companyId !== route.companyId || state.sharedProjectId !== projectId) throw new RuntimeError(503, "Chat history binding is unavailable.");
      return await readProjectChat({ room: state,
        entries: async id => {
          const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
          do { const page = await storage.scanEntries({ conversationId: id }, 200, cursor, BACKGROUND_CONTEXT); entries.push(...page.items); cursor = page.next; } while (cursor);
          return entries.reverse();
        },
        live: async id => {
          const live = await session.snapshot(LiveDoc, id, BACKGROUND_CONTEXT);
          if (!live) throw new RuntimeError(503, "Chat activity is unavailable.");
          return live;
        },
        attachments: async () => (await session.snapshot(AttachmentsDoc, roomId, BACKGROUND_CONTEXT))?.records ?? {}, bytes,
      }, roomId, metadata, input);
    } finally { await session.close(BACKGROUND_CONTEXT); }
  });
}
