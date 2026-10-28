import { useState } from "react";
import { ArrowRight, Bot, RefreshCw, Search, Workflow } from "lucide-react";
import type {
  Connection,
  LocalWork as LocalWorkData,
} from "../shared/contracts";
import {
  memberKey,
  readableName,
  workflowActivity,
  type WorkflowRun,
} from "../shared/workflows";
import { recordedTime, responseSummary } from "../shared/workSummary";
import { UI } from "./controls";
import { time } from "./Details";

export function LocalWork({
  data,
  error,
  loading,
  refresh,
  runs,
  openWorkflow,
  open,
  settings,
  sourceName,
}: {
  data?: LocalWorkData;
  error: string;
  loading: boolean;
  refresh(): void;
  runs: WorkflowRun[];
  openWorkflow(run: WorkflowRun): void;
  open(connection: Connection, conversationId?: number): Promise<void>;
  settings(): void;
  sourceName?: string;
}) {
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(true);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const choose = async (connection: Connection, id: number) => {
    setOpening(true);
    try {
      await open(connection, id);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  };
  const matches = (text: string) =>
    text.toLowerCase().includes(query.toLowerCase());
  const unfinished =
    data?.stores.reduce(
      (sum, store) =>
        sum + store.conversations.filter((c) => c.active > 0).length,
      0,
    ) ?? 0;
  const grouped = new Set(
    runs.flatMap((run) =>
      run.members.map((m) => memberKey(m.connection, m.conversation.id)),
    ),
  );
  const visibleRuns = runs.filter(
    (run) =>
      (all || run.members.some((m) => m.conversation.active > 0)) &&
      matches(
        `${run.name} ${run.cycle} ${run.nodes.map((n) => n.title).join(" ")} ${run.members.map((m) => m.conversation.title).join(" ")}`,
      ),
  );
  const standalone = (data?.stores ?? []).flatMap((store) =>
    store.conversations
      .filter(
        (c) =>
          c.entryCount > 0 &&
          !grouped.has(memberKey(store.connection, c.id)) &&
          (all || c.active > 0) &&
          matches(`${store.connection.name} ${c.title} ${c.id}`),
      )
      .map((conversation) => ({ ...store, conversation })),
  );
  return (
    <section className="local-work">
      <header className="local-heading">
        <div>
          <p className="eyebrow">DISPATCH OBSERVER</p>
          <h1>{sourceName ?? "This machine"}</h1>
          <p>Follow the workflow, then read the conversations behind it.</p>
        </div>
        <UI.Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={refresh}
        >
          <RefreshCw size={15} />
          {loading ? "Refreshing…" : "Refresh"}
        </UI.Button>
      </header>
      <div className="local-summary">
        <strong>
          {data
            ? `${runs.length} recorded ${runs.length === 1 ? "workflow" : "workflows"}`
            : "Looking for local work…"}
        </strong>
        <span>
          {unfinished} {unfinished === 1 ? "conversation" : "conversations"}{" "}
          with unfinished tasks
        </span>
        {data && (
          <span>
            Observed {time(Date.parse(data.observedAt))}
            {error ? " · stale" : ""}
          </span>
        )}
      </div>
      <div className="local-filters">
        <div className="search-field">
          <Search size={15} />
          <UI.Input
            aria-label="Find local work"
            placeholder="Find a workflow or conversation…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <UI.Button
          variant={all ? "secondary" : "outline"}
          size="sm"
          aria-pressed={all}
          onClick={() => setAll(!all)}
        >
          {all ? "All saved work" : "Unfinished only"}
        </UI.Button>
      </div>
      {(error || openError) && (
        <div className="source-error" role="alert">
          {error || openError}
        </div>
      )}
      {!!data?.issues.length && (
        <details className="source-notices">
          <summary>{data.issues.length} source notices</summary>
          {data.issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </details>
      )}
      {data && (
        <>
          <h2 className="workflow-section-heading">
            Workflows{" "}
            <small>Latest recorded activity first · loaded sources</small>
          </h2>
          {!visibleRuns.length && (
            <p className="evidence-note">
              {query
                ? "No workflows match this search."
                : all
                  ? "No recorded workflows in loaded sources."
                  : "No unfinished workflows. Choose All saved work to see history."}
            </p>
          )}
          <div className="workflow-cards">
            {visibleRuns.map((run) => {
              const latest =
                run.origin === "handoffs"
                  ? run.members.find(
                      (m) => m.role === "assignment" && !m.shared,
                    )
                  : undefined;
              const unfinished = run.members.filter(
                (m) => m.conversation.active > 0,
              ).length;
              return (
                <UI.Button
                  variant="outline"
                  className="workflow-card"
                  key={run.id}
                  onClick={() => openWorkflow(run)}
                >
                  <Workflow size={22} />
                  <span>
                    <strong className="agent-name">
                      {readableName(run.name)}
                    </strong>
                    <span>
                      Recorded activity {recordedTime(workflowActivity(run))}
                    </span>
                    {latest && (
                      <span>
                        Latest assignment:{" "}
                        {latest.conversation.opening?.labels?.assignment} ·{" "}
                        {responseSummary(latest.conversation)}
                      </span>
                    )}
                    <small>
                      {run.cycle} ·{" "}
                      {run.origin === "document"
                        ? "Producer record"
                        : run.origin === "native"
                          ? "Native delegation"
                          : "Handoffs"}{" "}
                      · {run.nodes.length} activities · {run.members.length}{" "}
                      conversations
                      {run.issues.length > 0
                        ? ` · ${run.issues.length} evidence notices`
                        : ""}
                    </small>
                  </span>
                  <span className="local-work-status">
                    Execution unknown
                    <br />
                    {unfinished} unfinished conversations
                    <br />
                    {run.status
                      ? `Reported: ${run.status}`
                      : "Workflow outcome unknown"}
                  </span>
                  <ArrowRight size={18} />
                </UI.Button>
              );
            })}
          </div>
        </>
      )}
      {standalone.length > 0 && (
        <>
          <h2 className="workflow-section-heading">
            {runs.length ? "Other conversations" : "Conversations"}
          </h2>
          <div className="standalone-conversations">
            {standalone.map(({ connection, conversation: c, pids }) => (
              <UI.Button
                key={memberKey(connection, c.id)}
                variant="ghost"
                className="local-conversation"
                disabled={opening}
                onClick={() => void choose(connection, c.id)}
              >
                <Bot size={18} />
                <span>
                  <strong>{c.title}</strong>
                  <small className="agent-name">
                    {c.agent ? readableName(c.agent) : connection.name}
                    {pids.length ? " · Process observed" : " · Saved history"}
                  </small>
                </span>
                <span className="local-work-status">
                  Execution unknown · {c.active} unfinished tasks
                </span>
                <ArrowRight size={16} />
              </UI.Button>
            ))}
          </div>
        </>
      )}
      {data && !visibleRuns.length && !standalone.length && (
        <div className="empty-inline">
          <h2>
            {query
              ? "No matching work"
              : all
                ? "No recorded work found"
                : "No unfinished work found"}
          </h2>
          <p>
            {query
              ? "Try another name."
              : all
                ? "Open an existing source in Settings to inspect its history."
                : "Choose All saved work to explore earlier workflows and conversations."}
          </p>
          {!query && (
            <UI.Button
              variant="outline"
              onClick={all ? settings : () => setAll(true)}
            >
              {all ? "Open settings" : "Show all saved work"}
            </UI.Button>
          )}
        </div>
      )}
      <p className="evidence-note">
        {sourceName
          ? "Coverage: selected source and loaded local peers. No remote discovery."
          : "Coverage: known agent runtimes, saved sources and sibling Runner stores. Other hosts or installations may be missing."}{" "}
        Unfinished tasks may be waiting; they do not prove a model is running.
      </p>
    </section>
  );
}
