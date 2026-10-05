import { Tabs } from "@base-ui/react/tabs";
import { AtSign, ArrowUp, Check, Copy, LockKeyhole, Reply, RotateCcw, Square, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AddParticipantsInput, AgentDefinition, AgentParticipant, ApplicationConfig, ChatSnapshot, CompanyPerson, ConversationMessage, ConversationParticipant, ParticipantActivity } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import type { PendingMessage } from "../lib/chat";
import { useSession } from "../lib/session";
import { toolActivities, toolOutput } from "../lib/tool-activity";
import { AgentChoices, ParticipantAvatar } from "./conversation-people";
import { Markdown } from "./markdown";
import { MarkdownComposer } from "./markdown-composer";
import { SidebarSearch } from "./sidebar-search";
import { ToolActivityView } from "./tool-activity";
import { Button, IconButton, Modal, Notice, Select, Spinner } from "./ui";

export const participantStatus = { idle: "Following", working: "Working", silent: "Following", stopped: "Stopped", failed: "Needs attention" };

function participantName(participant: ConversationParticipant, participants: ConversationParticipant[]) {
  return participants.some(other => other.id !== participant.id && other.name === participant.name)
    ? `${participant.name} · ${participant.id.slice(-6)}` : participant.name;
}

export function PublicMessage({ message, participants, replies, onThread, outputInActivity = false }: {
  message: ConversationMessage; participants: ConversationParticipant[]; replies?: number; onThread?: (id: string) => void; outputInActivity?: boolean;
}) {
  const author = participants.find(participant => participant.id === message.authorId);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  if (message.kind === "membership") return <p className="membership-event"><UserPlus size={14} aria-hidden="true" /><span>{message.text}</span><time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time></p>;
  return <article className={`message shared-message ${outputInActivity ? "activity-echo-actions" : ""}`} aria-label={`Message from ${author?.name || "Former participant"}`} data-message-id={message.id}>
    {!outputInActivity ? <ParticipantAvatar kind={author?.kind || "human"} name={author?.name || "?"} /> : null}
    <div className="shared-message-body">
      {!outputInActivity ? <header className="message-heading"><strong>{author ? participantName(author, participants) : "Former participant"}</strong>{author?.kind === "agent" ? <span className="agent-kind-badge">Agent</span> : null}<time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time></header> : null}
      {!outputInActivity ? <div className="message-content"><Markdown>{message.text}</Markdown></div> : null}
      {message.images?.map((image, index) => <img className="message-image" key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="Image attached to the message" />)}
      {message.mentions.length ? <div className="message-mentions" aria-label="Mentioned participants">{message.mentions.map(id => <span key={id}>@{participants.find(participant => participant.id === id)?.name || "Former participant"}</span>)}</div> : null}
      <div className="message-actions">
        {onThread ? <Button variant="ghost" className="thread-link" onClick={() => onThread(message.threadId || message.id)}><Reply size={14} />{replies ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "Reply"}</Button> : null}
        <IconButton label={copied ? "Copied message" : "Copy message"} onClick={() => {
          void navigator.clipboard.writeText(message.text).then(() => { setCopied(true); setCopyError(false); timer.current = window.setTimeout(() => setCopied(false), 2000); }).catch(() => setCopyError(true));
        }}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton>
        {copyError ? <span role="status">Couldn’t copy. Select the text to copy it.</span> : null}
      </div>
    </div>
  </article>;
}

