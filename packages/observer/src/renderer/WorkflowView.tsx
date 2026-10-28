import { ArrowLeft, ArrowRight, Bot, Workflow } from "lucide-react";
import {
  readableName,
  type WorkflowMember,
  type WorkflowRun,
} from "../shared/workflows";
import { instanceLabel } from "./ConversationContext";
import { UI } from "./controls";

export function WorkflowView({
  run,
  open,
  back,
  error,
}: {
  run: WorkflowRun;
  open(member: WorkflowMember): void;
  back(): void;
  error?: string;
}) {
  const assignments = run.members.filter((m) => m.role === "assignment");
  const senders = run.members.filter((m) => m.role === "sender");
  return (
    <section className="workflow-view panel-scroll">
      <UI.Button variant="ghost" size="sm" onClick={back}>
        <ArrowLeft size={15} />
        This machine
      </UI.Button>
      <header className="workflow-heading">
        <p className="eyebrow">
          <Workflow size={15} />
          WORKFLOW
        </p>
        <h1 className="agent-name">{readableName(run.name)}</h1>
        <p>{run.cycle}</p>
      </header>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="workflow-summary">
        <strong>
          {assignments.length}{" "}
          {assignments.length === 1 ? "assignment" : "assignments"}
        </strong>
        <span>
          {assignments.filter((m) => m.conversation.active > 0).length} with
          unfinished tasks
        </span>
        <span>Grouped from saved handoffs</span>
        <span>
          {run.members.some((m) => m.pids.length > 0)
            ? "Local process observed"
            : "Saved history"}
        </span>
      </div>
      {senders.length > 0 && (
        <section className="workflow-senders" aria-label="Handoff senders">
          <h2>Handoffs sent from</h2>
          {senders.map((member) => (
            <UI.Button
              key={member.connection.id + member.conversation.id}
              variant="outline"
              className="workflow-sender"
              onClick={() => open(member)}
            >
              <Bot size={18} />
              <span>
                <strong>{member.conversation.title}</strong>
                <small>
                  {instanceLabel(
                    `${member.conversation.agent}:${member.conversation.id}`,
                  )}
                </small>
              </span>
              <ArrowRight size={16} />
            </UI.Button>
          ))}
        </section>
      )}
      <section aria-label="Workflow assignments">
        <h2 className="workflow-section-heading">
          Assignments <small>Unfinished first</small>
        </h2>
        <div className="workflow-assignments">
          {assignments.map((member) => {
            const { conversation: c } = member;
            return (
              <UI.Button
                key={member.connection.id + c.id}
                variant="ghost"
                className="workflow-assignment"
                onClick={() => open(member)}
              >
                <span className="assignment-agent">
                  <Bot size={17} />
                  <span className="agent-name">
                    {readableName(c.agent ?? "Agent")}
                  </span>
                </span>
                <span className="assignment-copy">
                  <strong>{c.title}</strong>
                  <span>{c.opening?.labels?.phase}</span>
                  <small>
                    {c.opening?.labels?.assignment}
                    {c.opening?.sender
                      ? ` · From ${instanceLabel(c.opening.sender.from)}`
                      : ""}
                  </small>
                </span>
                <span className="assignment-state">
                  {c.active ? "Unfinished tasks" : "No unfinished tasks"}
                </span>
                <ArrowRight size={16} />
              </UI.Button>
            );
          })}
        </div>
      </section>
      <p className="evidence-note">
        Available conversations in this local installation. Handoff labels
        identify the workflow and cycle; they do not establish a final workflow
        outcome. Missing stores are not searched automatically.
      </p>
    </section>
  );
}
