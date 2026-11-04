import {
  Fragment,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Circle,
  GitBranch,
  RefreshCw,
  Search,
  Settings2,
} from "lucide-react";
import { UI } from "./controls";
import { processTime as clock } from "./process-time";
import { ProcessTranscript, type TurnView } from "./ProcessTranscript";
import type {
  AgentProcess,
  ProcessAgent,
  ProcessCatalog,
  ProcessTurns,
  RecordedTurn,
} from "../shared/processes";
import "./process.css";

const Library = lazy(() =>
  import("./App").then((module) => ({ default: module.App })),
);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
type Route = { processKey?: string; agentKey?: string; entryId?: number };
const routeKey = (route: Route) =>
  `${route.processKey ?? "processes"}/${route.agentKey ?? ""}/${route.entryId ?? ""}`;
const turnHint =
  "One turn is one saved assistant response, including its tool calls and results. Tool calls are not counted as extra turns.";

export function ProcessApp() {
  const [catalog, setCatalog] = useState<ProcessCatalog>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [route, setRoute] = useState<Route>({});
  const [query, setQuery] = useState("");
  const [agentQuery, setAgentQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [library, setLibrary] = useState(false);
  const [settings, setSettings] = useState(false);
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [turnLists, setTurnLists] = useState<Record<string, ProcessTurns>>({});
  const processCache = useRef(new Map<string, AgentProcess>());
  const transcriptCache = useRef(new Map<string, TurnView>());
  const turnScroll = useRef(new Map<string, number>());
  const scroll = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, number>());
  const back = useRef<Route[]>([]);
  const forward = useRef<Route[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    void window.observer
      .preferences()
      .then((value) => setTheme(value.theme))
      .catch((error) => setError(errorText(error)));
  }, []);
  useEffect(() => {
    if (library) {
      delete document.documentElement.dataset.observerView;
      return;
    }
    document.documentElement.dataset.observerView = "processes";
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
    };
  }, [theme, library]);

  useEffect(() => {
    if (library) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      setLoading(true);
      try {
        const data = await window.observer.processes();
        if (!cancelled) {
          for (const process of data.processes) {
            const previous = processCache.current.get(process.key);
            if (process.issues.length && previous?.agents.length) {
              const agents = new Map(
                previous.agents.map((agent) => [agent.key, agent]),
              );
              for (const agent of process.agents) agents.set(agent.key, agent);
              process.agents = [...agents.values()];
              process.issues.push(
                "Unavailable sources show their last observation.",
              );
            }
            processCache.current.set(process.key, process);
          }
          setCatalog(data);
          setError("");
        }
      } catch (error) {
        if (!cancelled) setError(errorText(error));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(refresh, 5000);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [revision, library]);

  const navigate = useCallback(
    (next: Route, history = true) => {
      if (routeKey(route) === routeKey(next)) return;
      positions.current.set(routeKey(route), scroll.current?.scrollTop ?? 0);
      if (history) {
        back.current.push(route);
        forward.current = [];
      }
      setRoute(next);
    },
    [route],
  );

  useLayoutEffect(() => {
    scroll.current?.scrollTo({
      top: positions.current.get(routeKey(route)) ?? 0,
    });
    heading.current?.focus({ preventScroll: true });
  }, [route, library]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        settings ||
        library ||
        (event.target as HTMLElement).closest(
          "input,textarea,[contenteditable=true]",
        )
      )
        return;
      const previous =
        (event.altKey && event.key === "ArrowLeft") ||
        (event.metaKey && event.key === "[");
      const next =
        (event.altKey && event.key === "ArrowRight") ||
        (event.metaKey && event.key === "]");
      if (previous && back.current.length) {
        event.preventDefault();
        forward.current.push(route);
        navigate(back.current.pop()!, false);
      } else if (next && forward.current.length) {
        event.preventDefault();
        back.current.push(route);
        navigate(forward.current.pop()!, false);
      } else if (event.key === "Escape" && route.entryId) {
        navigate({ processKey: route.processKey });
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [navigate, route, settings, library]);

  const process = route.processKey
    ? processCache.current.get(route.processKey)
    : undefined;
  const agent = process?.agents.find((item) => item.key === route.agentKey);
  const live = Boolean(
    process && catalog?.processes.some((item) => item.key === process.key),
  );
  const turns = agent ? turnLists[agent.key]?.turns : undefined;
  const turn = turns?.find((item) => item.entryId === route.entryId);
  const turnIndex =
    turns?.findIndex((item) => item.entryId === route.entryId) ?? -1;
  const transcriptKey = `${agent?.key}:${turn?.entryId}`;
  if (agent && turn && !transcriptCache.current.has(transcriptKey))
    transcriptCache.current.set(transcriptKey, {
      expanded: new Set(),
      tools: new Map(),
    });
  const openTurn = (agent: ProcessAgent, turn: RecordedTurn) =>
    navigate({
      processKey: process!.key,
      agentKey: agent.key,
      entryId: turn.entryId,
    });
  const saveTurns = useCallback(
    (key: string, data: ProcessTurns) =>
      setTurnLists((previous) => ({ ...previous, [key]: data })),
    [],
  );
  const toggleAgent = (key: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const filtered = (catalog?.processes ?? []).filter((process) =>
    `${process.name} ${process.application} ${process.pid}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const filteredAgents =
    process?.agents.filter((agent) =>
      `${agent.name} ${agent.title}`
        .toLocaleLowerCase()
        .includes(agentQuery.toLocaleLowerCase()),
    ) ?? [];
  const issues = [
    error,
    ...(catalog?.issues ?? []),
    ...(process?.issues ?? []),
  ];

  if (library)
    return (
      <div className="observer-library">
        <div className="library-return">
          <UI.Button variant="ghost" onClick={() => setLibrary(false)}>
            <ArrowLeft /> Processes
          </UI.Button>
        </div>
        <Suspense
          fallback={<div className="process-empty">Opening saved sources…</div>}
        >
          <Library />
        </Suspense>
      </div>
    );

  return (
    <div className="process-app">
      <header className="process-window-bar">
        <span>Dispatch Observer</span>
        <UI.Button
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          onClick={() => setSettings(true)}
        >
          <Settings2 />
        </UI.Button>
      </header>
      <main ref={scroll} className="process-scroll">
        <div
          className={`process-page ${agent && turn ? "process-reading-page" : ""}`}
        >
          {process && (
            <UI.Breadcrumb className="process-breadcrumb">
              <UI.BreadcrumbList>
                <UI.BreadcrumbItem>
                  <UI.BreadcrumbLink
                    render={
                      <button type="button" onClick={() => navigate({})} />
                    }
                  >
                    Processes
                  </UI.BreadcrumbLink>
                </UI.BreadcrumbItem>
                <UI.BreadcrumbSeparator />
                <UI.BreadcrumbItem>
                  {agent ? (
                    <UI.BreadcrumbLink
                      render={
                        <button
                          type="button"
                          onClick={() => navigate({ processKey: process.key })}
                        />
                      }
                    >
                      {process.name}
                    </UI.BreadcrumbLink>
                  ) : (
                    <UI.BreadcrumbPage>{process.name}</UI.BreadcrumbPage>
                  )}
                </UI.BreadcrumbItem>
                {agent && (
                  <>
                    <UI.BreadcrumbSeparator />
                    <UI.BreadcrumbItem>
                      <UI.BreadcrumbLink
                        render={
                          <button
                            type="button"
                            onClick={() => {
                              setExpanded((previous) =>
                                new Set(previous).add(agent.key),
                              );
                              navigate({ processKey: process.key });
                            }}
                          />
                        }
                      >
                        {agent.name}
                      </UI.BreadcrumbLink>
                    </UI.BreadcrumbItem>
                    <UI.BreadcrumbSeparator />
                    <UI.BreadcrumbItem>
                      <UI.BreadcrumbPage>
                        Turn {turn?.number ?? "…"}
                      </UI.BreadcrumbPage>
                    </UI.BreadcrumbItem>
                  </>
                )}
              </UI.BreadcrumbList>
            </UI.Breadcrumb>
          )}
          <div className="process-heading">
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {agent
                  ? `Turn ${turn?.number ?? "…"}`
                  : (process?.name ?? "Processes")}
              </h1>
              <p>
                {agent
                  ? `${agent.name} · ${clock(turn?.at)}`
                  : process
                    ? `${process.application} · PID ${process.pid} · Started ${clock(process.startedAt)}`
                    : `Agent processes running on ${catalog?.host ?? "this machine"}.`}
              </p>
            </div>
            {agent && turns ? (
              <div className="turn-navigation">
                <UI.Button
                  variant="outline"
                  size="icon"
                  aria-label="Previous turn"
                  disabled={turnIndex <= 0}
                  onClick={() => openTurn(agent, turns[turnIndex - 1])}
                >
                  <ArrowLeft />
                </UI.Button>
                <span>
                  {turn?.number ?? "—"} of {turns.length}
                </span>
                <UI.Button
                  variant="outline"
                  size="icon"
                  aria-label="Next turn"
                  disabled={turnIndex < 0 || turnIndex >= turns.length - 1}
                  onClick={() => openTurn(agent, turns[turnIndex + 1])}
                >
                  <ArrowRight />
                </UI.Button>
              </div>
            ) : process ? (
              <span className="process-status">
                <i className={live ? "status-dot" : "status-dot idle"} />
                {live ? "Running" : "No longer observed"}
              </span>
            ) : (
              <span className="process-status">
                <i className={error ? "status-dot idle" : "status-dot"} />
                {error ? "Discovery unavailable" : "Running processes"}
              </span>
            )}
          </div>
          {issues.filter(Boolean).length > 0 && (
            <div role="status" className="process-notice">
              <span>
                {issues.filter(Boolean).join(" · ")}
                {error && catalog ? " Showing the last observation." : ""}
              </span>
              <UI.Button
                variant="outline"
                size="sm"
                onClick={() => setRevision((value) => value + 1)}
              >
                Retry
              </UI.Button>
            </div>
          )}

          {!process ? (
            <>
              <div className="process-search">
                <Search aria-hidden="true" />
                <UI.Input
                  aria-label="Find a process"
                  placeholder="Find a process…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <UI.Table className="process-table process-overview-table">
                <UI.TableHeader>
                  <UI.TableRow>
                    <UI.TableHead>Process</UI.TableHead>
                    <UI.TableHead>Application</UI.TableHead>
                    <UI.TableHead>PID</UI.TableHead>
                    <UI.TableHead className="numeric">Agents</UI.TableHead>
                    <UI.TableHead className="numeric" title={turnHint}>
                      Turns
                    </UI.TableHead>
                    <UI.TableHead>Started</UI.TableHead>
                    <UI.TableHead>
                      <span className="sr-only">Open</span>
                    </UI.TableHead>
                  </UI.TableRow>
                </UI.TableHeader>
                <UI.TableBody>
                  {filtered.map((process) => (
                    <UI.TableRow
                      key={process.key}
                      className="process-selectable"
                      onClick={() => navigate({ processKey: process.key })}
                    >
                      <UI.TableCell>
                        <UI.Button
                          variant="ghost"
                          className="process-name-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            navigate({ processKey: process.key });
                          }}
                        >
                          <i className="status-dot" />
                          {process.name}
                        </UI.Button>
                      </UI.TableCell>
                      <UI.TableCell className="secondary">
                        {process.application}
                      </UI.TableCell>
                      <UI.TableCell className="secondary tabular-nums">
                        {process.pid}
                      </UI.TableCell>
                      <UI.TableCell className="numeric">
                        {process.issues.length ? "—" : process.agents.length}
                      </UI.TableCell>
                      <UI.TableCell className="numeric">
                        {process.issues.length
                          ? "—"
                          : process.agents.reduce(
                              (count, agent) => count + agent.turns,
                              0,
                            )}
                      </UI.TableCell>
                      <UI.TableCell className="tabular-nums">
                        {clock(process.startedAt)}
                      </UI.TableCell>
                      <UI.TableCell>
                        <ChevronRight className="size-4 secondary" />
                      </UI.TableCell>
                    </UI.TableRow>
                  ))}
                </UI.TableBody>
              </UI.Table>
              {!filtered.length && (
                <div className="process-empty">
                  {!catalog && loading ? (
                    "Finding agent processes…"
                  ) : !catalog && error ? (
                    "Process discovery is unavailable. Retry above or open saved work in Settings."
                  ) : query ? (
                    <>
                      <p>No processes match “{query}”.</p>
                      <UI.Button variant="ghost" onClick={() => setQuery("")}>
                        Clear search
                      </UI.Button>
                    </>
                  ) : (
                    <>
                      <p>No running agent processes found.</p>
                      <span>
                        Saved conversations and remote connections are available
                        in Settings.
                      </span>
                    </>
                  )}
                </div>
              )}
              <div className="process-list-footer">
                <span>
                  {catalog
                    ? query
                      ? `${filtered.length} of ${catalog.processes.length} processes`
                      : `${catalog.processes.length} running ${catalog.processes.length === 1 ? "process" : "processes"}`
                    : ""}
                </span>
                <span>
                  {catalog
                    ? `Updated ${clock(Date.parse(catalog.observedAt))}`
                    : ""}
                  <UI.Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Refresh processes"
                    disabled={loading}
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    <RefreshCw className={loading ? "animate-spin" : ""} />
                  </UI.Button>
                </span>
              </div>
            </>
          ) : agent && turn ? (
            <ProcessTranscript
              key={transcriptKey}
              agent={agent}
              turn={turn}
              view={transcriptCache.current.get(transcriptKey)!}
              live={live}
            />
          ) : (
            <>
              <div className="process-agents-toolbar">
                <p className="process-summary" title={turnHint}>
                  {process.issues.length && !process.agents.length ? (
                    "Counts unavailable"
                  ) : (
                    <>
                      {process.issues.length > 0 && "Last observed: "}
                      {process.agents.length} agent runs <span>·</span>{" "}
                      {process.agents.reduce(
                        (count, agent) => count + agent.turns,
                        0,
                      )}{" "}
                      saved turns
                    </>
                  )}
                </p>
                <div className="process-search">
                  <Search aria-hidden="true" />
                  <UI.Input
                    aria-label="Find an agent"
                    placeholder="Find an agent…"
                    value={agentQuery}
                    onChange={(event) => setAgentQuery(event.target.value)}
                  />
                </div>
              </div>
              <UI.Table className="process-table agent-table">
                <UI.TableHeader>
                  <UI.TableRow>
                    <UI.TableHead>Started</UI.TableHead>
                    <UI.TableHead>Agent</UI.TableHead>
                    <UI.TableHead className="numeric" title={turnHint}>
                      Turns
                    </UI.TableHead>
                    <UI.TableHead>Status</UI.TableHead>
                  </UI.TableRow>
                </UI.TableHeader>
                <UI.TableBody>
                  {filteredAgents.map((agent) => (
                    <AgentRow
                      key={agent.key}
                      agent={agent}
                      agents={process.agents}
                      expanded={expanded.has(agent.key)}
                      onToggle={() => toggleAgent(agent.key)}
                      cached={turnLists[agent.key]}
                      saveTurns={saveTurns}
                      positions={turnScroll.current}
                      openTurn={(turn) => openTurn(agent, turn)}
                    />
                  ))}
                </UI.TableBody>
              </UI.Table>
              {!process.agents.length && (
                <div className="process-empty">
                  {process.issues.length
                    ? "Agent state is unavailable. Retry after resolving the source issue above."
                    : "No conversations recorded yet."}
                </div>
              )}
              {process.agents.length > 0 && !filteredAgents.length && (
                <div className="process-empty">
                  <p>No agents match “{agentQuery}”.</p>
                  <UI.Button variant="ghost" onClick={() => setAgentQuery("")}>
                    Clear search
                  </UI.Button>
                </div>
              )}
              <div className="process-list-footer">
                <span>Ordered by recorded start time</span>
                <UI.Button variant="ghost" onClick={() => navigate({})}>
                  <ArrowLeft /> Processes
                </UI.Button>
              </div>
            </>
          )}
        </div>
      </main>
      <UI.Dialog open={settings} onOpenChange={setSettings} title="Settings">
        <div className="process-settings-body">
          <UI.Field label="Appearance">
            {(props) => (
              <UI.Select
                value={theme}
                onValueChange={async (value) => {
                  if (!value) return;
                  try {
                    await window.observer.theme(value as typeof theme);
                    setTheme(value as typeof theme);
                  } catch (error) {
                    setError(errorText(error));
                  }
                }}
              >
                <UI.SelectTrigger {...props}>
                  <UI.SelectValue />
                </UI.SelectTrigger>
                <UI.SelectContent>
                  {["system", "light", "dark"].map((value) => (
                    <UI.SelectItem key={value} value={value}>
                      {value[0].toUpperCase() + value.slice(1)}
                    </UI.SelectItem>
                  ))}
                </UI.SelectContent>
              </UI.Select>
            )}
          </UI.Field>
          <div>
            <h3>Saved sources and workflows</h3>
            <p>
              Open saved conversations, remote connections and recorded
              playback.
            </p>
            <UI.Button
              variant="outline"
              onClick={() => {
                setSettings(false);
                setLibrary(true);
              }}
            >
              Open saved work <ArrowRight />
            </UI.Button>
          </div>
        </div>
      </UI.Dialog>
    </div>
  );
}

function AgentRow({
  agent,
  agents,
  expanded,
  onToggle,
  cached,
  saveTurns,
  openTurn,
  positions,
}: {
  agent: ProcessAgent;
  agents: ProcessAgent[];
  expanded: boolean;
  onToggle(): void;
  cached?: ProcessTurns;
  saveTurns(key: string, data: ProcessTurns): void;
  openTurn(turn: RecordedTurn): void;
  positions: Map<string, number>;
}) {
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = positions.get(agent.key) ?? 0;
  }, [expanded]);
  useEffect(() => {
    if (!expanded || (cached?.turns.length === agent.turns && !retry)) return;
    let cancelled = false;
    setLoading(true);
    void window.observer
      .processTurns({
        sourceId: agent.sourceId,
        conversationId: agent.conversationId,
      })
      .then((data) => {
        if (!cancelled) {
          saveTurns(agent.key, data);
          setError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, agent.key, agent.turns, retry, saveTurns]);
  const parent = agents.find((item) => item.key === agent.parentKey);
  return (
    <Fragment>
      <UI.TableRow
        className="process-selectable"
        onClick={onToggle}
        data-state={expanded ? "selected" : undefined}
      >
        <UI.TableCell className="agent-start secondary tabular-nums">
          {clock(agent.startedAt)}
        </UI.TableCell>
        <UI.TableCell>
          <UI.Button
            variant="ghost"
            className="agent-name-button"
            aria-expanded={expanded}
            aria-controls={`turns-${agent.sourceId}-${agent.conversationId}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
            <span>{agent.name}</span>
          </UI.Button>
          {parent && (
            <span className="agent-parent">
              <GitBranch className="size-3" />
              From {parent.name}
            </span>
          )}
        </UI.TableCell>
        <UI.TableCell className="numeric">{agent.turns}</UI.TableCell>
        <UI.TableCell>
          <span
            className="agent-state"
            title={`${agent.active} unfinished recorded tasks`}
          >
            <Circle
              className={`size-2 ${agent.active ? "fill-current text-emerald-600" : "fill-current text-muted-foreground/40"}`}
            />
            {agent.active
              ? "Pending work"
              : agent.turns
                ? "Idle"
                : "No turns yet"}
          </span>
        </UI.TableCell>
      </UI.TableRow>
      {expanded && (
        <UI.TableRow className="agent-turns-row">
          <UI.TableCell colSpan={4}>
            <div
              className="agent-turns"
              id={`turns-${agent.sourceId}-${agent.conversationId}`}
            >
              <p className="agent-assignment">{agent.title}</p>
              {agent.parallelKeys.length > 0 && (
                <p
                  className="agent-parallel"
                  title={agents
                    .filter((other) => agent.parallelKeys.includes(other.key))
                    .map((other) => other.name)
                    .join(", ")}
                >
                  Model turns overlapped with {agent.parallelKeys.length} other{" "}
                  {agent.parallelKeys.length === 1 ? "agent" : "agents"}.
                </p>
              )}
              {error && (
                <div role="status" className="process-notice">
                  {error}
                  <UI.Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRetry((value) => value + 1)}
                  >
                    Retry
                  </UI.Button>
                </div>
              )}
              {cached?.turns.length ? (
                <div className="turn-list-heading">
                  <span>{cached.turns.length} saved turns</span>
                  <UI.Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openTurn(cached.turns.at(-1)!)}
                  >
                    Latest turn <ArrowRight />
                  </UI.Button>
                </div>
              ) : null}
              <div
                ref={list}
                className="turn-list"
                onScroll={(event) =>
                  positions.set(agent.key, event.currentTarget.scrollTop)
                }
              >
                {loading && !cached ? (
                  <p className="turn-list-empty">Reading turns…</p>
                ) : !cached?.turns.length ? (
                  <p className="turn-list-empty">
                    No assistant turn has been saved yet.
                  </p>
                ) : (
                  cached.turns.map((turn) => (
                    <UI.Button
                      key={turn.entryId}
                      variant="ghost"
                      className="turn-list-row"
                      onClick={() => openTurn(turn)}
                    >
                      <span className="turn-number">Turn {turn.number}</span>
                      <span className="turn-summary">{turn.summary}</span>
                      <span className="turn-tool-count">
                        {turn.tools
                          ? `${turn.tools} ${turn.tools === 1 ? "tool" : "tools"}`
                          : ""}
                      </span>
                      <ChevronRight />
                    </UI.Button>
                  ))
                )}
              </div>
            </div>
          </UI.TableCell>
        </UI.TableRow>
      )}
    </Fragment>
  );
}
