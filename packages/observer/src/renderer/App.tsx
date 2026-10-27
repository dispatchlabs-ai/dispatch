import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  ArrowRight,
  Bot,
  ChevronRight,
  Database,
  FileText,
  GitBranch,
  Menu as MenuIcon,
  Moon,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Sun,
  Terminal,
  Unplug,
  Workflow,
} from "lucide-react";
import { UI } from "./controls";
import { ConnectionDialog } from "./ConnectionDialog";
import { Structure } from "./Structure";
import { PaneResizer } from "./PaneResizer";
import { TranscriptEntry } from "./TranscriptEntry";
import { reconcileActivities } from "../shared/activities";
import { Badge, Details, time, type Selection } from "./Details";
import type {
  Activity,
  Preferences,
  SavedConnection,
  Snapshot,
} from "../shared/contracts";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const startsEarlier = (left: Snapshot, right: Snapshot) =>
  (left.earliestSequence ?? Infinity) < (right.earliestSequence ?? Infinity) ||
  (left.earliestSequence === right.earliestSequence &&
    (left.earliestId ?? Infinity) <= (right.earliestId ?? Infinity));
function merge(previous: Snapshot | undefined, next: Snapshot): Snapshot {
  if (
    !previous ||
    previous.sourceId !== next.sourceId ||
    previous.conversationId !== next.conversationId ||
    next.sequence < previous.sequence
  )
    return next;
  const activities = new Map(
    previous.activities.map((item) => [item.id, item]),
  );
  for (const item of next.activities) activities.set(item.id, item);
  return {
    ...next,
    activities: reconcileActivities(
      [...activities.values()].sort(
        (a, b) =>
          a.sequence - b.sequence ||
          a.entryId - b.entryId ||
          a.id.localeCompare(b.id, undefined, { numeric: true }),
      ),
    ),
    earliestId: startsEarlier(next, previous)
      ? next.earliestId
      : previous.earliestId,
    earliestSequence: startsEarlier(next, previous)
      ? next.earliestSequence
      : previous.earliestSequence,
    hasEarlier: startsEarlier(next, previous)
      ? next.hasEarlier
      : previous.hasEarlier,
  };
}

type ConversationView = {
  conversationId: number;
  snapshot?: Snapshot;
  following: boolean;
  frozen?: Snapshot;
  cursor: number;
  tab: string;
  selection?: Selection;
  activityQuery: string;
  category: string;
};

