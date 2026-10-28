import type { Connection, Conversation, LocalWork } from "./contracts";
import {
  workflowDocumentSchema,
  type WorkflowDocument,
  type WorkflowEvidence,
} from "./workflowDocument";

export type WorkflowMember = {
  connection: Connection;
  conversation: Conversation;
  pids: number[];
  role: "assignment" | "sender";
  shared?: boolean;
};
export type WorkflowRun = {
  id: string;
  name: string;
  cycle: string;
  members: WorkflowMember[];
  origin: "handoffs" | "native" | "document";
  nodes: WorkflowNode[];
  edges: WorkflowDocument["edges"];
  issues: string[];
  status?: string;
  document?: { connection: Connection; id: number };
  lastAt?: number;
};
export type WorkflowNode = Omit<
  WorkflowDocument["nodes"][number],
  "evidence"
> & {
  evidence: (WorkflowEvidence & {
    member?: WorkflowMember;
    unavailable?: string;
  })[];
  linkedWorkflow?: string;
};

export const memberKey = (connection: Connection, id: number) =>
  JSON.stringify([sourceKey(connection), id]);
export const sourceKey = (connection: Connection) =>
  JSON.stringify([
    connection.kind,
    connection.transport,
    connection.kind === "sqlite"
      ? connection.path
      : [
          connection.postgres.host,
          connection.postgres.port,
          connection.postgres.database,
          connection.postgres.storeId,
          connection.postgres.user,
        ],
  ]);
export const readableName = (name: string) => name.replace(/[-_]/g, " ");
const documentKey = (connection: Connection, id: number) =>
  JSON.stringify(["document", sourceKey(connection), id]);
const conversationNode = (member: WorkflowMember): WorkflowNode => ({
  id: memberKey(member.connection, member.conversation.id),
  title: member.conversation.title,
  type: "activity",
  kind:
    member.role === "sender"
      ? "Coordinator"
      : (member.conversation.agent ?? "Conversation"),
  at: member.conversation.opening?.at ?? member.conversation.createdAt,
  evidence: [{ conversationId: member.conversation.id, member }],
});

/** Group explicit handoff labels within one local installation and namespace.
 * Addresses are resolved from Runner chat records, never from prose or time. */
