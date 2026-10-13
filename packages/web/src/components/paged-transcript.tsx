import type { ActivityPage } from "../shared/activity-page";
import { ToolActivityView } from "./tool-activity";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Markdown } from "./markdown";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatSnapshot, ConversationMessage, ParticipantActivity, TranscriptPage } from "../shared/contracts";
import { useSession } from "../lib/session";
import { ApiError, errorMessage } from "../lib/api";
import { PublicActivity, PublicMessage } from "./shared-conversation";
import { Button, Notice, Spinner } from "./ui";

type Item = { id: string; at: number; message?: ConversationMessage; activity?: ParticipantActivity };
function items(page: Pick<TranscriptPage, "messages" | "activities">): Item[] {
  return [...page.messages.map(message => ({ id: `m:${message.id}`, at: message.createdAt, message })), ...page.activities.filter(activity => activity.detail?.count !== 0).map(activity => ({ id: `a:${activity.id}`, at: activity.createdAt, activity }))];
}
function merge(before: Item[], incoming: Item[]) {
  // Empty live-only groups are status, not retained history. Keep loaded nonempty pages.
  const map = new Map(before.filter(item => item.activity?.detail?.count !== 0).map(item => [item.id, item]));
  for (const item of incoming) {
    const old = map.get(item.id);
    map.set(item.id, old && JSON.stringify(old) === JSON.stringify(item) ? old : item);
  }
  const aliases = new Set([...map.values()].flatMap(item => item.message?.aliases?.map(id => `m:${id}`) ?? []));
  return [...map.values()].filter(item => !aliases.has(item.id)).sort((a, b) => a.at - b.at || Number(Boolean(a.activity)) - Number(Boolean(b.activity)) || ((a.message?.timelineOrder ?? a.activity?.timelineOrder ?? 0) - (b.message?.timelineOrder ?? b.activity?.timelineOrder ?? 0)));
}

export const PagedTranscript = memo(function PagedTranscript({ snapshot, threadId = null, activeThreadId = null, onThread }: { snapshot: ChatSnapshot; threadId?: string | null; activeThreadId?: string | null; onThread?: (id: string) => void }) {
  return <Timeline key={`${snapshot.conversation.id}:${threadId ?? "main"}:${snapshot.history?.generation ?? ""}`} snapshot={snapshot} threadId={threadId} activeThreadId={activeThreadId} onThread={onThread} />;
});

