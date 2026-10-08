import type { ActivityPage } from "../shared/activity-page";
import { ToolActivityView } from "./tool-activity";
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
  return [...page.messages.map(message => ({ id: `m:${message.id}`, at: message.createdAt, message })), ...page.activities.map(activity => ({ id: `a:${activity.id}`, at: activity.createdAt, activity }))];
}
function merge(before: Item[], incoming: Item[]) {
  const map = new Map(before.map(item => [item.id, item]));
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
  const historyLoaded = useRef(false);
  const inFlight = useRef(false);
  const loadedRevision = useRef(-1);
  const [expired, setExpired] = useState(false);
  const alive = useRef(true);
  const revision = useRef(snapshot.conversation.revision);
  revision.current = snapshot.conversation.revision;
  const getScrollElement = useCallback(() => host.current?.closest<HTMLElement>(".transcript, .thread-transcript") ?? null, []);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement, scrollMargin, estimateSize: () => 160, overscan: 4, getItemKey: index => rows[index]!.id });
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const base = `/api/chats/${encodeURIComponent(snapshot.conversation.id)}`;
  const query = threadId ? `threadId=${encodeURIComponent(threadId)}&` : "";
  const load = useCallback(async (before?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestedRevision = revision.current;
    setLoading(true); setError(undefined);
    const scroll = getScrollElement();
    const first = virtualizer.getVirtualItems().find(item => item.end > (scroll?.scrollTop ?? 0));
    if (before && first && scroll) anchor.current = { id: String(first.key), offset: scroll.scrollTop - first.start };
    try {
      const page = await api<TranscriptPage>(`${base}/history?${query}${before ? `before=${encodeURIComponent(before)}` : ""}`);
      if (!alive.current) return;
      if (page.generation !== (snapshot.history?.generation ?? page.generation)) return;
      loadedRevision.current = page.revision ?? requestedRevision;
      setRows(old => before ? merge(items(page), old) : merge(old, items(page)));
      if (before || !historyLoaded.current) setCursor(page.before);
      if (before) historyLoaded.current = true;
      if (page.root) { setRoot(page.root); setReplyCount(page.replyCount ?? 0); }
    } catch (error) { if (alive.current) { setError(errorMessage(error)); setExpired(error instanceof ApiError && error.code === "HISTORY_CHANGED"); } }
    finally { inFlight.current = false; if (alive.current) setLoading(false); }
  }, [api, base, query, getScrollElement, virtualizer, snapshot.history?.generation]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!threadId) {
      setRows(old => {
        const incoming = items(snapshot);
        const incomingIds = new Set(incoming.map(item => item.id));
        if (old.length && incoming.length && !old.some(item => incomingIds.has(item.id))) {
          historyLoaded.current = false;
          setCursor(snapshot.history?.before ?? null);
          return incoming;
        }
        return merge(old, incoming);
      });
      if (!historyLoaded.current) setCursor(snapshot.history?.before ?? null);
    }
  }, [snapshot.messages, snapshot.activities, snapshot.history?.before, threadId]);
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
    const measure = () => setScrollMargin(list.current!.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host.current!);
    const onScroll = () => { following.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100; };
    scroll.addEventListener("scroll", onScroll);
    return () => { observer.disconnect(); scroll.removeEventListener("scroll", onScroll); };
  }, [getScrollElement]);
  useLayoutEffect(() => {
    const pending = anchor.current;
    if (!pending) {
      const scroll = getScrollElement();
      if (following.current && scroll) scroll.scrollTop = scroll.scrollHeight;
      return;
    }
    const index = rows.findIndex(item => item.id === pending.id);
    if (index >= 0) { virtualizer.scrollToIndex(index, { align: "start" }); const scroll = getScrollElement(); if (scroll) scroll.scrollTop += pending.offset; }
    anchor.current = undefined;
  }, [rows, virtualizer, getScrollElement]);
  const participants = snapshot.participants;
  return <div ref={host} className="paged-transcript">
    {root ? <><PublicMessage message={root} participants={participants} chatId={snapshot.conversation.id} /><p className="thread-reply-count">{replyCount} {replyCount === 1 ? "reply" : "replies"}</p></> : null}
    {cursor ? <Button variant="secondary" disabled={loading} onClick={() => void load(cursor)}>Load older</Button> : null}
    {loading ? <Spinner label="Loading history" /> : null}
    {error ? <Notice>{error}<Button variant="secondary" onClick={() => { if (expired) { historyLoaded.current = false; setRows([]); setCursor(null); setExpired(false); } void load(expired ? undefined : cursor ?? undefined); }}>{expired ? "Reload history" : "Retry"}</Button></Notice> : null}
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
  const url = `/api/chats/${encodeURIComponent(chatId)}/detail/activity/${encodeURIComponent(activity.id)}`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<ActivityPage>(`${url}${before === undefined ? "" : `?before=${before}`}`, undefined, controller.signal).then(setPage).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [open, activity.detail?.version, before, url, api]);
  if (!activity.detail) return <PublicActivity activity={activity} participants={participants} />;
  const name = participants.find(person => person.id === activity.participantId)?.name ?? "Agent";
  return <section className="conversation-entry participant-activity"><div className="participant-body">
    <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>{name} · {activity.detail.active ? "Working" : "Activity"} · {activity.detail.count} records</Button>
    {open ? <>
      {error ? <Notice>{error}</Notice> : null}
      {!page ? <Spinner label="Loading activity" /> : <>
        {page.before !== null ? <Button variant="secondary" onClick={() => setBefore(page.before!)}>Older activity</Button> : null}
        {before !== undefined ? <Button variant="secondary" onClick={() => setBefore(undefined)}>Latest activity</Button> : null}
        {page.items.map(item => item.kind === "tool" ? <ToolActivityView key={item.id} activity={item.tool} authorName={name} /> : item.kind === "text" ? <Markdown key={item.id}>{item.text}</Markdown> : item.kind === "large" ? <p key={item.id}>{item.label} <a href={`${url}?download=1`}>Download</a></p> : <details key={item.id}><summary>{item.label}</summary><pre>{JSON.stringify(item.data, null, 2)}</pre></details>)}
        <a href={`${url}?download=1`}>Download complete activity</a>
      </>}
    </> : null}
  </div></section>;
}
