import type { Connection, Conversation, LocalWork } from "./contracts";

export type WorkflowMember = {
  connection: Connection;
  conversation: Conversation;
  pids: number[];
  role: "assignment" | "sender";
};
export type WorkflowRun = {
  id: string;
  name: string;
  cycle: string;
  members: WorkflowMember[];
};

export const memberKey = (connection: Connection, id: number) =>
  JSON.stringify([connection.path, id]);
export const readableName = (name: string) => name.replace(/[-_]/g, " ");

/** Group explicit handoff labels within one local installation and namespace.
 * Addresses are resolved from Runner chat records, never from prose or time. */
export function workflowRuns(stores: LocalWork["stores"]): WorkflowRun[] {
  const runs = new Map<string, WorkflowRun>();
  const addresses = new Map<string, WorkflowMember[]>();
  for (const store of stores)
    for (const conversation of store.conversations) {
      if (!conversation.agent || !conversation.namespace) continue;
      const address = JSON.stringify([
        store.scope,
        conversation.namespace,
        `${conversation.agent}:${conversation.id}`,
      ]);
      const candidates = addresses.get(address) ?? [];
      candidates.push({
        connection: store.connection,
        conversation,
        pids: store.pids,
        role: "sender",
      });
      addresses.set(address, candidates);
    }
  for (const store of stores)
    for (const conversation of store.conversations) {
      const { labels, sender } = conversation.opening ?? {};
      if (
        !labels?.workflow ||
        !labels.cycle ||
        !sender ||
        sender.kind !== "message"
      )
        continue;
      // A known recipient must match this conversation, not a quoted envelope.
      if (
        !conversation.agent ||
        sender.to !== `${conversation.agent}:${conversation.id}` ||
        sender.namespace !== conversation.namespace
      )
        continue;
      const id = JSON.stringify([
        store.scope,
        sender.namespace,
        labels.workflow,
        labels.cycle,
      ]);
      const run = runs.get(id) ?? {
        id,
        name: labels.workflow,
        cycle: labels.cycle,
        members: [],
      };
      const add = (member: WorkflowMember) => {
        const key = memberKey(member.connection, member.conversation.id);
        const index = run.members.findIndex(
          (item) => memberKey(item.connection, item.conversation.id) === key,
        );
        if (index < 0) run.members.push(member);
        else if (member.role === "assignment") run.members[index] = member;
      };
      add({
        connection: store.connection,
        conversation,
        pids: store.pids,
        role: "assignment",
      });
      const callers = addresses.get(
        JSON.stringify([store.scope, sender.namespace, sender.from]),
      );
      if (callers?.length === 1) add(callers[0]);
      runs.set(id, run);
    }
  return [...runs.values()]
    .map((run) => ({
      ...run,
      members: run.members.sort(
        (a, b) =>
          Number(a.role === "assignment") - Number(b.role === "assignment") ||
          (b.conversation.lastAt ?? -Infinity) -
            (a.conversation.lastAt ?? -Infinity) ||
          a.conversation.id - b.conversation.id,
      ),
    }))
    .sort(
      (a, b) =>
        (workflowActivity(b) ?? -Infinity) -
          (workflowActivity(a) ?? -Infinity) || a.id.localeCompare(b.id),
    );
}

export function workflowActivity(run: WorkflowRun): number | undefined {
  const times = run.members
    .filter((m) => m.role === "assignment")
    .flatMap((m) =>
      m.conversation.lastAt === undefined ? [] : [m.conversation.lastAt],
    );
  return times.length ? Math.max(...times) : undefined;
}

export function workflowSender(run: WorkflowRun, member: WorkflowMember) {
  const sender = member.conversation.opening?.sender;
  const candidates = run.members.filter(
    (m) =>
      sender &&
      `${m.conversation.agent}:${m.conversation.id}` === sender.from &&
      m.conversation.namespace === sender.namespace,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
