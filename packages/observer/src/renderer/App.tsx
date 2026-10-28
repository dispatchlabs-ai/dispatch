import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  ArrowRight,
  Bot,
  Database,
  FileText,
  GitBranch,
  Menu as MenuIcon,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Terminal,
  Unplug,
  Workflow,
} from "lucide-react";
import { UI } from "./controls";
import { ConnectionDialog } from "./ConnectionDialog";
import { SettingsDialog } from "./SettingsDialog";
import { ConversationContext } from "./ConversationContext";
import { Structure } from "./Structure";
import { PaneResizer } from "./PaneResizer";
import { MessageContent } from "./Content";
import { recordedTime, reportedResult } from "../shared/workSummary";
import { Transcript } from "./Transcript";
import { LocalWork } from "./LocalWork";
import { WorkflowView } from "./WorkflowView";
import {
  WorkflowJourney,
  WorkflowNodeContext,
  emptyJourney,
  type JourneyView,
} from "./WorkflowJourney";
import { useLocalWork } from "./useLocalWork";
import {
  memberKey,
  sourceKey,
  readableName,
  workflowRuns,
  workflowSender,
  type WorkflowMember,
  type WorkflowNode,
  type WorkflowRun,
} from "../shared/workflows";
import { reconcileActivities } from "../shared/activities";
import {
  Badge,
  Details,
  time,
  type EvidenceView,
  type Selection,
} from "./Details";
import type {
  Activity,
  Connection,
  LocalWork as WorkCatalog,
  Preferences,
  SavedConnection,
  Snapshot,
} from "../shared/contracts";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const startsEarlier = (left: Snapshot, right: Snapshot) =>
  (left.earliestSequence ?? Infinity) <
    (right.earliestSequence ?? Infinity) ||
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
  followTail: boolean;
  frozen?: Snapshot;
  cursor: number;
  tab: string;
  selection?: Selection;
  activityQuery: string;
  category: string;
  workflowId?: string;
  workflowNode?: string;
};

