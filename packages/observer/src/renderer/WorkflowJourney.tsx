import { ArrowRight, ChevronDown, ChevronRight, Search } from "lucide-react";
import { UI } from "./controls";
import { recordedTime } from "../shared/workSummary";
import type { WorkflowNode, WorkflowRun } from "../shared/workflows";

export type JourneyView = {
  selected?: string;
  collapsed: string[];
  query: string;
};
export const emptyJourney: JourneyView = { collapsed: [], query: "" };

export function WorkflowJourney({
  run,
  view,
  change,
  select,
}: {
  run: WorkflowRun;
  view: JourneyView;
  change(view: JourneyView): void;
  select(node: WorkflowNode): void;
}) {
  const children = new Map<string | undefined, WorkflowNode[]>();
  for (const node of run.nodes) {
    const list = children.get(node.parent) ?? [];
    list.push(node);
    children.set(node.parent, list);
  }
  // Explicit order wins; timestamps order observations, never imply dependency.
  for (const list of children.values())
    list.sort(
      (a, b) =>
        (a.order ?? Infinity) - (b.order ?? Infinity) ||
        (a.at ?? Infinity) - (b.at ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
  const query = view.query.trim().toLowerCase();
  const visible = new Set<string>();
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  for (const node of run.nodes)
    if (
      !query ||
      `${node.title} ${node.kind ?? ""} ${node.status ?? ""} ${node.summary ?? ""}`
        .toLowerCase()
        .includes(query)
    ) {
      visible.add(node.id);
      let parent = node.parent;
      while (parent && !visible.has(parent)) {
        visible.add(parent);
        parent = byId.get(parent)?.parent;
      }
    }
  const toggle = (id: string) =>
    change({
      ...view,
      collapsed: view.collapsed.includes(id)
        ? view.collapsed.filter((item) => item !== id)
        : [...view.collapsed, id],
    });
  const row = (node: WorkflowNode): React.ReactNode => {
    const nested = children.get(node.id) ?? [];
    const expanded = Boolean(query) || !view.collapsed.includes(node.id);
    return (
      <li key={node.id}>
        <div
          className={`journey-row ${view.selected === node.id ? "selected" : ""}`}
        >
          {nested.length > 0 ? (
            <UI.Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${node.title}`}
              aria-expanded={expanded}
              onClick={() => toggle(node.id)}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
            </UI.Button>
          ) : (
            <span className="journey-dot" aria-hidden />
          )}
          <UI.Button
            variant="ghost"
            className="journey-select"
            aria-current={view.selected === node.id ? "true" : undefined}
            onClick={() => select(node)}
            onKeyDown={(event) => {
              if (
                event.altKey ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey
              )
                return;
              if (event.key === "ArrowRight" && nested.length && !expanded) {
                event.preventDefault();
                event.stopPropagation();
                toggle(node.id);
              } else if (
                event.key === "ArrowLeft" &&
                nested.length &&
                expanded
              ) {
                event.preventDefault();
                event.stopPropagation();
                toggle(node.id);
              }
            }}
          >
            <span>
              <strong>{node.title}</strong>
              <small>
                {node.kind ?? (node.type === "group" ? "Group" : "Activity")}
                {node.status ? ` · ${node.status}` : ""}
              </small>
              {node.at !== undefined && (
                <small>{recordedTime(node.at)}</small>
              )}
            </span>
          </UI.Button>
        </div>
        {nested.length > 0 && expanded && (
          <ul>{nested.filter((n) => visible.has(n.id)).map(row)}</ul>
        )}
      </li>
    );
  };
  return (
    <section className="journey-navigation" aria-label="Workflow journey">
      <div className="search-field">
        <Search size={14} />
        <UI.Input
          aria-label="Search workflow journey"
          placeholder="Find activity…"
          value={view.query}
          onChange={(e) => change({ ...view, query: e.target.value })}
        />
      </div>
      <p className="journey-caption">
        Recorded structure · expand to explore
      </p>
      <ul className="journey-tree">
        {(children.get(undefined) ?? [])
          .filter((n) => visible.has(n.id))
          .map(row)}
      </ul>
      {!visible.size && (
        <p className="rail-empty">
          {query
            ? "No matching activities."
            : "No readable activity structure."}
        </p>
      )}
    </section>
  );
}

export function WorkflowNodeContext({
  run,
  node,
  select,
  openEvidence,
  openWorkflow,
  compact = false,
}: {
  run: WorkflowRun;
  node: WorkflowNode;
  select(node: WorkflowNode): void;
  openEvidence(evidence: WorkflowNode["evidence"][number]): void;
  openWorkflow(id: string): void;
  compact?: boolean;
}) {
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const ancestors: WorkflowNode[] = [];
  let parent = node.parent;
  while (parent && byId.has(parent)) {
    const item = byId.get(parent)!;
    ancestors.unshift(item);
    parent = item.parent;
  }
  const edges = run.edges.filter(
    (e) => e.from === node.id || e.to === node.id,
  );
  const primary = node.evidence.find((e) => e.member);
  const provenance =
    run.origin === "document"
      ? "Producer-recorded structure · latest observation"
      : "Recorded relationships · partial coverage";
  return (
    <section
      className={`journey-context ${compact ? "compact" : ""}`}
      aria-label="Selected workflow activity"
    >
      <div className="journey-context-heading">
        <nav className="journey-breadcrumb" aria-label="Activity path">
          {!compact &&
            ancestors.map((item) => (
              <span key={item.id}>
                <UI.Button
                  variant="link"
                  size="sm"
                  onClick={() => select(item)}
                >
                  {item.title}
                </UI.Button>
                <ChevronRight size={12} />
              </span>
            ))}
          <strong>{node.title}</strong>
        </nav>
        <div className="journey-actions">
          {primary && (
            <UI.Button
              variant="outline"
              size="sm"
              onClick={() => openEvidence(primary)}
            >
              {evidenceLabel(primary)}
              <ArrowRight size={13} />
            </UI.Button>
          )}
          {node.linkedWorkflow && (
            <UI.Button
              variant="outline"
              size="sm"
              onClick={() => openWorkflow(node.linkedWorkflow!)}
            >
              Open linked workflow <ArrowRight size={13} />
            </UI.Button>
          )}
        </div>
      </div>
      <p className="journey-caption">
        {node.status ? `Producer-reported: ${node.status} · ` : ""}
        {compact ? "Full conversation · not limited to this activity. " : ""}
        {provenance}
      </p>
      {node.workflow && !node.linkedWorkflow && (
        <p>Linked workflow unavailable in loaded sources.</p>
      )}
      {!compact && node.summary && (
        <p className="journey-summary">{node.summary}</p>
      )}
      <details className="journey-references">
        <summary>Relationships & evidence</summary>
        {compact && ancestors.length > 0 && (
          <nav className="journey-breadcrumb" aria-label="Activity ancestors">
            {ancestors.map((item) => (
              <UI.Button
                key={item.id}
                variant="link"
                size="sm"
                onClick={() => select(item)}
              >
                {item.title} <ChevronRight size={12} />
              </UI.Button>
            ))}
          </nav>
        )}
        <p>
          {node.kind ?? node.type}
          {node.status ? ` · Reported: ${node.status}` : ""}
          {node.at !== undefined ? ` · ${recordedTime(node.at)}` : ""}
        </p>
        {compact && node.summary && (
          <p className="journey-summary">{node.summary}</p>
        )}
        {!!Object.keys(node.attributes ?? {}).length && (
          <dl className="journey-attributes">
            {Object.entries(node.attributes ?? {}).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {run.document && (
          <p>Producer document {run.document.id} · latest observation</p>
        )}
        {edges.map((edge, index) => {
          const incoming = edge.to === node.id;
          const other = byId.get(incoming ? edge.from : edge.to);
          return (
            <div key={index} className="journey-reference">
              <span>
                {incoming ? "From" : "To"} · {edge.label ?? edge.kind}
              </span>
              {other ? (
                <UI.Button
                  variant="link"
                  size="sm"
                  onClick={() => select(other)}
                >
                  {other.title}
                </UI.Button>
              ) : (
                <span>Unavailable: {incoming ? edge.from : edge.to}</span>
              )}
            </div>
          );
        })}
        {node.evidence.map((e, index) => (
          <div className="journey-reference" key={index}>
            <UI.Button
              variant="link"
              size="sm"
              disabled={!e.member}
              onClick={() => openEvidence(e)}
            >
              {evidenceLabel(e)}
            </UI.Button>
            {!e.member && <span>{e.unavailable}</span>}
          </div>
        ))}
      </details>
    </section>
  );
}

function evidenceLabel(e: WorkflowNode["evidence"][number]) {
  return (
    e.label ??
    (e.entryId
      ? `Saved entry ${e.entryId}`
      : e.taskId
        ? `Task ${e.taskId}`
        : e.documentId
          ? `Document ${e.documentId}`
          : "Full conversation")
  );
}
