import { useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  Layers,
  Radio,
  Terminal,
  Workflow,
} from "lucide-react";
import { UI } from "./controls";
import { Badge, type Selection } from "./Details";
import type { Activity, Snapshot } from "../shared/contracts";

function duration(milliseconds: number) {
  return milliseconds < 1000
    ? `${milliseconds} ms`
    : milliseconds < 60_000
      ? `${(milliseconds / 1000).toFixed(1)} s`
      : `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}
export function Structure({
  snapshot,
  conversationId,
  selection,
  onSelection,
  onConversation,
  onActivity,
}: {
  snapshot: Snapshot;
  conversationId: number;
  selection?: Selection;
  onSelection(value: Selection): void;
  onConversation(id: number): void;
  onActivity(activity: Activity): void;
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const node = (id: number, ancestors = new Set<number>()): React.ReactNode => {
    const item = snapshot.conversations.find((item) => item.id === id);
    if (!item)
      return (
        <li className="notice">
          Conversation {id} is not retained in this store.
        </li>
      );
    if (ancestors.has(id))
      return (
        <li className="notice">
          Circular ownership reference to conversation {id}.
        </li>
      );
    const path = new Set(ancestors).add(id);
    const children = snapshot.conversations
      .filter((child) => child.owner?.conversationId === id)
      .sort((a, b) => a.id - b.id);
    const tasks = snapshot.tasks.filter((task) => task.conversationId === id),
      live = tasks.find((task) => task.status !== "terminal"),
      last = tasks.at(-1);
    return (
      <li key={id}>
        <div className="tree-node">
          {children.length ? (
            <UI.Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${collapsed.has(id) ? "Expand" : "Collapse"} ${item.title}`}
              aria-expanded={!collapsed.has(id)}
              onClick={() => toggle(id)}
            >
              {collapsed.has(id) ? <ChevronRight /> : <ChevronDown />}
            </UI.Button>
          ) : (
            <span className="tree-spacer" />
          )}
          <UI.Button
            variant="ghost"
            className="tree-main"
            onClick={() => onConversation(id)}
          >
            <span className="tree-icon">
              <Bot size={21} />
            </span>
            <span>
              <strong>{item.title}</strong>
              <small>
                {live
                  ? `${live.kind} · ${live.phase ?? live.status}`
                  : `${item.entryCount} saved entries`}
                {item.owner ? ` · Owner task ${item.owner.taskId}` : ""}
              </small>
            </span>
            <Badge value={live?.status ?? last?.outcome ?? "retained"} />
            <ChevronRight size={15} />
          </UI.Button>
        </div>
        {children.length > 0 && !collapsed.has(id) && (
          <ul className="tree-children">
            {children.map((child) => node(child.id, path))}
          </ul>
        )}
      </li>
    );
  };
  const selected = snapshot.conversations.find(
    (item) => item.id === conversationId,
  );
  return (
    <>
      <div className="section-caption">
        <span>Current / final state</span>
        <span>
          {snapshot.tasks.filter((task) => task.status !== "terminal").length}{" "}
          nonterminal tasks
        </span>
      </div>
      {selected?.owner && (
        <p className="ancestry-note">
          Created by conversation {selected.owner.conversationId}, task{" "}
          {selected.owner.taskId}.{" "}
          <UI.Button
            variant="link"
            size="sm"
            onClick={() => onConversation(selected.owner!.conversationId)}
            disabled={
              !snapshot.conversations.some(
                (item) => item.id === selected.owner!.conversationId,
              )
            }
          >
            {snapshot.conversations.some(
              (item) => item.id === selected.owner!.conversationId,
            )
              ? "Open parent"
              : "Parent unavailable"}
          </UI.Button>
        </p>
      )}
      {selected?.parent && (
        <p className="ancestry-note">
          Forked from conversation {selected.parent.conversationId} through
          entry {selected.parent.at}.{" "}
          <UI.Button
            variant="link"
            size="sm"
            onClick={() => onConversation(selected.parent!.conversationId)}
            disabled={
              !snapshot.conversations.some(
                (item) => item.id === selected.parent!.conversationId,
              )
            }
          >
            Open fork source
          </UI.Button>
        </p>
      )}
      <ul
        className="structure-card"
        aria-label="Recorded conversation hierarchy"
      >
        {node(conversationId)}
      </ul>
      {snapshot.live.some((item) => item.text || item.tools.length) && (
        <section className="live-card">
          <h3>
            <Radio size={15} />
            Latest retained live activity
          </h3>
          {snapshot.live.map((item, index) => (
            <div key={index}>
              {item.text && <p className="prose-content">{item.text}</p>}
              {item.tools.map((tool: any, index) => (
                <UI.Button
                  variant="ghost"
                  className="live-tool"
                  key={index}
                  onClick={() => {
                    const activity = snapshot.activities.find(
                      (event) =>
                        event.conversationId === item.conversationId &&
                        event.tool?.callId === tool.callId &&
                        event.tool?.phase === "call",
                    );
                    if (activity) onActivity(activity);
                    else {
                      const doc = snapshot.documents.find(
                        (doc) =>
                          doc.kind === "pi.live" &&
                          (doc.scope as { conversationId?: number })
                            ?.conversationId === item.conversationId,
                      );
                      if (doc) onSelection({ kind: "document", value: doc });
                    }
                  }}
                >
                  <Terminal size={14} />
                  <span>
                    {tool.name ?? "Nested tool"}
                    {tool.parentCallId ? (
                      <small> · nested in {tool.parentCallId}</small>
                    ) : null}
                  </span>
                  <Badge value={tool.status ?? "retained"} />
                </UI.Button>
              ))}
            </div>
          ))}
          <p className="hint">
            Temporary slots can disappear when a run completes.
          </p>
        </section>
      )}
      <details className="task-section" open>
        <summary className="section-heading">
          <h2>
            <Layers size={16} />
            Native tasks
          </h2>
          <span>{snapshot.tasks.length}</span>
        </summary>
        {snapshot.tasks.length ? (
          snapshot.tasks.map((task) => (
            <UI.Button
              key={task.id}
              variant="ghost"
              className={`task-row ${selection?.kind === "task" && selection.value.id === task.id ? "selected" : ""}`}
              onClick={() => onSelection({ kind: "task", value: task })}
            >
              <span className="task-kind">
                <Workflow size={17} />
                <span>
                  <strong>{task.kind}</strong>
                  <small>
                    Task {task.id}
                    {task.owner ? ` · Owner ${task.owner}` : ""}
                    {task.phase ? ` · Phase ${task.phase}` : ""}
                    {task.attempt !== undefined
                      ? ` · Attempt ${task.attempt}`
                      : ""}
                    {task.waitingOn.length
                      ? ` · Waiting on ${task.waitingOn.join(", ")}`
                      : ""}
                    {task.background ? " · Background" : ""}
                  </small>
                </span>
              </span>
              <span className="task-duration">
                {task.startedAt && task.endedAt
                  ? duration(task.endedAt - task.startedAt)
                  : ""}
              </span>
              <Badge value={task.outcome ?? task.status} />
            </UI.Button>
          ))
        ) : (
          <p className="empty-inline">
            No task records retained for this conversation.
          </p>
        )}
      </details>
      <section className="document-section">
        <div className="section-heading">
          <h2>
            <FileText size={16} />
            Documents & workflow state
          </h2>
          <span>{snapshot.documents.length}</span>
        </div>
        {snapshot.documents.map((doc) => (
          <UI.Button
            variant="ghost"
            className="document-row"
            key={doc.id}
            onClick={() => onSelection({ kind: "document", value: doc })}
          >
            <FileText size={16} />
            <span>
              <strong>{doc.kind}</strong>
              <small>
                {doc.unavailable
                  ? "Contents unavailable"
                  : `Latest retained revision · ${doc.id}`}
              </small>
            </span>
            <ChevronRight size={15} />
          </UI.Button>
        ))}
      </section>
      <p className="evidence-note">
        <CircleHelp size={15} />
        Saved task status does not establish that its process is still running.
        Intermediate task states and workflow phases may not be retained.
      </p>
    </>
  );
}