export function App() {
  const [railWidth, setRailWidth] = useState(230);
  const [detailWidth, setDetailWidth] = useState(344);
  const [preferences, setPreferences] = useState<Preferences>();
  const [connectionId, setConnectionId] = useState<string>();
  const [status, setStatus] = useState<
    "idle" | "connecting" | "connected" | "disconnected"
  >("idle");
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const current = useRef<Snapshot | undefined>(undefined);
  const [conversationId, setConversationId] = useState<number>();
  const [history, setHistory] = useState<{
    back: ConversationView[];
    forward: ConversationView[];
  }>({ back: [], forward: [] });
  const [following, setFollowing] = useState(true);
  const [frozen, setFrozen] = useState<Snapshot>();
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState("structure");
  const [selection, setSelection] = useState<Selection>();
  const restoringView = useRef(false);
  const [query, setQuery] = useState("");
  const [activityQuery, setActivityQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [dialog, setDialog] = useState<SavedConnection | "new">();
  const [sidebar, setSidebar] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [catalogLimit, setCatalogLimit] = useState(40);
  const timelinePane = useRef<HTMLDivElement>(null);
  const transcriptPane = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const [pollRevision, setPollRevision] = useState(0);
  const connection = preferences?.connections.find(
    (item) => item.id === connectionId,
  );
  const viewed = following ? snapshot : frozen;
  const events = viewed?.activities ?? [];
  const at = following
    ? events.length - 1
    : Math.min(cursor, events.length - 1);
  const selectedConversation = snapshot?.conversations.find(
    (item) => item.id === conversationId,
  );
  const activeEventId = events[at]?.id;
  useEffect(() => {
    const pane =
      tab === "timeline"
        ? timelinePane.current
        : tab === "conversation"
          ? transcriptPane.current
          : null;
    if (activeEventId)
      pane
        ?.querySelector<HTMLElement>(`[data-event-id="${activeEventId}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeEventId, following, tab]);

  const refreshPreferences = useCallback(async () => {
    const value = await window.observer.preferences();
    if (mounted.current) setPreferences(value);
    return value;
  }, []);
  const connect = useCallback(
    async (id: string, preserve = false) => {
      preserve = preserve && current.current?.sourceId === id;
      const turn = ++generation.current;
      setStatus("connecting");
      setError("");
      setConnectionId(id);
      setSidebar(false);
      if (!preserve) {
        setHistory({ back: [], forward: [] });
        current.current = undefined;
        setSnapshot(undefined);
        setConversationId(undefined);
        setFrozen(undefined);
        setFollowing(true);
        setPlaying(false);
        setSelection(undefined);
        setCursor(0);
      }
      try {
        await window.observer.connect(id);
        const catalog = await window.observer.read({ limit: 500 });
        if (turn !== generation.current || !mounted.current) return;
        setStatus("connected");
        if (!preserve) {
          current.current = catalog;
          setSnapshot(catalog);
          setConversationId(
            catalog.conversations.find((item) => !item.owner)?.id ??
              catalog.conversations[0]?.id,
          );
        }
        setPollRevision((value) => value + 1);
        await refreshPreferences();
      } catch (error) {
        if (turn === generation.current && mounted.current) {
          setError(errorMessage(error));
          setStatus("disconnected");
        }
      }
    },
    [refreshPreferences],
  );

  useEffect(() => {
    mounted.current = true;
    void refreshPreferences()
      .then((value) => {
        if (value.lastConnection && mounted.current)
          void connect(value.lastConnection);
      })
      .catch((error) => setError(errorMessage(error)));
    return () => {
      mounted.current = false;
      ++generation.current;
    };
  }, [refreshPreferences, connect]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const dark =
        preferences?.theme === "dark" ||
        (preferences?.theme !== "light" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.dataset.platform = preferences?.platform ?? "";
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preferences?.theme, preferences?.platform]);
  useEffect(() => {
    if (status !== "connected" || !connectionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        let next = await window.observer.read({ conversationId, limit: 500 });
        const previous = current.current;
        // Catch up through retained pages if many commits arrived between polls.
        const lastEntry = previous?.activities.at(-1);
        while (
          !cancelled &&
          lastEntry !== undefined &&
          next.hasEarlier &&
          next.earliestId !== undefined &&
          next.earliestSequence !== undefined &&
          (next.earliestSequence > lastEntry.sequence ||
            (next.earliestSequence === lastEntry.sequence &&
              next.earliestId > lastEntry.entryId))
        ) {
          const earlier = await window.observer.read({
            conversationId,
            before: {
              sequence: next.earliestSequence,
              entryId: next.earliestId,
            },
            limit: 500,
          });
          next = { ...merge(earlier, next), hasEarlier: earlier.hasEarlier };
        }
        if (cancelled) return;
        next = merge(previous, next);
        current.current = next;
        setSnapshot(next);
        setError("");
      } catch (error) {
        if (!cancelled) {
          setError(errorMessage(error));
          setStatus("disconnected");
        }
        return;
      }
      if (!cancelled) timer = setTimeout(() => void refresh(), 1800);
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connectionId, conversationId, status, pollRevision]);
  useEffect(() => {
    if (!playing || following) return;
    const timer = setInterval(
      () =>
        setCursor((previous) => {
          if (previous >= events.length - 1) {
            setPlaying(false);
            return previous;
          }
          return previous + 1;
        }),
      1000 / speed,
    );
    return () => clearInterval(timer);
  }, [playing, following, events.length, speed]);
  useEffect(() => {
    // History restores the inspector as well as the playhead.
    if (restoringView.current) {
      restoringView.current = false;
      return;
    }
    if (!following && events[at])
      setSelection({ kind: "activity", value: events[at] });
  }, [at, following, viewed]);

  const captureView = (): ConversationView | undefined =>
    conversationId === undefined
      ? undefined
      : {
          conversationId,
          snapshot,
          following,
          frozen,
          cursor,
          tab,
          selection,
          activityQuery,
          category,
        };
  const openConversation = (id: number, view?: ConversationView) => {
    ++generation.current;
    restoringView.current = Boolean(view);
    current.current =
      view?.snapshot ??
      (snapshot
        ? {
            ...snapshot,
            conversationId: id,
            activities: [],
            tasks: [],
            documents: [],
            live: [],
            hasEarlier: false,
            earliestId: undefined,
            earliestSequence: undefined,
          }
        : undefined);
    setSnapshot(current.current);
    setConversationId(id);
    setFollowing(view?.following ?? true);
    setPlaying(false);
    setFrozen(view?.frozen);
    setCursor(view?.cursor ?? 0);
    setTab(view?.tab ?? tab);
    setSelection(view?.selection);
    setActivityQuery(view?.activityQuery ?? "");
    setCategory(view?.category ?? "all");
    setSidebar(false);
  };
  const chooseConversation = (id: number) => {
    if (id === conversationId) return;
    const previous = captureView();
    setHistory((value) => ({
      back: previous ? [...value.back, previous] : value.back,
      forward: [],
    }));
    openConversation(id);
  };
  const navigateHistory = (direction: "back" | "forward") => {
    const destination = history[direction].at(-1);
    const previous = captureView();
    if (!destination || !previous || status === "connecting") return;
    setHistory({
      back:
        direction === "back"
          ? history.back.slice(0, -1)
          : [...history.back, previous],
      forward:
        direction === "forward"
          ? history.forward.slice(0, -1)
          : [...history.forward, previous],
    });
    openConversation(destination.conversationId, destination);
  };
  const pause = (index?: number) => {
    if (snapshot) {
      setFrozen(snapshot);
      setFollowing(false);
      setCursor(index ?? Math.max(0, snapshot.activities.length - 1));
    }
    setPlaying(false);
  };
  const goLive = () => {
    setFollowing(true);
    setPlaying(false);
    setFrozen(undefined);
  };
  const togglePlayback = () => {
    if (following) pause();
    else {
      if (cursor >= events.length - 1) setCursor(0);
      setPlaying((value) => !value);
    }
  };
  const selectActivity = (activity: Activity) => {
    const index = events.findIndex((item) => item.id === activity.id);
    if (following || index < 0)
      pause(snapshot?.activities.findIndex((item) => item.id === activity.id));
    else setCursor(index);
    setSelection({ kind: "activity", value: activity });
  };
  const step = (direction: number) => {
    if (following) pause(Math.max(0, events.length - 1 + direction));
    else
      setCursor((value) =>
        Math.max(0, Math.min(events.length - 1, value + direction)),
      );
    setPlaying(false);
  };
  const loadEarlier = async () => {
    const base = current.current;
    if (base?.earliestId === undefined || base.earliestSequence === undefined)
      return;
    const turn = generation.current;
    setLoadingEarlier(true);
    try {
      const earlier = await window.observer.read({
        conversationId,
        before: { sequence: base.earliestSequence, entryId: base.earliestId },
        limit: 500,
      });
      if (
        turn !== generation.current ||
        current.current?.conversationId !== base.conversationId
      )
        return;
      const next = merge(earlier, current.current ?? base);
      next.hasEarlier = earlier.hasEarlier;
      current.current = next;
      setSnapshot(next);
      if (!following && frozen) {
        const merged = merge(
          {
            ...earlier,
            sequence: frozen.sequence,
            activities: earlier.activities.filter(
              (item) => item.sequence <= frozen.sequence,
            ),
          },
          frozen,
        );
        setCursor(
          (value) =>
            value + merged.activities.length - frozen.activities.length,
        );
        setFrozen(merged);
      }
    } catch (error) {
      if (
        turn === generation.current &&
        current.current?.conversationId === base.conversationId
      )
        setError(errorMessage(error));
    } finally {
      setLoadingEarlier(false);
    }
  };
  const removeConnection = async (id: string) => {
    try {
      await window.observer.remove(id);
      await refreshPreferences();
      if (connectionId === id) {
        ++generation.current;
        setConnectionId(undefined);
        setConversationId(undefined);
        setHistory({ back: [], forward: [] });
        setStatus("idle");
        setSnapshot(undefined);
        current.current = undefined;
        setSelection(undefined);
      }
    } catch (error) {
      setError(errorMessage(error));
    }
  };
  const changeTheme = async () => {
    if (!preferences) return;
    const next = document.documentElement.classList.contains("dark")
      ? "light"
      : "dark";
    await window.observer.theme(next);
    await refreshPreferences();
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (dialog) return;
      if (event.key === "Escape") {
        setSelection(undefined);
        setSidebar(false);
        return;
      }
      const target = event.target as HTMLElement;
      if (
        !target.closest(
          "input,textarea,select,[contenteditable=true],[role=dialog]",
        ) &&
        !event.shiftKey &&
        ((event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")) ||
          (event.metaKey &&
            !event.altKey &&
            !event.ctrlKey &&
            (event.key === "[" || event.key === "]")))
      ) {
        event.preventDefault();
        navigateHistory(
          event.key === "ArrowLeft" || event.key === "[" ? "back" : "forward",
        );
        return;
      }
      if (
        target.closest(
          "input,textarea,select,button,summary,pre,.table-scroll,[contenteditable=true],[role=separator],[role=tab],[role=dialog]",
        ) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      if (event.key === " " && events.length) {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft" && events.length) {
        event.preventDefault();
        step(-1);
      } else if (event.key === "ArrowRight" && events.length) {
        event.preventDefault();
        step(1);
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  });
  const title =
    events
      .find(
        (item) =>
          item.role === "user" && item.conversationId === conversationId,
      )
      ?.text.split("\n")[0]
      .slice(0, 110) ||
    selectedConversation?.title ||
    "Choose a conversation";
  const visibleActivities = events.filter(
    (activity) =>
      (category === "all" || activity.category === category) &&
      (!activityQuery ||
        `${activity.title} ${activity.text}`
          .toLowerCase()
          .includes(activityQuery.toLowerCase())),
  );
  const frozenIds = new Set(frozen?.activities.map((event) => event.id));
  const newCount =
    !following && snapshot
      ? snapshot.activities.filter((item) => !frozenIds.has(item.id)).length
      : 0;
  const detailSelection =
    selection?.kind === "task"
      ? {
          ...selection,
          value:
            snapshot?.tasks.find((task) => task.id === selection.value.id) ??
            selection.value,
        }
      : selection?.kind === "document"
        ? {
            ...selection,
            value:
              snapshot?.documents.find(
                (doc) => doc.id === selection.value.id,
              ) ?? selection.value,
          }
        : selection?.kind === "activity"
          ? {
              ...selection,
              value:
                viewed?.activities.find(
                  (item) => item.id === selection.value.id,
                ) ?? selection.value,
            }
          : selection;
  const catalog = (snapshot?.conversations ?? []).filter(
    (item) =>
      !query ||
      `${item.title} ${item.id}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div
      className="desktop-shell"
      style={
        {
          "--rail-width": `${railWidth}px`,
          "--detail-width": `${detailWidth}px`,
        } as React.CSSProperties
      }
    >
      <header className="window-bar">
        <UI.Button
          className="mobile-menu"
          variant="ghost"
          size="icon-sm"
          aria-label="Show connections"
          onClick={() => setSidebar((value) => !value)}
        >
          <MenuIcon />
        </UI.Button>
        <div className="app-wordmark">
          <span className="mark">
            <ActivityIcon size={15} />
          </span>
          Dispatch <span>Observer</span>
        </div>
        <div className="window-note">
          <ShieldCheck size={13} />
          Read-only
        </div>
      </header>
      <div
        className={`workspace ${sidebar ? "sidebar-open" : ""} ${selection ? "has-selection" : ""}`}
      >
        <aside className="sidebar" aria-label="Connections and conversations">
          <div className="rail-heading">
            <h2>Connections</h2>
            <UI.Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add connection"
              onClick={() => setDialog("new")}
            >
              <Plus />
            </UI.Button>
          </div>
          <nav className="connection-list">
            {preferences?.connections.map((item) => (
              <div
                className={`connection-item ${connectionId === item.id ? "selected" : ""}`}
                key={item.id}
              >
                <UI.Button
                  variant="ghost"
                  className="connection-button"
                  disabled={status === "connecting"}
                  onClick={() => void connect(item.id)}
                >
                  <Database size={19} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.kind === "postgres" ? "Postgres" : "SQLite"}
                      {item.transport.kind !== "direct"
                        ? ` · ${item.transport.kind.toUpperCase()}`
                        : ""}
                    </small>
                  </span>
                  <span
                    className={`connection-dot ${connectionId === item.id ? status : "idle"}`}
                  />
                </UI.Button>
                <UI.Menu>
                  <UI.MenuTrigger
                    render={
                      <UI.Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Manage ${item.name}`}
                        className="connection-settings"
                      />
                    }
                  >
                    <Settings2 />
                  </UI.MenuTrigger>
                  <UI.MenuContent>
                    <UI.MenuItem onClick={() => setDialog(item)}>
                      Edit connection
                    </UI.MenuItem>
                    <UI.MenuItem
                      onClick={() =>
                        void connect(item.id, item.id === connectionId)
                      }
                    >
                      Reconnect
                    </UI.MenuItem>
                    <UI.MenuItem
                      destructive
                      onClick={() => void removeConnection(item.id)}
                    >
                      Remove saved connection
                    </UI.MenuItem>
                  </UI.MenuContent>
                </UI.Menu>
              </div>
            ))}
          </nav>
          {connection && (
            <>
              <div className="rail-heading conversation-heading">
                <h2>Conversations</h2>
                <span>{snapshot?.conversations.length ?? "—"}</span>
              </div>
              <div className="search-field">
                <Search size={14} />
                <UI.Input
                  aria-label="Find a conversation"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setCatalogLimit(40);
                  }}
                  placeholder="Find conversation…"
                />
              </div>
              <div className="conversation-list">
                {catalog.slice(0, catalogLimit).map((item) => (
                  <UI.Button
                    key={item.id}
                    variant="ghost"
                    className={`conversation-button ${conversationId === item.id ? "selected" : ""} ${item.owner ? "child" : ""}`}
                    onClick={() => chooseConversation(item.id)}
                  >
                    <Bot size={16} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {item.owner
                          ? `Child of ${item.owner.conversationId} · `
                          : item.parent
                            ? `Fork of ${item.parent.conversationId} · `
                            : ""}
                        {item.entryCount} entries
                      </small>
                    </span>
                    {item.active > 0 && (
                      <span
                        className="small-indicator"
                        title={`${item.active} nonterminal saved tasks`}
                      />
                    )}
                  </UI.Button>
                ))}
                {catalog.length > catalogLimit && (
                  <UI.Button
                    variant="ghost"
                    onClick={() => setCatalogLimit((value) => value + 40)}
                  >
                    Show more conversations
                  </UI.Button>
                )}
                {snapshot && !catalog.length && (
                  <p className="rail-empty">
                    {query
                      ? "No matching conversations."
                      : "No conversations retained in this store."}
                  </p>
                )}
              </div>
            </>
          )}
          <div className="rail-bottom">
            <UI.Button
              variant="ghost"
              className="add-connection"
              onClick={() => setDialog("new")}
            >
              <Plus size={18} />
              Add connection
            </UI.Button>
            <div className="rail-footer">
              <span>Local to this computer</span>
              <UI.Button
                variant="ghost"
                size="icon-sm"
                aria-label="Toggle color theme"
                onClick={() => void changeTheme()}
              >
                {preferences?.theme === "dark" ? <Sun /> : <Moon />}
              </UI.Button>
            </div>
          </div>
          <PaneResizer
            label="Resize connections pane"
            value={railWidth}
            onChange={setRailWidth}
          />
        </aside>
        {sidebar && (
          <button
            className="sidebar-scrim"
            aria-label="Close connections"
            onClick={() => setSidebar(false)}
          />
        )}
        <main className="main-panel">
          {!connection ? (
            <div className="welcome">
              <div className="welcome-symbol">
                <Workflow size={36} strokeWidth={1.4} />
              </div>
              <p className="eyebrow">DISPATCH OBSERVER</p>
              <h1>
                See the work
                <br />
                behind the answer.
              </h1>
              <p>
                Follow your agents, explore their tools and subagents, and step
                through what happened.
              </p>
              <UI.Button onClick={() => setDialog("new")}>
                <Plus />
                Add your first connection
              </UI.Button>
              <div className="welcome-sources">
                <span>
                  <Database size={15} />
                  SQLite & Postgres
                </span>
                <span>
                  <Terminal size={15} />
                  SSH & AWS SSM
                </span>
              </div>
              <p className="welcome-note">
                <ShieldCheck size={14} />
                Connect to existing state. Your agents keep working.
              </p>
            </div>
          ) : (
            <>
              <header className="content-heading">
                <nav
                  className="conversation-navigation"
                  aria-label="Conversation navigation"
                >
                  <UI.Button
                    variant="ghost"
                    size="sm"
                    aria-label="Go back"
                    title="Go back (Alt+Left / ⌘[)"
                    disabled={!history.back.length || status === "connecting"}
                    onClick={() => navigateHistory("back")}
                  >
                    <ArrowLeft size={16} />
                    Back
                  </UI.Button>
                  <UI.Button
                    variant="ghost"
                    size="sm"
                    aria-label="Go forward"
                    title="Go forward (Alt+Right / ⌘])"
                    disabled={!history.forward.length || status === "connecting"}
                    onClick={() => navigateHistory("forward")}
                  >
                    <ArrowRight size={16} />
                    Forward
                  </UI.Button>
                  {selectedConversation?.owner && (
                    <UI.Button
                      variant="ghost"
                      size="sm"
                      disabled={
                        status === "connecting" ||
                        !snapshot?.conversations.some(
                          (item) =>
                            item.id === selectedConversation.owner!.conversationId,
                        )
                      }
                      onClick={() =>
                        chooseConversation(selectedConversation.owner!.conversationId)
                      }
                    >
                      <GitBranch size={16} />
                      Parent conversation
                    </UI.Button>
                  )}
                </nav>
                <div className="breadcrumb">
                  <span>{connection.name}</span>
                  <ChevronRight size={13} />
                  <span>{selectedConversation?.title ?? "Conversations"}</span>
                </div>
                <h1>{title}</h1>
                <div className="heading-meta">
                  <div>
                    <Badge
                      value={status === "connected" ? "connected" : status}
                    />
                    {selectedConversation && (
                      <span>Conversation {selectedConversation.id}</span>
                    )}
                    {connection.kind === "postgres" && (
                      <span
                        className="store-label"
                        title={connection.postgres.storeId}
                      >
                        {connection.postgres.storeId}
                      </span>
                    )}
                  </div>
                  <span>
                    {snapshot
                      ? `Observed ${time(Date.parse(snapshot.observedAt))}`
                      : "Waiting for the first snapshot"}
                  </span>
                </div>
              </header>
              {error && (
                <div className="source-error" role="alert">
                  <Unplug size={17} />
                  <div>
                    <strong>
                      {snapshot
                        ? "Connection lost · showing last saved view"
                        : "Could not connect"}
                    </strong>
                    <p>{error}</p>
                  </div>
                  <UI.Button
                    variant="outline"
                    size="sm"
                    disabled={status === "connecting"}
                    onClick={() =>
                      void connect(connection.id, Boolean(snapshot))
                    }
                  >
                    <RefreshCw />
                    Reconnect
                  </UI.Button>
                  <UI.Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDialog(connection)}
                  >
                    Edit
                  </UI.Button>
                </div>
              )}
              {status === "connecting" && (
                <div className="loading-line">
                  <UI.Spinner label="Connecting" />
                  Opening a read-only connection…
                </div>
              )}
              {snapshot && conversationId && (
                <>
                  <UI.Tabs
                    value={tab}
                    onValueChange={(value) => setTab(String(value))}
                    className="content-tabs"
                  >
                    <UI.TabsList
                      className="view-tabs"
                      aria-label="Inspection view"
                    >
                      <UI.Tab value="structure">
                        <GitBranch size={15} />
                        Structure
                      </UI.Tab>
                      <UI.Tab value="timeline">
                        <ActivityIcon size={15} />
                        Timeline
                      </UI.Tab>
                      <UI.Tab value="conversation">
                        <FileText size={15} />
                        Conversation
                      </UI.Tab>
                    </UI.TabsList>
                    <UI.TabPanel
                      value="structure"
                      className="panel-scroll structure-view"
                    >
                      <Structure
                        key={`${connectionId}:${conversationId}`}
                        snapshot={snapshot}
                        conversationId={conversationId}
                        selection={selection}
                        onSelection={setSelection}
                        onConversation={(id) =>
                          id === conversationId
                            ? setTab("conversation")
                            : chooseConversation(id)
                        }
                        onActivity={selectActivity}
                      />
                    </UI.TabPanel>
                    <UI.TabPanel
                      value="timeline"
                      className="panel-scroll"
                      ref={timelinePane}
                    >
                      <div className="activity-filters">
                        <div className="search-field">
                          <Search size={14} />
                          <UI.Input
                            aria-label="Search loaded events"
                            placeholder="Search loaded events…"
                            value={activityQuery}
                            onChange={(event) =>
                              setActivityQuery(event.target.value)
                            }
                          />
                        </div>
                        <select
                          aria-label="Event type"
                          value={category}
                          onChange={(event) => setCategory(event.target.value)}
                        >
                          <option value="all">All events</option>
                          <option value="tool">Tools</option>
                          <option value="message">Messages</option>
                          <option value="boundary">Context boundaries</option>
                          <option value="record">Other records</option>
                        </select>
                      </div>
                      {viewed?.hasEarlier && (
                        <UI.Button
                          variant="outline"
                          className="earlier-button"
                          disabled={loadingEarlier}
                          onClick={() => void loadEarlier()}
                        >
                          {loadingEarlier
                            ? "Loading…"
                            : "Load earlier saved events"}
                        </UI.Button>
                      )}
                      <div className="timeline-list">
                        {visibleActivities.map((item) => (
                          <UI.Button
                            key={item.id}
                            data-event-id={item.id}
                            variant="ghost"
                            className={`event-row ${selection?.kind === "activity" && selection.value.id === item.id ? "selected" : ""} ${item.tool?.phase === "result" && item.tool.error ? "event-error" : ""}`}
                            onClick={() => selectActivity(item)}
                          >
                            <span className="event-dot" />
                            <span className="event-time">
                              {item.at ? time(item.at) : `#${item.sequence}`}
                            </span>
                            <span className="event-icon">
                              {item.category === "tool" ? (
                                <Terminal size={17} />
                              ) : item.category === "boundary" ? (
                                <GitBranch size={17} />
                              ) : (
                                <FileText size={17} />
                              )}
                            </span>
                            <span className="event-copy">
                              <strong>
                                {item.title}
                                {item.tool ? (
                                  <span className="event-phase">
                                    {" "}
                                    ·{" "}
                                    {item.tool.phase === "call"
                                      ? "called"
                                      : "result"}
                                  </span>
                                ) : null}
                              </strong>
                              <small>{item.text.slice(0, 180)}</small>
                            </span>
                            <span className="event-conversation">
                              {item.conversationId}
                            </span>
                            {item.tool?.phase === "result" &&
                              item.tool.error && <Badge value="error" />}
                          </UI.Button>
                        ))}
                      </div>
                      {!visibleActivities.length && (
                        <p className="empty-inline">
                          {activityQuery
                            ? "No matching loaded events."
                            : "No saved events in this conversation yet."}
                        </p>
                      )}
                      <p className="evidence-note">
                        Events follow durable commit order. Timestamps appear
                        only when retained. Playback steps through the loaded
                        events.
                      </p>
                    </UI.TabPanel>
                    <UI.TabPanel
                      value="conversation"
                      className="panel-scroll transcript-view"
                      ref={transcriptPane}
                    >
                      {viewed?.hasEarlier && (
                        <UI.Button
                          variant="outline"
                          className="earlier-button"
                          disabled={loadingEarlier}
                          onClick={() => void loadEarlier()}
                        >
                          Load earlier saved entries
                        </UI.Button>
                      )}
                      <p className="transcript-note">
                        Saved transcript, including retained reset and
                        compaction boundaries. It is not a reconstruction of the
                        exact model context.
                      </p>
                      {events.map((item) => (
                        <TranscriptEntry
                          key={`${connectionId}:${item.id}`}
                          item={item}
                          active={!following && item.id === activeEventId}
                          inspect={() => selectActivity(item)}
                        />
                      ))}
                      {!events.length && (
                        <p className="empty-inline">
                          No transcript entries retained.
                        </p>
                      )}
                    </UI.TabPanel>
                  </UI.Tabs>
                </>
              )}
              {snapshot && !conversationId && (
                <div className="empty-conversation">
                  <Database size={30} />
                  <h2>This store is readable.</h2>
                  <p>
                    Its conversations will appear here when the agent saves
                    them.
                  </p>
                </div>
              )}
            </>
          )}
        </main>
        {connection && (
          <Details
            selection={detailSelection}
            historical={!following}
            close={() => setSelection(undefined)}
            controls={
              <>
                <UI.Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous event in details"
                  disabled={at <= 0}
                  onClick={() => step(-1)}
                >
                  <ArrowLeft />
                </UI.Button>
                <UI.Button
                  variant="secondary"
                  size="icon"
                  aria-label={
                    playing
                      ? "Pause playback in details"
                      : "Play events in details"
                  }
                  onClick={togglePlayback}
                >
                  {playing ? <Pause /> : <Play />}
                </UI.Button>
                <UI.Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next event in details"
                  disabled={at >= events.length - 1}
                  onClick={() => step(1)}
                >
                  <ArrowRight />
                </UI.Button>
                <span>
                  {at + 1} / {events.length}
                </span>
                <UI.Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    goLive();
                    setSelection(undefined);
                  }}
                >
                  Live
                </UI.Button>
              </>
            }
            resizer={
              <PaneResizer
                label="Resize details pane"
                value={detailWidth}
                onChange={setDetailWidth}
                reverse
              />
            }
          />
        )}
      </div>
      <footer className="playback-bar" aria-label="Recorded event playback">
        <div className="playback-controls">
          <UI.Button
            variant="secondary"
            size="icon"
            aria-label={
              following
                ? "Pause following"
                : playing
                  ? "Pause playback"
                  : "Play saved events"
            }
            disabled={!events.length}
            onClick={togglePlayback}
          >
            {following || playing ? <Pause size={17} /> : <Play size={17} />}
          </UI.Button>
          <div className="playback-mode">
            <strong>
              <span className={`mode-dot ${following ? "live" : ""}`} />
              {following
                ? "Following live"
                : playing
                  ? "Playing saved events"
                  : "Recorded playback"}
            </strong>
            <small>
              {following
                ? status === "connected"
                  ? "New commits appear automatically"
                  : "Waiting for connection"
                : `${Math.max(0, at + 1)} of ${events.length} loaded events`}
            </small>
          </div>
          {!following && (
            <UI.Button variant="outline" size="sm" onClick={goLive}>
              <Radio size={13} />
              Live{newCount ? ` +${newCount}` : ""}
            </UI.Button>
          )}
        </div>
        <div className="playback-track">
          <div className="step-buttons">
            <UI.Button
              variant="ghost"
              size="icon-sm"
              disabled={!events.length}
              aria-label="First saved event"
              onClick={() => {
                if (following) pause(0);
                else setCursor(0);
                setPlaying(false);
              }}
            >
              <SkipBack />
            </UI.Button>
            <UI.Button
              variant="ghost"
              size="icon-sm"
              disabled={!events.length || at <= 0}
              aria-label="Previous saved event"
              onClick={() => step(-1)}
            >
              <ArrowLeft />
            </UI.Button>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, events.length - 1)}
            value={Math.max(0, at)}
            disabled={!events.length}
            aria-label="Playback position"
            aria-valuetext={
              events[at] ? `Event ${at + 1}: ${events[at].title}` : "No events"
            }
            onChange={(event) => {
              const position = Number(event.target.value);
              if (following) pause(position);
              else setCursor(position);
              setPlaying(false);
            }}
          />
          <div className="step-buttons">
            <UI.Button
              variant="ghost"
              size="icon-sm"
              disabled={!events.length || at >= events.length - 1}
              aria-label="Next saved event"
              onClick={() => step(1)}
            >
              <ArrowRight />
            </UI.Button>
            <UI.Button
              variant="ghost"
              size="icon-sm"
              disabled={!events.length}
              aria-label="Last saved event"
              onClick={() => {
                if (following) pause();
                else setCursor(events.length - 1);
                setPlaying(false);
              }}
            >
              <SkipForward />
            </UI.Button>
          </div>
          <select
            aria-label="Playback speed"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            <option value={0.5}>0.5×</option>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
          </select>
        </div>
        <span className="playback-caption">
          {events[at]?.at
            ? time(events[at].at)
            : snapshot
              ? `Commit ${snapshot.sequence}`
              : "Retained evidence only"}
        </span>
      </footer>
      {dialog && preferences && (
        <ConnectionDialog
          key={dialog === "new" ? "new" : dialog.id}
          existing={dialog === "new" ? undefined : dialog}
          preferences={preferences}
          onClose={() => setDialog(undefined)}
          onSaved={async (id) => {
            await refreshPreferences();
            setDialog(undefined);
            await connect(id);
          }}
        />
      )}
    </div>
  );
}