export function PublicActivity({ activity, participants }: { activity: ParticipantActivity; participants: ConversationParticipant[] }) {
  const author = participants.find(participant => participant.id === activity.participantId);
  const tools = useMemo(() => toolActivities(activity.entries, activity.live), [activity.entries, activity.live]);
  const rendered = new Set<unknown>();
  const cards = [];
  for (const entry of activity.entries) for (const message of entry.model ?? []) {
    if (message.role === "toolResult") {
      const item = tools.results.get(message);
      if (item && !rendered.has(item)) { rendered.add(item); cards.push(item); }
    } else if (Array.isArray(message.content)) for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      const item = tools.calls.get(part);
      if (item && !rendered.has(item)) { rendered.add(item); cards.push(item); }
    }
  }
  const generation = activity.live.generation?.message;
  if (generation?.role === "assistant") for (const part of generation.content) {
    if (part.type !== "toolCall") continue;
    const item = tools.calls.get(part);
    if (item && !rendered.has(item)) { rendered.add(item); cards.push(item); }
  }
  cards.push(...tools.extra.filter(item => !rendered.has(item)));
  const boundaries = activity.entries.filter(entry => entry.kind === "pi.reset" || entry.kind === "pi.compaction");
  const events = activity.entries.filter(entry => !entry.model?.length && entry.kind !== "pi.reset" && entry.kind !== "pi.compaction");
  if (!cards.length && !boundaries.length && !events.length) return null;
  return <section className="participant-activity" aria-label={`${author?.name || "Agent"} activity`}>
    <div className="activity-author"><ParticipantAvatar kind="agent" name={author?.name || "Agent"} /><strong>{author?.name || "Agent"}</strong><span>Activity</span></div>
    {cards.map((activity, index) => <ToolActivityView key={index} activity={activity} />)}
    {events.map(entry => <details className="native-entry" key={entry.id}><summary>Agent event · technical details</summary><pre>{JSON.stringify({ kind: entry.kind, data: entry.data }, null, 2)}</pre></details>)}
    {boundaries.map(entry => <p className="native-entry" key={entry.id}>{entry.kind === "pi.reset" ? "Agent working context started" : "Agent working context summarized"}</p>)}
  </section>;
}

function repeatsBashOutput(message: ConversationMessage, activities: ParticipantActivity[]): boolean {
  const activity = activities.find(activity => activity.messageId === message.id);
  if (!activity) return false;
  const results = activity.entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
  const last = results.at(-1);
  if (!last || last.toolName !== "bash") return false;
  const tools = toolActivities(activity.entries, activity.live);
  const tool = [...tools.calls.values(), ...tools.results.values()].find(tool => tool?.result === last);
  if (!tool) return false;
  const output = toolOutput(tool).trim();
  const text = message.text.trim();
  const fenced = text.match(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1$/);
  return Boolean(output && (fenced?.[2] ?? text).trim() === output);
}

