import { ArrowLeft, Workflow } from "lucide-react";
import {
  readableName,
  workflowActivity,
  type WorkflowNode,
  type WorkflowRun,
} from "../shared/workflows";
import { WorkflowNodeContext } from "./WorkflowJourney";
import { recordedTime } from "../shared/workSummary";
import { UI } from "./controls";

export function WorkflowView({
  run,
  node,
  select,
  openEvidence,
  openWorkflow,
  back,
  error,
  settings,
}: {
  run: WorkflowRun;
  node?: WorkflowNode;
  select(node: WorkflowNode): void;
  openEvidence(evidence: WorkflowNode["evidence"][number]): void;
  openWorkflow(id: string): void;
  back(): void;
  error?: string;
  settings(): void;
}) {
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
        <strong>{run.nodes.length} recorded activities</strong>
        <span>{run.members.length} conversations</span>
        <span>Recorded activity {recordedTime(workflowActivity(run))}</span>
        <span>Execution unknown</span>
        <span>
          {run.status
            ? `Producer-reported result: ${run.status}`
            : "Workflow outcome unknown"}
        </span>
      </div>
      <section className="workflow-coverage" aria-label="Evidence coverage">
        <strong>
          {run.origin === "document"
            ? "Producer-recorded structure"
            : run.origin === "native"
              ? "Native delegation"
              : "Recorded handoffs"}{" "}
          · loaded sources
        </strong>
        {run.issues.length > 0 && (
          <details open>
            <summary>{run.issues.length} evidence notices</summary>
            {run.issues.map((issue) => (
              <p key={issue}>{issue}</p>
            ))}
            <UI.Button variant="link" size="sm" onClick={settings}>
              Locate a source in Settings
            </UI.Button>
          </details>
        )}
      </section>
      {node ? (
        <WorkflowNodeContext
          run={run}
          node={node}
          select={select}
          openEvidence={openEvidence}
          openWorkflow={openWorkflow}
        />
      ) : (
        <p className="empty-inline">
          Select an activity in the journey to read its conversation or
          evidence.
        </p>
      )}
      <p className="evidence-note">
        Groups organize records; links describe relationships. Selection and
        reported results do not establish live execution.
      </p>
    </section>
  );
}
