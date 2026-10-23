import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { SharedConversations } from "../collaboration/shared.js";

type Actor = Awaited<ReturnType<SharedConversations["managementActor"]>>;
export type BackendWorkerActor = Actor & {
  /** Only pre-instance-journal actors may bind a retained, differently named participant. */
  legacy?: boolean;
  membership?: "active" | "removing" | "removed";
  desiredRevision?: number;
  appliedRevision?: number;
  creation?: { name?: string; instructions?: string };
  removedByUserId?: string;
  worker?: { storeId: string; roomId: string; participantId: string; instanceId: string };
};
export const WorkerActorsDoc = defineDoc<{ actors: Record<string, BackendWorkerActor[]> }>({
  checkpointWhen: () => false,
  kind: "dispatch.worker-actors", version: 1, scope: "session", initial: () => ({ actors: {} }),
});
export const WorkerInstancesDoc = defineDoc<{ rooms: Record<string, {
  requests: Record<string, { fingerprint: string; actorId: string }>;
  report?: { storeId: string; roomId: string; revision: number; fingerprint: string };
}> }>({ checkpointWhen: () => false, kind: "dispatch.worker-instances", version: 1, scope: "session", initial: () => ({ rooms: {} }) });

const id = z.string().min(1).max(200);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const workerParticipantReportSchema = z.object({
  conversationKey: id, storeId: id, roomId: id, revision, membershipRevision: revision,
  agents: z.array(z.object({
    actorId: id, participantId: id, instanceId: id, definitionId: id, appliedRevision: revision,
    membership: z.enum(["active", "removing", "removed"]),
  }).strict()),
}).strict();
export type WorkerParticipantReport = z.infer<typeof workerParticipantReportSchema>;
export const WorkerIdentityDoc = defineDoc<{
  mappings: Record<string, { participantId: string; instanceId: string; desiredRevision: number }>;
  report?: WorkerParticipantReport;
}>({ checkpointWhen: () => false, kind: "dispatch.worker-instance-identity", version: 1, scope: "session", initial: () => ({ mappings: {} }) });