export function App() {
  const [home, setHome] = useState<"local" | "source" | false>("local");
  const [workflowOverview, setWorkflowOverview] = useState(false);
  const [workflowId, setWorkflowId] = useState<string>();
  const local = useLocalWork(true);
  const [journeys, setJourneys] = useState<Record<string, JourneyView>>({});
  const [workflowTrail, setWorkflowTrail] = useState<string[]>([]);
  const [evidenceRequest, setEvidenceRequest] =
    useState<WorkflowNode["evidence"][number]>();
  const [evidenceView, setEvidenceView] = useState<EvidenceView>();
  const [railWidth, setRailWidth] = useState(230);
  const [journeyWidth, setJourneyWidth] = useState(320);
  const [detailWidth, setDetailWidth] = useState(344);
  const [preferences, setPreferences] = useState<Preferences>();
  const [connectionId, setConnectionId] = useState<string>();
  const [status, setStatus] = useState<
    "idle" | "connecting" | "connected" | "disconnected"
  >("idle");
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [sourceCatalog, setSourceCatalog] = useState<Snapshot>();
  const current = useRef<Snapshot | undefined>(undefined);
  const [conversationId, setConversationId] = useState<number>();
  const [history, setHistory] = useState<{
    back: ConversationView[];
    forward: ConversationView[];
  }>({ back: [], forward: [] });
  const [following, setFollowing] = useState(true);
  const [followTail, setFollowTail] = useState(false);
  const [frozen, setFrozen] = useState<Snapshot>();
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState("conversation");
  const [selection, setSelection] = useState<Selection>();
  const restoringView = useRef(false);
  const [query, setQuery] = useState("");
  const [activityQuery, setActivityQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [dialog, setDialog] = useState<SavedConnection | "new">();
  const [responseOpen, setResponseOpen] = useState(false);
  const [settings, setSettings] = useState(false);
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
  const stores = useMemo(() => {
    const loaded = local.data?.stores ?? [];
    if (
      !connection ||
      sourceCatalog?.sourceId !== connection.id ||
      loaded.some(
        (store) => sourceKey(store.connection) === sourceKey(connection),
      )
    )
      return loaded;
    return [
      ...loaded,
      {
        connection,
        scope: sourceKey(connection),
        pids: [],
        conversations: sourceCatalog.conversations,
        documents: sourceCatalog.documents,
        handoffs: sourceCatalog.handoffs,
      },
    ];
  }, [local.data, connection, sourceCatalog]);
  const runs = useMemo(() => workflowRuns(stores), [stores]);
  const sourceData: WorkCatalog | undefined =
    sourceCatalog && connection
      ? {
          observedAt: sourceCatalog.observedAt,
          issues: [],
          stores: stores.filter(
            (store) => sourceKey(store.connection) === sourceKey(connection),
          ),
        }
      : undefined;
  const catalogData = home === "source" ? sourceData : local.data;
  const catalogSources = new Set(
    catalogData?.stores.map((store) => sourceKey(store.connection)),
  );
  const catalogRuns = runs.filter(
    (run) =>
      (run.document &&
        catalogSources.has(sourceKey(run.document.connection))) ||
      run.members.some((member) =>
        catalogSources.has(sourceKey(member.connection)),
      ),
  );
  const viewed = following ? snapshot : frozen;
  const events = viewed?.activities ?? [];
  const at = following
    ? events.length - 1
    : Math.min(cursor, events.length - 1);
  const selectedConversation = snapshot?.conversations.find(
    (item) => item.id === conversationId,
  );
  const containingRuns = runs.filter(
    (run) =>
      connection &&
      run.members.some(
        (m) =>
          memberKey(m.connection, m.conversation.id) ===
          memberKey(connection, conversationId ?? 0),
      ),
  );
  const currentWorkflow = workflowOverview
    ? runs.find((run) => run.id === workflowId)
    : (containingRuns.find((run) => run.id === workflowId) ??
      (!workflowId && containingRuns.length === 1
        ? containingRuns[0]
        : undefined));
  const currentMember = currentWorkflow?.members.find(
    (m) =>
      connection &&
      memberKey(m.connection, m.conversation.id) ===
        memberKey(connection, conversationId ?? 0),
  );
  const journey = currentWorkflow
    ? (journeys[currentWorkflow.id] ?? emptyJourney)
    : emptyJourney;
  const currentNode = currentWorkflow?.nodes.find(
    (n) =>
      n.id === journey.selected &&
      (workflowOverview ||
        n.evidence.some(
          (e) =>
            e.member &&
            connection &&
            memberKey(e.member.connection, e.conversationId) ===
              memberKey(connection, conversationId ?? 0),
        )),
  );
  const changeJourney = (view: JourneyView) => {
    if (currentWorkflow)
      setJourneys((all) => ({ ...all, [currentWorkflow.id]: view }));
  };
  const handoffSender =
    currentWorkflow && currentMember
      ? workflowSender(currentWorkflow, currentMember)
      : undefined;
  useEffect(() => setResponseOpen(false), [connectionId, conversationId]);
  const activeEventId = events[at]?.id;
  useEffect(() => {
    const pane =
      tab === "timeline"
        ? timelinePane.current
        : tab === "conversation"
          ? transcriptPane.current
          : null;
    if (following && followTail) pane?.scrollTo({ top: pane.scrollHeight });
    else if (activeEventId && !following)
      pane
        ?.querySelector<HTMLElement>(`[data-event-id="${activeEventId}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeEventId, following, followTail, tab, home, workflowOverview]);

  const refreshPreferences = useCallback(async () => {
    const value = await window.observer.preferences();
    if (mounted.current) setPreferences(value);
    return value;
  }, []);
  const connect = useCallback(
    async (id: string, preserve = false, requestedConversation?: number) => {
      setHome(false);
      setWorkflowOverview(false);
      setSettings(false);
      setDialog(undefined);
      preserve = preserve && current.current?.sourceId === id;
      const turn = ++generation.current;
      setStatus("connecting");
      setError("");
      setConnectionId(id);
      setSidebar(false);
      if (!preserve) {
        setSourceCatalog(undefined);
        setTab("conversation");
        setHistory({ back: [], forward: [] });
        current.current = undefined;
        setSnapshot(undefined);
        setConversationId(undefined);
        setFrozen(undefined);
        setFollowing(true);
        setFollowTail(false);
        setPlaying(false);
        setSelection(undefined);
        setCursor(0);
      }
      try {
        await window.observer.connect(id);
        const catalog = await window.observer.read({ limit: 500 });
        if (turn !== generation.current || !mounted.current) return;
        setStatus("connected");
        setSourceCatalog(catalog);
        if (!preserve) {
          current.current = catalog;
          setSnapshot(catalog);
          setConversationId(
            catalog.conversations.find(
              (item) => item.id === requestedConversation,
            )?.id ??
              catalog.conversations.find(
                (item) => item.active > 0 && !item.owner,
              )?.id ??
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
    void refreshPreferences().catch((error) => setError(errorMessage(error)));
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
    if (home === "local" || status !== "connected" || !connectionId) return;
    const catalogueOnly = Boolean(home || workflowOverview);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        let next = await window.observer.read({
          conversationId: catalogueOnly ? undefined : conversationId,
          limit: 500,
        });
        if (cancelled) return;
        setSourceCatalog(next);
        if (catalogueOnly) {
          setError("");
          timer = setTimeout(() => void refresh(), 1800);
          return;
        }
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
  }, [
    home,
    workflowOverview,
    connectionId,
    conversationId,
    status,
    pollRevision,
  ]);
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
    if (!following && events[at]) {
      setSelection({ kind: "activity", value: events[at] });
    }
  }, [at, following, viewed]);

  const captureView = (): ConversationView | undefined =>
    conversationId === undefined
      ? undefined
      : {
          conversationId,
          snapshot,
          following,
          followTail,
          frozen,
          cursor,
          tab,
          selection,
          activityQuery,
          category,
          workflowId,
          workflowNode: journey.selected,
        };
  const openConversation = (id: number, view?: ConversationView) => {
    setEvidenceView(undefined);
    if (view) {
      setWorkflowId(view.workflowId);
      if (view.workflowId)
        setJourneys((all) => ({
          ...all,
          [view.workflowId!]: {
            ...(all[view.workflowId!] ?? emptyJourney),
            selected: view.workflowNode,
          },
        }));
    }
    ++generation.current;
    restoringView.current = Boolean(view);
    current.current =
      view?.snapshot ??
      (snapshot
        ? {
            ...snapshot,
            conversationId: undefined,
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
    setFollowTail(view?.followTail ?? false);
    setPlaying(false);
    setFrozen(view?.frozen);
    setCursor(view?.cursor ?? 0);
    setTab(view?.tab ?? "conversation");
    setSelection(view?.selection);
    setActivityQuery(view?.activityQuery ?? "");
    setCategory(view?.category ?? "all");
    setSidebar(false);
  };
  const chooseConversation = (id: number) => {
    setEvidenceRequest(undefined);
    setEvidenceView(undefined);
    setHome(false);
    setWorkflowOverview(false);
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
    setEvidenceRequest(undefined);
    setHome(false);
    setWorkflowOverview(false);
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
    setEvidenceRequest(undefined);
    setEvidenceView(undefined);
    if (snapshot) {
      setFrozen(snapshot);
      setFollowing(false);
      setCursor(index ?? Math.max(0, snapshot.activities.length - 1));
    }
    setPlaying(false);
  };
  const goLive = () => {
    setEvidenceRequest(undefined);
    setEvidenceView(undefined);
    setFollowing(true);
    setFollowTail(true);
    setPlaying(false);
    setFrozen(undefined);
  };
  const togglePlayback = () => {
    setEvidenceRequest(undefined);
    setEvidenceView(undefined);
    if (following) pause();
    else {
      if (cursor >= events.length - 1) setCursor(0);
      setPlaying((value) => !value);
    }
  };
  const selectActivity = (activity: Activity) => {
    setEvidenceRequest(undefined);
    setEvidenceView(undefined);
    const index = events.findIndex((item) => item.id === activity.id);
    if (following || index < 0)
      pause(
        snapshot?.activities.findIndex((item) => item.id === activity.id),
      );
    else setCursor(index);
    setSelection({ kind: "activity", value: activity });
  };
  const seek = (position: number) => {
    setEvidenceRequest(undefined);
    setEvidenceView(undefined);
    if (following) pause(position);
    else setCursor(position);
    setPlaying(false);
  };
  const step = (direction: number) =>
    seek(Math.max(0, Math.min(events.length - 1, at + direction)));
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
    await window.observer.remove(id);
    if (connectionId === id) {
      ++generation.current;
      setConnectionId(undefined);
      setConversationId(undefined);
      setHistory({ back: [], forward: [] });
      setStatus("idle");
      setSnapshot(undefined);
      current.current = undefined;
      setSelection(undefined);
      setFrozen(undefined);
      setFollowing(true);
      setFollowTail(false);
      setPlaying(false);
      setError("");
      setSourceCatalog(undefined);
      setHome("local");
      setWorkflowOverview(false);
    }
    await refreshPreferences();
  };
  const changeTheme = async (theme: Preferences["theme"]) => {
    await window.observer.theme(theme);
    await refreshPreferences();
  };
  const openSettings = () => {
    setDialog(undefined);
    setSettings(true);
    setPlaying(false);
    setSidebar(false);
  };
  const closeSettings = () => {
    setSettings(false);
    setDialog(undefined);
  };
  const openSaved = (id: string) => {
    setEvidenceRequest(undefined);
    setEvidenceView(undefined);
    if (id === connectionId && status === "connected") {
      setHome(false);
      setWorkflowOverview(false);
      closeSettings();
    } else {
      if (id !== connectionId) {
        setWorkflowId(undefined);
        setWorkflowTrail([]);
      }
      void connect(id, id === connectionId);
    }
  };
  const openLocal = async (candidate: Connection, id?: number) => {
    const existing = preferences?.connections.find(
      (item) => sourceKey(item) === sourceKey(candidate),
    );
    const saved =
      existing ??
      (await window.observer.save({
        connection: candidate,
        rememberSecret: false,
      }));
    await refreshPreferences();
    await connect(saved.id, false, id);
  };
  const openWorkflow = (run: WorkflowRun) => {
    setEvidenceRequest(undefined);
    setEvidenceView(undefined);
    setWorkflowId(run.id);
    setWorkflowOverview(true);
    setHome(false);
    setPlaying(false);
    setSelection(undefined);
  };
  const openMember = (member: WorkflowMember) => {
    if (currentWorkflow) setWorkflowId(currentWorkflow.id);
    if (
      connection &&
      sourceKey(connection) === sourceKey(member.connection) &&
      status === "connected"
    ) {
      chooseConversation(member.conversation.id);
    } else {
      void openLocal(member.connection, member.conversation.id).catch(
        (error) => setError(errorMessage(error)),
      );
    }
  };
  const openLinkedWorkflow = (id: string) => {
    const linked = runs.find((run) => run.id === id);
    if (linked) {
      if (currentWorkflow)
        setWorkflowTrail((trail) => [...trail, currentWorkflow.id]);
      openWorkflow(linked);
    }
  };
  const openWorkflowEvidence = (
    evidence: WorkflowNode["evidence"][number],
  ) => {
    if (!evidence.member) return;
    setEvidenceView(undefined);
    setPlaying(false);
    setFollowTail(false);
    openMember(evidence.member);
    setEvidenceRequest(evidence);
  };
  const selectWorkflowNode = (node: WorkflowNode) => {
    const evidence = node.evidence.find((item) => item.member);
    if (
      node.id !== journey.selected &&
      evidence?.member &&
      connection &&
      memberKey(connection, conversationId ?? 0) ===
        memberKey(evidence.member.connection, evidence.conversationId)
    ) {
      const previous = captureView();
      if (previous)
        setHistory((value) => ({
          back: [...value.back, previous],
          forward: [],
        }));
    }
    changeJourney({ ...journey, selected: node.id });
    if (node.type === "activity" && evidence) openWorkflowEvidence(evidence);
    else {
      setEvidenceRequest(undefined);
      setEvidenceView(undefined);
      setWorkflowOverview(true);
      setPlaying(false);
      setSelection(undefined);
    }
  };
  useEffect(() => {
    if (
      home ||
      workflowOverview ||
      evidenceRequest?.entryId === undefined ||
      !evidenceRequest.member ||
      status !== "connected" ||
      !connection ||
      memberKey(connection, conversationId ?? 0) !==
        memberKey(
          evidenceRequest.member.connection,
          evidenceRequest.conversationId,
        )
    )
      return;
    const ref = evidenceRequest;
    let cancelled = false;
    const title = ref.label ?? `Saved entry ${ref.entryId}`;
    setEvidenceView({ title });
    void window.observer
      .read({
        conversationId: ref.conversationId,
        entryId: ref.entryId,
        limit: 1,
      })
      .then((value) => {
        if (!cancelled) setEvidenceView({ title, snapshot: value });
      })
      .catch((error) => {
        if (!cancelled)
          setEvidenceView({ title, error: errorMessage(error) });
      })
      .finally(() => {
        if (!cancelled) setEvidenceRequest(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [
    evidenceRequest,
    status,
    connection,
    conversationId,
    home,
    workflowOverview,
  ]);
  useEffect(() => {
    if (
      home ||
      workflowOverview ||
      !evidenceRequest?.member ||
      evidenceRequest.entryId !== undefined ||
      status !== "connected" ||
      !connection ||
      memberKey(connection, conversationId ?? 0) !==
        memberKey(
          evidenceRequest.member.connection,
          evidenceRequest.conversationId,
        )
    )
      return;
    const ref = evidenceRequest;
    if (snapshot?.conversationId !== ref.conversationId) return;
    if (ref.taskId !== undefined) {
      const task = snapshot.tasks.find(
        (t) => t.id === ref.taskId && t.conversationId === ref.conversationId,
      );
      if (task) setSelection({ kind: "task", value: task });
      else
        setEvidenceView({
          title: "Task unavailable",
          error: "This task is not retained in the referenced conversation.",
        });
    } else if (ref.documentId !== undefined) {
      const doc = snapshot.documents.find((d) => {
        const scope = d.scope as {
          kind: string;
          conversationId?: number;
          taskId?: number;
        };
        return (
          d.id === ref.documentId &&
          (scope.kind === "session" ||
            (scope.kind === "conversation" &&
              scope.conversationId === ref.conversationId) ||
            (scope.kind === "task" &&
              snapshot.tasks.some(
                (t) =>
                  t.id === scope.taskId &&
                  t.conversationId === ref.conversationId,
              )))
        );
      });
      if (doc) setSelection({ kind: "document", value: doc });
      else
        setEvidenceView({
          title: "Document unavailable",
          error:
            "This document is not readable in the referenced conversation scope.",
        });
    }
    setEvidenceRequest(undefined);
  }, [
    evidenceRequest,
    status,
    connection,
    conversationId,
    snapshot,
    home,
    workflowOverview,
  ]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        settings ||
        event.defaultPrevented ||
        (event.target as HTMLElement).closest('[role="dialog"]')
      )
        return;
      if (event.key === "Escape") {
        setEvidenceRequest(undefined);
        setEvidenceView(undefined);
        setSelection(undefined);
        setSidebar(false);
        return;
      }
      if (home || workflowOverview) return;
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
          "input,textarea,select,button,summary,pre,.table-scroll,.evidence-panel,[contenteditable=true],[role=separator],[role=tab],[role=dialog]",
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
  const title = selectedConversation?.title ?? "Choose a conversation";
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
          "--rail-width": `${!home && currentWorkflow ? journeyWidth : railWidth}px`,
          "--detail-width": `${detailWidth}px`,
        } as React.CSSProperties
      }
    >
      <header className="window-bar">
        <UI.Button
          className="mobile-menu"
          variant="ghost"
          size="icon-sm"
          aria-label="Show navigation"
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
        className={`workspace ${sidebar ? "sidebar-open" : ""} ${!home && !workflowOverview && (selection || evidenceView) ? "has-selection" : ""}`}
      >
        <aside className="sidebar" aria-label="Work navigation">
          <UI.Button
            variant={home === "local" ? "secondary" : "ghost"}
            className="machine-button"
            onClick={() => {
              setEvidenceRequest(undefined);
              setEvidenceView(undefined);
              setWorkflowTrail([]);
              setHome("local");
              setWorkflowOverview(false);
              setPlaying(false);
              setSidebar(false);
            }}
          >
            <Workflow size={18} />
            This machine
          </UI.Button>
          {connection && (
            <UI.Button
              variant={home === "source" ? "secondary" : "ghost"}
              className="machine-button"
              onClick={() => {
                setEvidenceRequest(undefined);
                setEvidenceView(undefined);
                setWorkflowTrail([]);
                setHome("source");
                setWorkflowOverview(false);
                setPlaying(false);
              }}
            >
              <Database size={18} />
              This source
            </UI.Button>
          )}
          {!home && currentWorkflow ? (
            <>
              <div className="rail-heading conversation-heading">
                <h2>Workflow</h2>
              </div>
              <UI.Button
                variant={workflowOverview ? "secondary" : "ghost"}
                className="workflow-overview-button"
                onClick={() => openWorkflow(currentWorkflow)}
              >
                <Workflow size={16} />
                <span className="agent-name">
                  {readableName(currentWorkflow.name)}
                </span>
              </UI.Button>
              {workflowTrail.length > 0 && (
                <UI.Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const previous = runs.find(
                      (r) => r.id === workflowTrail.at(-1),
                    );
                    setWorkflowTrail((trail) => trail.slice(0, -1));
                    if (previous) openWorkflow(previous);
                  }}
                >
                  <ArrowLeft size={14} />
                  Previous workflow
                </UI.Button>
              )}
              <WorkflowJourney
                run={currentWorkflow}
                view={{ ...journey, selected: currentNode?.id }}
                change={changeJourney}
                select={selectWorkflowNode}
              />
            </>
          ) : (
            !home &&
            !workflowOverview &&
            connection && (
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
            )
          )}
          <div className="rail-bottom">
            <UI.Button
              variant="ghost"
              className="settings-button"
              onClick={() => openSettings()}
            >
              <Settings2 size={18} />
              Settings
            </UI.Button>
          </div>
          <PaneResizer
            label="Resize navigation pane"
            value={!home && currentWorkflow ? journeyWidth : railWidth}
            onChange={
              !home && currentWorkflow ? setJourneyWidth : setRailWidth
            }
          />
        </aside>
        {sidebar && (
          <button
            className="sidebar-scrim"
            aria-label="Close navigation"
            onClick={() => setSidebar(false)}
          />
        )}
        <main className="main-panel">
          {home ? (
            <LocalWork
              data={catalogData}
              error={home === "source" ? error : local.error}
              loading={
                home === "source" ? status === "connecting" : local.loading
              }
              refresh={
                home === "source"
                  ? () => {
                      if (status === "connected")
                        setPollRevision((value) => value + 1);
                      else void connect(connection!.id, true);
                    }
                  : local.refresh
              }
              sourceName={home === "source" ? connection?.name : undefined}
              runs={catalogRuns}
              openWorkflow={(run) => {
                setWorkflowTrail([]);
                openWorkflow(run);
              }}
              open={openLocal}
              settings={() => openSettings()}
            />
          ) : workflowOverview ? (
            currentWorkflow ? (
              <WorkflowView
                run={currentWorkflow}
                node={currentNode}
                select={selectWorkflowNode}
                openEvidence={openWorkflowEvidence}
                openWorkflow={openLinkedWorkflow}
                settings={openSettings}
                back={() => {
                  setHome("local");
                  setWorkflowOverview(false);
                }}
                error={error || local.error}
              />
            ) : (
              <div className="empty-inline">
                <h2>
                  This workflow is not available in the current local sources.
                </h2>
                <UI.Button
                  onClick={() => {
                    setHome("local");
                    setWorkflowOverview(false);
                  }}
                >
                  This machine
                </UI.Button>
              </div>
            )
          ) : !connection ? (
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
                Follow your agents, explore their tools and subagents, and
                step through what happened.
              </p>
              <UI.Button onClick={() => openSettings()}>
                <Settings2 />
                Open settings
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
                  {currentWorkflow && (
                    <UI.Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openWorkflow(currentWorkflow)}
                    >
                      <Workflow size={16} />
                      Back to workflow
                    </UI.Button>
                  )}
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
                    disabled={
                      !history.forward.length || status === "connecting"
                    }
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
                            item.id ===
                            selectedConversation.owner!.conversationId,
                        )
                      }
                      onClick={() =>
                        chooseConversation(
                          selectedConversation.owner!.conversationId,
                        )
                      }
                    >
                      <GitBranch size={16} />
                      Parent conversation
                    </UI.Button>
                  )}
                  {selectedConversation && (
                    <UI.Button
                      variant="ghost"
                      size="sm"
                      aria-label="Show assignment context"
                      onClick={() => {
                        setTab("conversation");
                        setPlaying(false);
                        setFollowTail(false);
                        requestAnimationFrame(() => {
                          const context =
                            transcriptPane.current?.querySelector<HTMLDetailsElement>(
                              ".workflow-conversation-context",
                            );
                          if (context) context.open = true;
                          transcriptPane.current?.scrollTo({ top: 0 });
                        });
                      }}
                    >
                      <FileText size={16} />
                      Context
                    </UI.Button>
                  )}
                </nav>
                <div className="breadcrumb">
                  {currentWorkflow ? (
                    <UI.Button
                      variant="link"
                      size="sm"
                      onClick={() => openWorkflow(currentWorkflow)}
                    >
                      {readableName(currentWorkflow.name)} ·{" "}
                      {currentWorkflow.cycle}
                    </UI.Button>
                  ) : (
                    <span>{connection.name}</span>
                  )}
                </div>
                <h1>{title}</h1>
                <div className="heading-meta">
                  <div>
                    <Badge value={`Observer ${status}`} />
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
                {selectedConversation && (
                  <div
                    className="assignment-summary"
                    aria-label="Latest recorded assignment status"
                  >
                    <div>
                      <strong>Execution unknown</strong>
                      <span>
                        {selectedConversation.active} unfinished tasks · Last
                        activity {recordedTime(selectedConversation.lastAt)}
                      </span>
                    </div>
                    <div className="response-summary">
                      {selectedConversation.response &&
                        reportedResult(
                          selectedConversation.response.text,
                        ) && (
                          <strong>
                            Reported result:{" "}
                            {reportedResult(
                              selectedConversation.response.text,
                            )}
                          </strong>
                        )}
                      {selectedConversation.response ? (
                        <UI.Button
                          variant="link"
                          size="sm"
                          title={`Saved response · ${recordedTime(selectedConversation.response.at)}`}
                          onClick={() => {
                            setPlaying(false);
                            setFollowTail(false);
                            setTab("conversation");
                            const entryId =
                              selectedConversation.response!.entryId;
                            const response = events.findLast(
                              (item) =>
                                item.entryId === entryId &&
                                item.role === "assistant" &&
                                item.category === "message",
                            );
                            if (!response) setResponseOpen(true);
                            else
                              requestAnimationFrame(() =>
                                transcriptPane.current
                                  ?.querySelector<HTMLElement>(
                                    `[data-event-id="${response.id}"]`,
                                  )
                                  ?.scrollIntoView({ block: "start" }),
                              );
                          }}
                        >
                          Read latest response <ArrowRight size={14} />
                        </UI.Button>
                      ) : (
                        <span>No saved assistant response</span>
                      )}
                    </div>
                  </div>
                )}
              </header>
              {currentWorkflow && currentNode && (
                <WorkflowNodeContext
                  run={currentWorkflow}
                  node={currentNode}
                  select={selectWorkflowNode}
                  openEvidence={openWorkflowEvidence}
                  openWorkflow={openLinkedWorkflow}
                  compact
                />
              )}
              {workflowId && !runs.some((run) => run.id === workflowId) && (
                <p className="notice" role="status">
                  Workflow context is unavailable in loaded sources. The
                  conversation remains open.
                </p>
              )}
              {responseOpen && selectedConversation?.response && (
                <UI.Dialog
                  open
                  title="Latest saved assistant response"
                  onOpenChange={setResponseOpen}
                >
                  <p className="hint">
                    Latest observation · entry{" "}
                    {selectedConversation.response.entryId} ·{" "}
                    {recordedTime(selectedConversation.response.at)}. This
                    response is outside the displayed transcript or playback
                    page.
                  </p>
                  <MessageContent text={selectedConversation.response.text} />
                </UI.Dialog>
              )}
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
                    onClick={() => openSettings()}
                  >
                    Settings
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
                      <UI.Tab value="conversation">
                        <FileText size={15} />
                        Conversation
                      </UI.Tab>
                      <UI.Tab value="structure">
                        <GitBranch size={15} />
                        Structure
                      </UI.Tab>
                      <UI.Tab value="timeline">
                        <ActivityIcon size={15} />
                        Timeline
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
                        onSelection={(value) => {
                          setEvidenceRequest(undefined);
                          setEvidenceView(undefined);
                          setSelection(value);
                        }}
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
                          onChange={(event) =>
                            setCategory(event.target.value)
                          }
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
                      key={`${connectionId}:${conversationId}`}
                      value="conversation"
                      className="panel-scroll transcript-view"
                      ref={transcriptPane}
                      onScroll={(event) => {
                        const pane = event.currentTarget;
                        if (
                          followTail &&
                          pane.scrollHeight -
                            pane.scrollTop -
                            pane.clientHeight >
                            48
                        )
                          setFollowTail(false);
                      }}
                    >
                      {selectedConversation && (
                        <ConversationContext
                          conversation={selectedConversation}
                          conversations={snapshot.conversations}
                          onConversation={chooseConversation}
                          onRead={() => {
                            setPlaying(false);
                            setFollowTail(false);
                          }}
                          onSender={
                            handoffSender
                              ? () => openMember(handoffSender)
                              : undefined
                          }
                          inWorkflow={Boolean(currentWorkflow)}
                          compact
                        />
                      )}
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
                        Saved transcript · not the exact model context.
                      </p>
                      <Transcript
                        events={events}
                        conversations={snapshot.conversations}
                        activeId={!following ? activeEventId : undefined}
                        inspect={selectActivity}
                        onRead={() => {
                          setFollowTail(false);
                          setPlaying(false);
                        }}
                      />
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
        {!home &&
          !workflowOverview &&
          connection &&
          (selection || evidenceView) && (
            <Details
              selection={detailSelection}
              evidence={evidenceView}
              historical={!following}
              close={() => {
                setEvidenceRequest(undefined);
                setEvidenceView(undefined);
                setSelection(undefined);
              }}
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
      {!home && !workflowOverview && (
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
              {following || playing ? (
                <Pause size={17} />
              ) : (
                <Play size={17} />
              )}
            </UI.Button>
            <div className="playback-mode">
              <strong>
                <span className={`mode-dot ${following ? "live" : ""}`} />
                {following
                  ? followTail
                    ? "Following latest activity"
                    : "Live updates"
                  : playing
                    ? "Playing saved events"
                    : "Recorded playback"}
              </strong>
              <small>
                {following
                  ? status === "connected"
                    ? followTail
                      ? "New activity appears automatically"
                      : "Scroll stays where you leave it"
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
          {following && !followTail && (
            <UI.Button variant="outline" size="sm" onClick={goLive}>
              Latest activity <ArrowRight size={13} />
            </UI.Button>
          )}
          <div className="playback-track">
            <div className="step-buttons">
              <UI.Button
                variant="ghost"
                size="icon-sm"
                disabled={!events.length}
                aria-label="First saved event"
                onClick={() => seek(0)}
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
                events[at]
                  ? `Event ${at + 1}: ${events[at].title}`
                  : "No events"
              }
              onChange={(event) => seek(Number(event.target.value))}
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
                onClick={() => seek(events.length - 1)}
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
      )}
      {settings && (
        <SettingsDialog
          preferences={preferences}
          loadError={!preferences ? error : undefined}
          connectionId={connectionId}
          status={status}
          onClose={closeSettings}
          onAdd={() => setDialog("new")}
          onEdit={setDialog}
          onOpen={openSaved}
          onReconnect={(id) => void connect(id, id === connectionId)}
          onRemove={removeConnection}
          onTheme={changeTheme}
        >
          {dialog && preferences && (
            <ConnectionDialog
              key={dialog === "new" ? "new" : dialog.id}
              existing={dialog === "new" ? undefined : dialog}
              preferences={preferences}
              onClose={() => setDialog(undefined)}
              onSaved={async (id) => {
                setEvidenceRequest(undefined);
                setEvidenceView(undefined);
                setWorkflowId(undefined);
                await refreshPreferences();
                await connect(id);
              }}
            />
          )}
        </SettingsDialog>
      )}
    </div>
  );
}
