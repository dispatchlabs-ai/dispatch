import { useEffect, useState } from "react";
import { ArrowRight, Bot, RefreshCw, Search } from "lucide-react";
import type {
  Connection,
  LocalWork as LocalWorkData,
} from "../shared/contracts";
import { UI } from "./controls";
import { time } from "./Details";

export function LocalWork({
  open,
  add,
}: {
  open(connection: Connection, conversationId?: number): Promise<void>;
  add(): void;
}) {
  const [data, setData] = useState<LocalWorkData>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await window.observer.localWork();
        if (!cancelled) {
          setData(next);
          setError("");
        }
      } catch (error) {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [revision]);
  const choose = async (connection: Connection, id?: number) => {
    setOpening(true);
    try {
      await open(connection, id);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  };
  const active =
    data?.stores.reduce(
      (sum, store) =>
        sum + store.conversations.filter((c) => c.active > 0).length,
      0,
    ) ?? 0;
  const stores =
    data?.stores.filter((store) =>
      `${store.connection.name} ${store.connection.path} ${store.conversations.map((c) => c.title).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  return (
    <section className="local-work">
      <header className="local-heading">
        <div>
          <p className="eyebrow">DISPATCH OBSERVER</p>
          <h1>This machine</h1>
          <p>
            Open a workflow or agent to read its conversation and tool calls.
          </p>
        </div>
        <UI.Button
          variant="outline"
          size="sm"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={15} />
          Refresh
        </UI.Button>
      </header>
      <div className="local-summary">
        <strong>
          {data
            ? `${data.stores.length} open agent stores`
            : "Looking for local agents…"}
        </strong>
        <span>{active} conversations with unfinished tasks</span>
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
            placeholder="Find an agent or workflow…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <UI.Button
          variant={all ? "secondary" : "outline"}
          size="sm"
          aria-pressed={all}
          onClick={() => setAll(!all)}
        >
          {all ? "Showing all conversations" : "Show completed conversations"}
        </UI.Button>
      </div>
      {error && (
        <div className="source-error" role="alert">
          {error}
        </div>
      )}
      {data?.issues.map((issue) => (
        <p className="notice" key={issue}>
          {issue}
        </p>
      ))}
      <div className="local-stores">
        {stores.map((store) => {
          const conversations = store.conversations.filter(
            (c) => all || c.active > 0,
          );
          return (
            <section className="local-store" key={store.connection.path}>
              <header>
                <Bot size={20} />
                <div>
                  <h2>{store.connection.name}</h2>
                  <p className="local-path">{store.connection.path}</p>
                </div>
                <span className="local-presence">
                  {error ? "Last observed" : "Process observed"} ·{" "}
                  {store.pids.join(", ")}
                </span>
              </header>
              {conversations.map((conversation) => (
                <UI.Button
                  key={conversation.id}
                  variant="ghost"
                  className="local-conversation"
                  disabled={opening}
                  onClick={() => void choose(store.connection, conversation.id)}
                >
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>
                      {conversation.entryCount} saved entries
                      {conversation.owner ? " · Child conversation" : ""}
                      {conversation.lastAt
                        ? ` · ${time(conversation.lastAt)}`
                        : ""}
                    </small>
                  </span>
                  <span className="local-work-status">
                    {conversation.active
                      ? `${conversation.active} unfinished ${conversation.active === 1 ? "task" : "tasks"}`
                      : "No unfinished tasks"}
                  </span>
                  <ArrowRight size={17} />
                </UI.Button>
              ))}
              {!conversations.length && (
                <div className="local-idle">
                  <span>
                    No unfinished conversations. The process has this store
                    open.
                  </span>
                  <UI.Button
                    variant="link"
                    size="sm"
                    disabled={opening}
                    onClick={() => void choose(store.connection)}
                  >
                    View saved conversations <ArrowRight size={14} />
                  </UI.Button>
                </div>
              )}
            </section>
          );
        })}
      </div>
      {data && !stores.length && (
        <div className="empty-inline">
          <h2>
            {query ? "No matching local work" : "No open Pi stores found"}
          </h2>
          <p>
            {query
              ? "Try another name."
              : "Open an existing store to inspect saved work, or refresh after starting an agent."}
          </p>
          {!query && (
            <UI.Button variant="outline" onClick={add}>
              Add connection
            </UI.Button>
          )}
        </div>
      )}
      <p className="evidence-note">
        Local SQLite stores open for writing by your user’s processes. Process
        presence does not mean a model is working; unfinished tasks may be
        waiting. Remote stores and other runtimes are not discovered.
      </p>
    </section>
  );
}