export function SharedTranscript({ snapshot, threadId = null, onThread }: { snapshot: ChatSnapshot; threadId?: string | null; onThread?: (id: string) => void }) {
  const messages = snapshot.messages.filter(message => message.threadId === threadId);
  const items = [
    ...messages.map(message => ({ kind: "message" as const, id: message.id, at: message.createdAt, message })),
    ...snapshot.activities.filter(activity => activity.threadId === threadId).map(activity => ({ kind: "activity" as const, id: activity.id, at: activity.createdAt, activity })),
  ].sort((a, b) => a.at - b.at);
  let date = "";
  return <>{items.map(item => {
    const nextDate = new Date(item.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const showDate = nextDate !== date;
    date = nextDate;
    return <div key={`${item.kind}:${item.id}`}>
      {showDate ? <div className="transcript-date"><span>{nextDate}</span></div> : null}
      {item.kind === "message" ? <PublicMessage message={item.message} participants={snapshot.participants} replies={snapshot.messages.filter(message => message.threadId === item.id).length} onThread={onThread} outputInActivity={repeatsBashOutput(item.message, snapshot.activities)} /> : <PublicActivity activity={item.activity} participants={snapshot.participants} />}
    </div>;
  })}</>;
}

function formatTime(timestamp: number) { return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

export function ConversationComposer({ id, draft, pending, error, participants, mentions, onMentionsChange, onDraftChange, onSend, thread = false, disabled = false, children }: {
  id: string; draft: string; pending?: PendingMessage; error?: string; participants: ConversationParticipant[]; mentions: string[];
  onMentionsChange: (ids: string[]) => void; onDraftChange: (text: string) => void; onSend: (mentions: string[]) => void;
  thread?: boolean; disabled?: boolean; children?: ReactNode;
}) {
  const tooLong = draft.length > 100000;
  const canSend = Boolean(draft.trim() && !tooLong && !pending?.sending && !disabled);
  const send = () => { if (canSend) onSend(mentions); };
  return <div className="composer-area">
    {pending?.error ? <Notice>{pending.error} Your message is kept here. Retry sends the same message once.</Notice> : error ? <Notice>{error}</Notice> : null}
    {tooLong ? <Notice>Shorten your message to 100,000 characters or fewer, including Markdown formatting.</Notice> : null}
    <form className="composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <MarkdownComposer id={id} value={draft} disabled={disabled} readOnly={Boolean(pending?.sending)} onChange={onDraftChange} onSend={send} placeholder={thread ? "Reply to thread…" : "Message everyone…"} />
      {mentions.length ? <div className="composer-mentions">{mentions.map(participantId => <Button key={participantId} variant="ghost" disabled={pending?.sending} onClick={() => onMentionsChange(mentions.filter(id => id !== participantId))} aria-label={`Remove mention of ${participants.find(person => person.id === participantId)?.name || "participant"}`}>@{participants.find(person => person.id === participantId)?.name || "Participant"}<X size={12} /></Button>)}</div> : null}
      <div className="composer-toolbar">
        <label className="mention-select"><AtSign size={16} aria-hidden="true" /><span className="sr-only">Mention a participant</span><Select value="" disabled={disabled || pending?.sending} onChange={event => { if (event.target.value) onMentionsChange([...mentions, event.target.value]); }}><option value="">Mention</option>{participants.filter(participant => !mentions.includes(participant.id)).map(participant => <option key={participant.id} value={participant.id}>{participant.name}{participant.kind === "agent" ? ` · Agent ${participant.id.slice(-6)}` : " · Person"}</option>)}</Select></label>
        <div className="button-row">{children}<Button type="submit" className="send-button" disabled={!canSend} aria-label={pending?.error ? "Retry sending message" : thread ? "Send reply" : "Send message"}>{pending?.sending ? <Spinner label="Sending message" /> : pending?.error ? <RotateCcw /> : <ArrowUp />}<span>Send</span></Button></div>
      </div>
    </form>
    {thread ? <p className="thread-visibility"><LockKeyhole size={12} /> Replies are visible to everyone in this conversation.</p> : null}
  </div>;
}

export function SharedContextPanel({ snapshot, models, threadId, draft, pending, error, mentions, onMentionsChange, onDraftChange, onSend, onInvite, onSnapshot, onClose, showHeader = true }: {
  snapshot: ChatSnapshot; models: ApplicationConfig["models"]; threadId: string | null;
  draft: string; pending?: PendingMessage; error?: string; mentions: string[]; onMentionsChange: (ids: string[]) => void;
  onDraftChange: (text: string) => void; onSend: (mentions: string[]) => void; onInvite: () => void; onSnapshot: (snapshot: ChatSnapshot) => void; onClose: () => void; showHeader?: boolean;
}) {
  const { state, api } = useSession();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const participant = snapshot.participants.find(member => member.id === selectedId) ?? snapshot.participants.find(member => member.kind === "agent");
  const root = snapshot.messages.find(message => message.id === threadId);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => { atBottom.current = true; }, [threadId]);
  useEffect(() => { if (atBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [snapshot, threadId]);
  return <div tabIndex={-1} aria-label={threadId ? "Thread" : "Participants"} className={`shared-context ${threadId ? "thread-context" : "participants-context"}`}>
    {showHeader ? <header className="context-header"><h2>{threadId ? "Thread" : "Participants"}</h2><IconButton label={threadId ? "Close thread" : "Close participants"} onClick={onClose}><X size={18} /></IconButton></header> : null}
    {threadId ? <>
      <div className="thread-transcript" ref={scroller} onScroll={event => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {root ? <PublicMessage message={root} participants={snapshot.participants} /> : <Notice>The original message is not available.</Notice>}
        <p className="thread-reply-count">{snapshot.messages.filter(message => message.threadId === threadId).length} replies</p>
        <SharedTranscript snapshot={snapshot} threadId={threadId} />
      </div>
      <ConversationComposer id={`thread-${snapshot.conversation.id}-${threadId}`} draft={draft} pending={pending} error={error} participants={snapshot.participants} mentions={mentions} onMentionsChange={onMentionsChange} onDraftChange={onDraftChange} onSend={onSend} thread>
        {snapshot.conversation.status === "running" ? <Button variant="secondary" className="stop-button" disabled={stopping} onClick={() => {
          setStopping(true); setStopError(null);
          void api<ChatSnapshot>(`/api/chats/${encodeURIComponent(snapshot.conversation.id)}/stop`, {}).then(onSnapshot).catch(error => setStopError(errorMessage(error))).finally(() => setStopping(false));
        }}>{stopping ? <Spinner /> : <Square size={14} />} Stop all</Button> : null}
      </ConversationComposer>
      {stopError ? <Notice>{stopError}</Notice> : null}
    </> : <div className="participants-body">
      <Button className="invite-participants" variant="secondary" onClick={onInvite}><UserPlus size={18} /> Add participants</Button>
      <div className="participant-list">{snapshot.participants.map(member => <button type="button" className={`participant-row ${participant?.id === member.id ? "selected" : ""}`} key={member.id} onClick={() => setSelectedId(member.id)} aria-pressed={participant?.id === member.id}>
        <ParticipantAvatar kind={member.kind} name={member.name} /><span className="participant-choice-copy"><strong>{participantName(member, snapshot.participants)}</strong><span>{member.kind === "agent" ? `Agent · ${participantStatus[member.status]}` : state?.state === "authenticated" && state.user.id === member.userId ? "You" : "Person"}</span></span>
      </button>)}</div>
      <p className="history-access"><LockKeyhole size={14} /> Everyone here can read the full public history.</p>
      {participant ? <section className="participant-details">
        <h3>{participantName(participant, snapshot.participants)}</h3>
        {participant.kind === "agent" ? <>
          <p>This conversation’s independent agent instance.</p>
          <dl className="context-facts"><div><dt>Based on</dt><dd>{participant.agent.name} · revision {participant.agentRevision}</dd></div><div><dt>Model</dt><dd>{models.find(model => model.id === participant.agent.modelId && model.provider === participant.agent.provider)?.name || participant.agent.modelId}</dd></div><div><dt>Provider</dt><dd>{participant.agent.provider}</dd></div><div><dt>Thinking</dt><dd>{participant.agent.thinkingLevel}</dd></div><div><dt>Tools</dt><dd>{participant.agent.tools.join(", ") || "No tools enabled"}</dd></div>{participant.agent.cwd ? <div><dt>Local workspace</dt><dd>{participant.agent.cwd}</dd></div> : null}</dl>
          {participant.error ? <Notice>{participant.error}</Notice> : null}
          <details><summary>Saved instructions</summary><p className="saved-instructions">{participant.agent.instructions || "No additional instructions."}</p></details>
          <ParticipantRunDetails participant={participant} activities={snapshot.activities} />
          <p>Coding tools use the service machine’s access. This workspace is not a sandbox.</p>
        </> : <p>Human participant since {new Date(participant.joinedAt).toLocaleDateString()}.</p>}
        <details><summary>Participant identity</summary><p className="identity-value">{participant.id}</p></details>
      </section> : <p className="participant-hint">Select a participant to see their details.</p>}
    </div>}
  </div>;
}

function ParticipantRunDetails({ participant, activities }: { participant: AgentParticipant; activities: ParticipantActivity[] }) {
  const models = Object.entries(participant.usage.models);
  const tokens = models.reduce((sum, [, usage]) => sum + usage.totalTokens, 0);
  const cost = models.reduce((sum, [, usage]) => sum + usage.cost.total, 0);
  const submissions = [...new Map(activities.filter(activity => activity.participantId === participant.id).flatMap(activity => activity.submissions).map(submission => [submission.id, submission])).values()];
  return <details className="participant-run">
    <summary>Run &amp; usage</summary>
    <p>{participant.name} · {participantStatus[participant.status]}</p>
    <dl className="context-facts"><div><dt>Total tokens</dt><dd>{tokens.toLocaleString()}</dd></div><div><dt>Estimated cost</dt><dd>{new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(cost)}</dd></div></dl>
    {!models.length ? <p>No usage has been recorded yet.</p> : null}
    {models.map(([model, usage]) => <section className="context-section" key={model}><h4 className="model-label">{model}</h4><dl className="context-facts"><div><dt>Input tokens</dt><dd>{usage.input.toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>{usage.output.toLocaleString()}</dd></div><div><dt>Cached input</dt><dd>{usage.cacheRead.toLocaleString()}</dd></div></dl></section>)}
    {submissions.length ? <details className="delivery-details"><summary>Message delivery</summary><ul>{submissions.map(submission => <li key={submission.id}><span>{submission.type === "input" ? "Message" : "Entry"}</span><strong>{submission.status === "done" ? "Completed" : submission.status === "unanswered" ? "Not answered" : submission.status === "placed" ? "In progress" : "Queued"}</strong>{submission.status === "unanswered" ? <details><summary>Technical delivery details</summary><p>{submission.reason}</p></details> : null}</li>)}</ul></details> : null}
  </details>;
}

export function InviteParticipantsDialog({ snapshot, agents, onSnapshot, onClose }: { snapshot: ChatSnapshot; agents: AgentDefinition[]; onSnapshot: (snapshot: ChatSnapshot) => void; onClose: () => void }) {
  const { api } = useSession();
  const [tab, setTab] = useState("agents");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [people, setPeople] = useState<CompanyPerson[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const request = useRef<AddParticipantsInput | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setPeopleError(null);
    void api<{ people: CompanyPerson[] }>("/api/people", undefined, controller.signal).then(result => setPeople(result.people)).catch(error => { if (!controller.signal.aborted) setPeopleError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, attempt]);
  async function invite() {
    if (busy) return;
    if (!request.current || JSON.stringify(request.current.agentDefinitionIds) !== JSON.stringify(agentIds) || JSON.stringify(request.current.userIds) !== JSON.stringify(userIds)) request.current = { requestId: crypto.randomUUID(), agentDefinitionIds: agentIds, userIds };
    setBusy(true); setError(null);
    try { onSnapshot(await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(snapshot.conversation.id)}/participants`, request.current)); onClose(); }
    catch (error) { setError(errorMessage(error)); if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) request.current = null; }
    finally { setBusy(false); }
  }
  const selected = agentIds.length + userIds.length;
  return <Modal title="Add participants" description={snapshot.conversation.title} open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <div className="conversation-picker invitation-picker">
      <Tabs.Root value={tab} onValueChange={value => setTab(String(value))}>
        <Tabs.List className="context-tab-list" aria-label="Participant type"><Tabs.Tab value="agents">Agents</Tabs.Tab><Tabs.Tab value="people">People</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="agents" keepMounted><AgentChoices agents={agents} selected={agentIds} onChange={setAgentIds} disabled={busy} /><p className="field-hint">Each invitation creates a separate agent instance, even if its definition is already here.</p></Tabs.Panel>
        <Tabs.Panel value="people" keepMounted><SidebarSearch label="Find a person" value={search} onChange={setSearch} />
          {peopleError ? <><Notice>{peopleError}</Notice><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Retry loading people</Button></> : !people ? <Spinner label="Loading people" /> : <div className="participant-choice-list">{people.filter(person => person.name.toLowerCase().includes(search.toLowerCase())).map(person => {
            const joined = snapshot.participants.some(member => member.kind === "human" && member.userId === person.id);
            return <label key={person.id} className={`participant-choice ${userIds.includes(person.id) ? "selected" : ""}`}><ParticipantAvatar kind="human" name={person.name} /><span className="participant-choice-copy"><strong>{person.name}</strong>{joined ? <span>Already here</span> : null}</span>{joined ? null : <><input type="checkbox" disabled={busy} checked={userIds.includes(person.id)} onChange={event => setUserIds(event.target.checked ? [...userIds, person.id] : userIds.filter(id => id !== person.id))} /><span className="participant-check" aria-hidden="true">{userIds.includes(person.id) ? <Check size={16} /> : null}</span></>}</label>;
          })}{!people.some(person => person.name.toLowerCase().includes(search.toLowerCase())) ? <p className="collection-empty">No people match your search.</p> : null}</div>}
        </Tabs.Panel>
      </Tabs.Root>
      <p className="history-access"><LockKeyhole size={15} /> New participants can read the full conversation history.</p>
      {error ? <Notice>{error} You can retry this invitation.</Notice> : null}
      <footer className="picker-actions"><span>{selected} selected</span><div className="button-row"><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || !selected} onClick={() => void invite()}>{busy ? <Spinner /> : <UserPlus size={16} />} Add {selected === 1 ? "participant" : "participants"}</Button></div></footer>
    </div>
  </Modal>;
}