function Timeline({ snapshot, threadId, activeThreadId, onThread }: { snapshot: ChatSnapshot; threadId: string | null; activeThreadId: string | null; onThread?: (id: string) => void }) {
  const { api } = useSession();
  const host = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const following = useRef(true);
  const [rows, setRows] = useState<Item[]>(() => threadId ? [] : items(snapshot));
  const [cursor, setCursor] = useState<string | null>(threadId ? null : snapshot.history?.before ?? null);
  const [root, setRoot] = useState<ConversationMessage>();
  const [replyCount, setReplyCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const refreshInFlight = useRef(false);
  const refreshController = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const loadedRevision = useRef(-1);
  const [expired, setExpired] = useState(false);
  const alive = useRef(true);
  const revision = useRef(snapshot.conversation.revision);
  revision.current = snapshot.conversation.revision;
  const getScrollElement = useCallback(() => host.current?.closest<HTMLElement>(".transcript, .thread-transcript") ?? null, []);
  const anchor = useRef<{ id: string; offset: number; top: number } | undefined>(undefined);
  const resizeCorrection = useRef({ frame: 0, delta: 0 });
  const clearResizeCorrection = useCallback(() => {
    cancelAnimationFrame(resizeCorrection.current.frame);
    resizeCorrection.current = { frame: 0, delta: 0 };
  }, []);
  useEffect(() => clearResizeCorrection, [clearResizeCorrection]);
  const queueResizeCorrection = useCallback((delta: number) => {
    if (anchor.current) return;
    const correction = resizeCorrection.current;
    correction.delta += delta;
    if (!correction.frame) {
      // Wait for the virtual list to commit, so the old scroll range cannot clamp correction.
      correction.frame = requestAnimationFrame(() => {
        const scroll = getScrollElement();
        if (scroll) {
          if (following.current) scroll.scrollTop = scroll.scrollHeight;
          else scroll.scrollTop += correction.delta;
        }
        resizeCorrection.current = { frame: 0, delta: 0 };
      });
    }
  }, [getScrollElement]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement, scrollMargin, estimateSize: () => 160, overscan: 4, getItemKey: index => rows[index]!.id });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    if (following.current || item.start < (instance.scrollOffset ?? 0)) queueResizeCorrection(delta);
    return false;
  };
  const base = `/api/chats/${encodeURIComponent(snapshot.conversation.id)}`;
  const query = threadId ? `threadId=${encodeURIComponent(threadId)}&` : "";
  // A bounded live page may skip past the retained tail after a reconnect.
  // Walk back to that tail before joining the pages, never hide the interval.
  const bridge = useCallback(async (page: Pick<TranscriptPage, "messages" | "activities" | "before" | "generation">, retained: Item[], signal?: AbortSignal) => {
    let incoming = merge([], items(page));
    if (!retained.length) return incoming;
    const tail = retained.at(-1)!;
    let next = page.before;
    while (next && !incoming.some(item => item.id === tail.id || item.message?.aliases?.includes(tail.id.slice(2))) && (incoming[0]?.at ?? Infinity) >= tail.at) {
      const older = await api<TranscriptPage>(`${base}/history?${query}before=${encodeURIComponent(next)}`, undefined, signal);
      if (older.generation !== page.generation) throw new Error("History changed. Reopen this chat.");
      incoming = merge(items(older), incoming);
      next = older.before;
    }
    return incoming;
  }, [api, base, query]);
  const load = useCallback(async (before?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestedRevision = revision.current;
    setLoading(true); setError(undefined);
    const scroll = getScrollElement();
    const first = virtualizer.getVirtualItems().find(item => item.end > (scroll?.scrollTop ?? 0));
    if (before && first && scroll) {
      const row = list.current?.querySelector<HTMLElement>(`[data-index="${first.index}"]`);
      const content = row?.querySelector<HTMLElement>(".conversation-entry") ?? row;
      if (content) anchor.current = { id: String(first.key), offset: scroll.scrollTop - first.start, top: content.getBoundingClientRect().top };
    }
    try {
      const page = await api<TranscriptPage>(`${base}/history?${query}${before ? `before=${encodeURIComponent(before)}` : ""}`);
      const incoming = before ? items(page) : await bridge(page, rowsRef.current);
      if (!alive.current) return;
      if (page.generation !== (snapshot.history?.generation ?? page.generation)) return;
      loadedRevision.current = page.revision ?? requestedRevision;
      setRows(old => before ? merge(incoming, old) : merge(old, incoming));
      if (before || !rowsRef.current.length) setCursor(page.before);
      if (page.root) { setRoot(page.root); setReplyCount(page.replyCount ?? 0); }
    } catch (error) { if (alive.current) { setError(errorMessage(error)); setExpired(error instanceof ApiError && error.code === "HISTORY_CHANGED"); } }
    finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, [api, base, query, getScrollElement, virtualizer, snapshot.history?.generation, bridge]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const controller = new AbortController();
    refreshController.current = controller;
    setRefreshError(undefined);
    let retained = rowsRef.current;
    try {
      let current: ChatSnapshot;
      do {
        current = latest.current;
        const incoming = merge([], items(current));
        const tail = retained.at(-1);
        const needsBridge = Boolean(tail && current.history?.before && !incoming.some(item => item.id === tail.id || item.message?.aliases?.includes(tail.id.slice(2))) && (incoming[0]?.at ?? Infinity) >= tail.at);
        if (!retained.length) setCursor(current.history?.before ?? null);
        if (needsBridge) setRefreshing(true);
        const connected = await bridge({ ...current, before: current.history?.before ?? null, generation: current.history?.generation ?? "" }, retained, controller.signal);
        if (controller.signal.aborted) return;
        retained = merge(retained, connected);
        setRows(old => merge(old, connected));
      } while (current !== latest.current);
    } catch (error) {
      if (!controller.signal.aborted) setRefreshError(errorMessage(error));
    } finally {
      refreshInFlight.current = false;
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }, [bridge]);
  useEffect(() => {
    if (!threadId) void refresh();
  }, [snapshot.messages, snapshot.activities, snapshot.history?.before, threadId, refresh]);
  useEffect(() => () => refreshController.current?.abort(), []);
  // Thread pages are bounded and refreshed only when the room revision changed.
  useEffect(() => {
    if (!threadId) return;
    void load();
    const timer = window.setInterval(() => { if (loadedRevision.current !== revision.current) void load(); }, 1000);
    return () => window.clearInterval(timer);
  }, [threadId, load]);
  useLayoutEffect(() => {
    const scroll = getScrollElement();
    if (!scroll || !list.current) return;
    let previousMargin: number | undefined;
    const measure = () => {
      const margin = list.current!.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      if (previousMargin !== undefined && margin !== previousMargin && (following.current || previousMargin < scroll.scrollTop)) queueResizeCorrection(margin - previousMargin);
      previousMargin = margin;
      setScrollMargin(margin);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host.current!);
    const onScroll = () => {
      if (resizeCorrection.current.frame && !anchor.current) clearResizeCorrection();
      following.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    };
    scroll.addEventListener("scroll", onScroll);
    return () => { observer.disconnect(); scroll.removeEventListener("scroll", onScroll); };
  }, [getScrollElement, queueResizeCorrection, clearResizeCorrection]);
  useLayoutEffect(() => {
    const pending = anchor.current;
    if (!pending) {
      const scroll = getScrollElement();
      if (following.current && scroll) { clearResizeCorrection(); scroll.scrollTop = scroll.scrollHeight; }
      return;
    }
    if (loading) return;
    clearResizeCorrection();
    const index = rows.findIndex(item => item.id === pending.id);
    const offset = index >= 0 ? virtualizer.getOffsetForIndex(index, "start") : undefined;
    const scroll = getScrollElement();
    if (!offset || !scroll) { anchor.current = undefined; return; }
    scroll.scrollTop = offset[0] + pending.offset;
    resizeCorrection.current.frame = requestAnimationFrame(() => {
      // Let ResizeObserver measurements and the new history controls settle before restoring the anchor.
      resizeCorrection.current.frame = requestAnimationFrame(() => {
        const row = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
        const content = row?.querySelector<HTMLElement>(".conversation-entry") ?? row;
        if (content) scroll.scrollTop += content.getBoundingClientRect().top - pending.top;
        anchor.current = undefined;
        resizeCorrection.current = { frame: 0, delta: 0 };
      });
    });
  }, [rows, loading, virtualizer, getScrollElement, clearResizeCorrection]);
  const participants = snapshot.participants;
  return <div ref={host} className="paged-transcript">
    {root ? <><PublicMessage message={root} participants={participants} chatId={snapshot.conversation.id} /><p className="thread-reply-count">{replyCount} {replyCount === 1 ? "reply" : "replies"}</p></> : null}
    {cursor ? <Button variant="secondary" disabled={loading} onClick={() => void load(cursor)}>Load older</Button> : null}
    {loading || refreshing ? <Spinner label="Loading history" /> : null}
    {refreshError ? <Notice>{refreshError}<Button variant="secondary" onClick={() => void refresh()}>Retry history update</Button></Notice> : null}
    {error ? <Notice>{error}<Button variant="secondary" onClick={() => { if (expired) { rowsRef.current = []; setRows([]); setCursor(null); setExpired(false); } void load(expired ? undefined : cursor ?? undefined); }}>{expired ? "Reload history" : "Retry"}</Button></Notice> : null}
    <div ref={list} style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {virtualizer.getVirtualItems().map(row => {
        const item = rows[row.index]!;
        const date = new Date(item.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        const previous = rows[row.index - 1];
        const showDate = !previous || new Date(previous.at).toDateString() !== new Date(item.at).toDateString();
        return <div key={row.key} data-index={row.index} ref={virtualizer.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start - scrollMargin}px)` }}>
          {showDate ? <div className="transcript-date"><span>{date}</span></div> : null}
          <TimelineRow item={item} participants={participants} chatId={snapshot.conversation.id} activeThreadId={activeThreadId} onThread={onThread} />
        </div>;
      })}
    </div>
  </div>;
}

const TimelineRow = memo(function TimelineRow({ item, participants, chatId, activeThreadId, onThread }: { item: Item; participants: ChatSnapshot["participants"]; chatId: string; activeThreadId: string | null; onThread?: (id: string) => void }) {
  return item.message ? <PublicMessage message={item.message} participants={participants} selected={activeThreadId === item.message.id} onThread={onThread} chatId={chatId} /> : <ActivityDetail activity={item.activity!} participants={participants} chatId={chatId} />;
});

function ActivityDetail({ activity, participants, chatId }: { activity: ParticipantActivity; participants: ChatSnapshot["participants"]; chatId: string }) {
  const { api } = useSession();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ActivityPage>();
  const [before, setBefore] = useState<number>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = `/api/chats/${encodeURIComponent(chatId)}/detail/activity/${encodeURIComponent(activity.id)}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    void api<ActivityPage>(`${url}${before === undefined ? "" : `?before=${before}`}`, undefined, controller.signal).then(value => { if (!controller.signal.aborted) setPage(value); }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, activity.detail?.version, before, url, api, attempt]);
  if (!activity.detail) return <PublicActivity activity={activity} participants={participants} />;
  const name = participants.find(person => person.id === activity.participantId)?.name ?? "Agent";
  return <section className="conversation-entry participant-activity activity-detail"><div className="participant-body">
    <Button variant="ghost" className="button-compact" aria-label={`Tool details for ${name}`} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}{name}</Button>
    {open ? <>
      {error ? <Notice>{error}<Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Retry</Button></Notice> : null}
      {loading && !page ? <Spinner label="Loading activity" /> : null}
      {page ? <>
        {page.before !== null ? <Button variant="secondary" onClick={() => { setPage(undefined); setBefore(page.before!); }}>Older activity</Button> : null}
        {before !== undefined ? <Button variant="secondary" onClick={() => { setPage(undefined); setBefore(undefined); }}>Latest activity</Button> : null}
        {page.items.map(item => item.kind === "tool" ? <ToolActivityView key={item.id} activity={item.tool} authorName={name} /> : item.kind === "text" ? <Markdown key={item.id}>{item.text}</Markdown> : item.kind === "large" ? <p key={item.id}>{item.label} <a href={`${url}?download=1`}>Download</a></p> : <details key={item.id}><summary>{item.label}</summary><pre>{JSON.stringify(item.data, null, 2)}</pre></details>)}
        <a href={`${url}?download=1`}>Download complete activity</a>
      </> : null}
    </> : null}
  </div></section>;
}