function handoffRuns(stores: LocalWork["stores"]): WorkflowRun[] {
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
    for (const handoff of store.handoffs) {
      const conversation = store.conversations.find(
        (c) => c.id === handoff.conversationId,
      );
      if (!conversation) continue;
      const { labels, sender } = handoff;
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
        origin: "handoffs",
        nodes: [],
        edges: [],
        issues: [],
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
      const member = run.members.find(
        (m) =>
          memberKey(m.connection, m.conversation.id) ===
          memberKey(store.connection, conversation.id),
      )!;
      const nodeId = JSON.stringify([
        "handoff",
        sourceKey(store.connection),
        handoff.entryId,
      ]);
      run.nodes.push({
        id: nodeId,
        title: labels.assignment ?? conversation.title,
        type: "activity",
        kind: labels.phase ?? conversation.agent,
        at: handoff.at,
        attributes: {
          ...(labels.phase ? { Phase: labels.phase } : {}),
          Sender: sender.from,
        },
        evidence: [
          {
            conversationId: conversation.id,
            entryId: handoff.entryId,
            label: "Original handoff",
            member,
          },
          {
            conversationId: conversation.id,
            label: "Full conversation",
            member,
          },
        ],
      });
      if (callers?.length === 1)
        run.edges.push({
          from: memberKey(callers[0].connection, callers[0].conversation.id),
          to: nodeId,
          kind: "handoff",
        });
      else
        run.issues.push(
          `Sender ${sender.from} is unavailable in loaded sources.`,
        );
      runs.set(id, run);
    }
  const membership = new Map<string, Set<string>>();
  for (const run of runs.values())
    for (const member of run.members.filter((m) => m.role === "assignment")) {
      const key = memberKey(member.connection, member.conversation.id);
      const cycles = membership.get(key) ?? new Set();
      cycles.add(run.id);
      membership.set(key, cycles);
    }
  for (const run of runs.values()) {
    for (const member of run.members)
      member.shared =
        (membership.get(memberKey(member.connection, member.conversation.id))
          ?.size ?? 0) > 1;
    const times = [
      ...run.nodes.flatMap((n) => (n.at === undefined ? [] : [n.at])),
      ...run.members
        .filter((m) => m.role === "assignment" && !m.shared)
        .flatMap((m) =>
          m.conversation.lastAt === undefined ? [] : [m.conversation.lastAt],
        ),
    ];
    run.lastAt = times.length ? Math.max(...times) : undefined;
    if (run.members.some((m) => m.shared))
      run.issues.push(
        "Conversations span multiple cycles. Shared conversation activity and native children are not attributed to a cycle; open original handoffs for exact evidence.",
      );
  }
  return [...runs.values()]
    .map((run) => ({
      ...run,
      nodes: [
        ...run.members.map(conversationNode),
        ...run.nodes.map((n) => ({
          ...n,
          parent: memberKey(
            n.evidence[0].member!.connection,
            n.evidence[0].conversationId,
          ),
        })),
      ],
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
  if (run.origin === "handoffs") return run.lastAt;
  const times =
    run.origin === "document"
      ? run.nodes.flatMap((node) => (node.at === undefined ? [] : [node.at]))
      : run.members
          .filter((m) => run.origin === "native" || m.role === "assignment")
          .flatMap((m) =>
            m.conversation.lastAt === undefined ? [] : [m.conversation.lastAt],
          );
  return times.length ? Math.max(...times) : undefined;
}

/** Resolve explicit metadata plus two built-in evidence sources. Unknown
 * orchestrators use the same document contract, not executable plugins. */
export function workflowRuns(stores: LocalWork["stores"]): WorkflowRun[] {
  const runs: WorkflowRun[] = [];
  const resolveStore = (
    owner: LocalWork["stores"][number],
    reference?: { agent: string; namespace: string },
  ) =>
    reference
      ? stores.filter(
          (s) =>
            s.scope === owner.scope &&
            s.conversations.some(
              (c) =>
                c.agent === reference.agent &&
                c.namespace === reference.namespace,
            ),
        )
      : [owner];
  for (const store of stores) {
    for (const doc of store.documents) {
      if (doc.kind !== "observer.workflow") continue;
      const parsed = workflowDocumentSchema.safeParse(doc.value);
      const run: WorkflowRun = {
        id: documentKey(store.connection, doc.id),
        name: parsed.success
          ? parsed.data.title
          : `Workflow document ${doc.id}`,
        cycle: parsed.success
          ? (parsed.data.cycle ?? parsed.data.id)
          : "Unsupported document",
        origin: "document",
        members: [],
        nodes: [],
        edges: [],
        issues: [],
        document: { connection: store.connection, id: doc.id },
      };
      runs.push(run);
      if (!parsed.success) {
        run.issues.push(
          doc.unavailable ??
            "Unsupported or invalid observer.workflow document. Version 1 is required.",
        );
        continue;
      }
      const value = parsed.data;
      if (new Set(value.nodes.map((n) => n.id)).size !== value.nodes.length) {
        run.issues.push(
          "Duplicate activity identities. The document cannot be presented without ambiguity.",
        );
        continue;
      }
      run.status = value.status;
      run.edges = value.edges;
      run.nodes = value.nodes.map((node) => {
        const evidence = node.evidence.map((ref) => {
          const candidates = resolveStore(store, ref.source);
          const source = candidates.length === 1 ? candidates[0] : undefined;
          const conversation = source?.conversations.find(
            (c) => c.id === ref.conversationId,
          );
          if (
            !source ||
            !conversation ||
            (ref.source &&
              (conversation.agent !== ref.source.agent ||
                conversation.namespace !== ref.source.namespace))
          )
            return {
              ...ref,
              unavailable: "Conversation source is missing or ambiguous.",
            };
          const member: WorkflowMember = {
            connection: source.connection,
            conversation,
            pids: source.pids,
            role: "assignment",
          };
          if (
            !run.members.some(
              (m) =>
                memberKey(m.connection, m.conversation.id) ===
                memberKey(member.connection, conversation.id),
            )
          )
            run.members.push(member);
          return { ...ref, member };
        });
        const linked = node.workflow
          ? resolveStore(store, node.workflow.source)
          : [];
        return {
          ...node,
          evidence,
          linkedWorkflow:
            node.workflow && linked.length === 1
              ? documentKey(linked[0].connection, node.workflow.documentId)
              : undefined,
        };
      });
    }
  }
  // A document can describe only part of a conversation. It must not hide
  // other retained handoffs or native ownership that happen to reference it.
  const handoffs = handoffRuns(stores);
  runs.push(...handoffs);

  // Native ownership enriches existing handoffs and also stands alone. Fork
  // ancestry is not delegation and never makes another workflow member.
  for (const store of stores) {
    const byId = new Map(store.conversations.map((c) => [c.id, c]));
    const rootOf = (c: Conversation) => {
      const seen = new Set<number>();
      while (c.owner && byId.has(c.owner.conversationId)) {
        if (seen.has(c.id)) return undefined;
        seen.add(c.id);
        c = byId.get(c.owner.conversationId)!;
      }
      return c;
    };
    const families = new Map<number, Conversation[]>();
    for (const c of store.conversations) {
      const root = rootOf(c);
      if (!root) continue;
      const family = families.get(root.id) ?? [];
      family.push(c);
      families.set(root.id, family);
    }
    for (const [rootId, family] of families) {
      if (family.length < 2) continue;
      const keys = new Set(
        family.map((c) => memberKey(store.connection, c.id)),
      );
      const existing = handoffs.filter((r) =>
        r.members.some((m) =>
          keys.has(memberKey(m.connection, m.conversation.id)),
        ),
      );
      const native = {
        id: JSON.stringify(["native", sourceKey(store.connection), rootId]),
        name: byId.get(rootId)!.title,
        cycle: `Conversation ${rootId}`,
        origin: "native" as const,
        members: [],
        nodes: [],
        edges: [],
        issues: [],
      } satisfies WorkflowRun;
      const targets: WorkflowRun[] = [...existing, native];
      runs.push(native);
      for (const run of targets) {
        // Do not pull a shared coordinator's unrelated children into every cycle.
        const allowed = new Set(
          run.members
            .filter((m) => m.role === "assignment" && !m.shared)
            .map((m) => memberKey(m.connection, m.conversation.id)),
        );
        if (run.origin === "native")
          allowed.add(memberKey(store.connection, rootId));
        let changed = true;
        while (changed) {
          changed = false;
          for (const c of family)
            if (
              c.owner &&
              allowed.has(
                memberKey(store.connection, c.owner.conversationId),
              ) &&
              !allowed.has(memberKey(store.connection, c.id))
            ) {
              allowed.add(memberKey(store.connection, c.id));
              changed = true;
            }
        }
        for (const c of family) {
          const key = memberKey(store.connection, c.id);
          if (!allowed.has(key)) continue;
          if (!run.nodes.some((n) => n.id === key)) {
            const member: WorkflowMember = {
              connection: store.connection,
              conversation: c,
              pids: store.pids,
              role: c.id === rootId ? "sender" : "assignment",
            };
            run.members.push(member);
            run.nodes.push(conversationNode(member));
          }
        }
        for (const c of family) {
          const key = memberKey(store.connection, c.id);
          if (allowed.has(key) && c.owner) {
            const parent = memberKey(store.connection, c.owner.conversationId);
            if (run.nodes.some((n) => n.id === parent)) {
              run.nodes.find((n) => n.id === key)!.parent = parent;
              run.edges.push({ from: parent, to: key, kind: "owned child" });
            }
          }
        }
        if (run.origin === "handoffs") {
          const times = run.members
            .filter((m) => m.role === "assignment" && !m.shared)
            .flatMap((m) =>
              m.conversation.lastAt === undefined
                ? []
                : [m.conversation.lastAt],
            );
          if (run.lastAt !== undefined) times.push(run.lastAt);
          run.lastAt = times.length ? Math.max(...times) : undefined;
        }
      }
    }
  }
  for (const run of runs) {
    const nodes = new Map(run.nodes.map((n) => [n.id, n]));
    for (const node of run.nodes) {
      const seen = new Set([node.id]);
      let parent = node.parent;
      while (parent) {
        if (seen.has(parent) || !nodes.has(parent)) {
          run.issues.push(
            `${node.title}: ${nodes.has(parent) ? "circular" : "missing"} containing activity.`,
          );
          node.parent = undefined;
          break;
        }
        seen.add(parent);
        parent = nodes.get(parent)?.parent;
      }
      if (node.evidence.some((e) => e.unavailable))
        run.issues.push(
          `${node.title}: evidence unavailable in loaded sources.`,
        );
      if (node.workflow && !runs.some((r) => r.id === node.linkedWorkflow)) {
        node.linkedWorkflow = undefined;
        run.issues.push(`${node.title}: linked workflow unavailable.`);
      }
    }
    for (const edge of run.edges)
      if (!nodes.has(edge.from) || !nodes.has(edge.to))
        run.issues.push(
          `Unresolved ${edge.kind} reference: ${edge.from} → ${edge.to}.`,
        );
    run.issues = [...new Set(run.issues)];
  }
  return runs.sort(
    (a, b) =>
      (workflowActivity(b) ?? -Infinity) - (workflowActivity(a) ?? -Infinity) ||
      a.id.localeCompare(b.id),
  );
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
