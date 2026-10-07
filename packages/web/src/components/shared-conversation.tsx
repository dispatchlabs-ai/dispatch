import { ATTACHMENT_IMAGE_MAX_BYTES } from "../shared/contracts";
import { AttachmentPicker, DraftAttachments, type AttachmentComposerProps } from "./composer-attachments";
import { describeAgentTools } from "../lib/agent-tools";
import type { Message } from "@earendil-works/pi-ai";
import { Tabs } from "@base-ui/react/tabs";
import { ArrowUp, Check, Copy, Ear, LockKeyhole, Pencil, Reply, RotateCcw, Square, UserPlus, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AddParticipantsInput, AgentDefinition, AgentParticipant, ApplicationConfig, ChatSnapshot, CompanyPerson, ConversationMessage, ConversationParticipant, ParticipantActivity } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import type { PendingMessage } from "../lib/chat";
import { useSession } from "../lib/session";
import { useComposingPresence } from "../lib/composing";
import { mentionUrl } from "../lib/mentions";
import { toolActivities, toolOutput, type ToolActivity } from "../lib/tool-activity";
import { AgentChoices, ParticipantAvatar } from "./conversation-people";
import { Markdown } from "./markdown";
import { MarkdownComposer } from "./markdown-composer";
import { SidebarSearch } from "./sidebar-search";
import { ToolActivityView } from "./tool-activity";
import { Button, IconButton, Modal, Notice, Spinner } from "./ui";

export const participantStatus = { idle: "Following", working: "Working", listening: "Listening", responding: "Responding", typing: "Typing", silent: "Following", stopped: "Stopped", failed: "Needs attention" };

export function ConversationPresence({ participants }: { participants: ConversationParticipant[] }) {
  const { state } = useSession();
  const userId = state?.state === "authenticated" ? state.user.id : undefined;
  return <div className="conversation-presence" role="status" aria-live="polite">{participants.filter(member => member.kind === "human" ? member.status === "typing" && member.userId !== userId : ["working", "listening", "responding"].includes(member.status)).map(member => <div className="agent-working" key={member.id}>
    {member.status === "listening" ? <Ear size={15} aria-hidden="true" /> : member.status === "typing" ? <Pencil size={15} aria-hidden="true" /> : <Spinner label={`${member.name} is ${participantStatus[member.status].toLowerCase()}`} />}
    <span>{member.name} · {participantStatus[member.status]}</span>
  </div>)}</div>;
}

function participantName(participant: ConversationParticipant, participants: ConversationParticipant[]) {
  return participants.some(other => other.id !== participant.id && other.name === participant.name)
    ? `${participant.name} · ${participant.id.slice(-6)}` : participant.name;
}

function ParticipantContent({ author, participants, createdAt, showAuthor = true, status, children }: {
  author?: ConversationParticipant; participants: ConversationParticipant[]; createdAt: number; showAuthor?: boolean; status?: string; children: ReactNode;
}) {
  return <>
    {showAuthor ? <ParticipantAvatar kind={author?.kind || "human"} name={author?.name || "?"} /> : null}
    <div className="participant-body">
      {showAuthor ? <header className="message-heading"><strong>{author ? participantName(author, participants) : "Former participant"}</strong>{author?.kind === "agent" ? <span className="agent-kind-badge">Agent</span> : null}<time dateTime={new Date(createdAt).toISOString()}>{formatTime(createdAt)}</time>{status ? <span className="activity-status">{status}</span> : null}</header> : null}
      {children}
    </div>
  </>;
}

export function PublicMessage({ message, participants, replies = [], onThread, outputInActivity = false, selected = false }: {
  message: ConversationMessage; participants: ConversationParticipant[]; replies?: ConversationMessage[]; selected?: boolean; onThread?: (id: string) => void; outputInActivity?: boolean;
}) {
  const author = participants.find(participant => participant.id === message.authorId);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<number | null>(null);
  const replyAuthors = [...new Set(replies.map(reply => reply.authorId))].map(id => participants.find(participant => participant.id === id)).filter((participant): participant is ConversationParticipant => Boolean(participant));
  const lastReply = replies.reduce<ConversationMessage | undefined>((last, reply) => !last || reply.createdAt > last.createdAt ? reply : last, undefined);
  const detachedMentions = message.mentions.filter(id => !message.text.includes(`](${mentionUrl(id)})`));
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  if (message.kind === "membership") return <p className="membership-event"><UserPlus size={14} aria-hidden="true" /><span>{message.text}</span><time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time></p>;
  return <article className={`message conversation-entry shared-message ${selected ? "is-thread-parent" : ""} ${outputInActivity ? "activity-echo-actions" : ""}`} aria-label={`Message from ${author?.name || "Former participant"}`} data-message-id={message.id}>
    <ParticipantContent author={author} participants={participants} createdAt={message.createdAt} showAuthor={!outputInActivity}>
      {outputInActivity ? <header className="message-heading activity-output-reference">Command output shown above</header> : null}
      {!outputInActivity ? <div className="message-content"><Markdown mentions={participants.filter(person => message.mentions.includes(person.id))}>{message.text}</Markdown></div> : null}
      {message.attachments?.length ? <div className="message-attachments">{message.attachments.map(attachment => <a className="message-attachment" href={attachment.url} key={attachment.id} target="_blank" rel="noopener noreferrer">
        {attachment.kind === "image" ? <img src={attachment.url} alt={attachment.name} loading="lazy" /> : null}
        <span>{attachment.name}{attachment.kind === "file" ? " · Download only" : attachment.kind === "image" && attachment.size > ATTACHMENT_IMAGE_MAX_BYTES ? " · Preview/download only; too large for agents" : ""}</span>
      </a>)}</div> : null}
      {message.images?.map((image, index) => <img className="message-image" key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="Image attached to the message" />)}
      {detachedMentions.length ? <div className="message-mentions" aria-label="Mentioned participants">{detachedMentions.map(id => <span key={id}>@{participants.find(participant => participant.id === id)?.name || "Former participant"}</span>)}</div> : null}
      <div className="message-actions shared-message-actions" aria-label="Message actions">
        {onThread ? <IconButton label="Reply in thread" onClick={() => onThread(message.threadId || message.id)}><Reply size={15} /></IconButton> : null}
        <IconButton label={copied ? "Copied message" : "Copy message"} onClick={() => {
          void navigator.clipboard.writeText(message.text).then(() => { setCopied(true); setCopyError(false); timer.current = window.setTimeout(() => setCopied(false), 2000); }).catch(() => setCopyError(true));
        }}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton>
      </div>
      {copyError ? <p className="message-copy-error" role="status">Couldn’t copy. Select the text to copy it.</p> : null}
      {replies.length && onThread ? <button type="button" className="thread-summary" onClick={() => onThread(message.id)} aria-label={`${replies.length} ${replies.length === 1 ? "reply" : "replies"}${replyAuthors.length ? ` from ${replyAuthors.map(author => author.name).join(", ")}` : ""}`} aria-expanded={selected}>
        <span className="thread-summary-avatars" aria-hidden="true">{replyAuthors.slice(0, 3).map(author => <ParticipantAvatar key={author.id} kind={author.kind} name={author.name} />)}</span>
        <span className="thread-summary-count">{replies.length} {replies.length === 1 ? "reply" : "replies"}</span>
        {lastReply ? <span className="thread-summary-time">Last reply <time dateTime={new Date(lastReply.createdAt).toISOString()} title={new Date(lastReply.createdAt).toLocaleString()}>{formatTime(lastReply.createdAt)}</time></span> : null}
      </button> : null}
    </ParticipantContent>
  </article>;
}

export function PublicActivity({ activity, participants }: { activity: ParticipantActivity; participants: ConversationParticipant[] }) {
  const author = participants.find(participant => participant.id === activity.participantId);
  const tools = useMemo(() => toolActivities(activity.entries, activity.live), [activity.entries, activity.live]);
  const rendered = new Set<ToolActivity>();
  const content: ReactNode[] = [];
  function appendTool(tool: ToolActivity | null | undefined, key: string) {
    if (!tool || rendered.has(tool)) return;
    rendered.add(tool);
    content.push(<ToolActivityView key={key} activity={tool} authorName={author?.name || "Agent"} />);
  }
  function appendMessage(message: Message, key: string) {
    if (message.role === "toolResult") {
      appendTool(tools.results.get(message), key);
    } else if (message.role === "assistant") {
      const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n\n");
      // The server projects public commentary and provisional output only;
      // committed final answers are rendered from the shared public messages.
      if (text && !tools.echoes.has(message)) {
        content.push(<div className="activity-commentary" key={`${key}:text`}><Markdown>{text}</Markdown></div>);
      }
      for (const part of message.content) {
        if (part.type === "toolCall") appendTool(tools.calls.get(part), `${key}:tool:${part.id}`);
      }
    }
  }
  for (const entry of activity.entries) {
    if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") {
      content.push(<details className="native-entry" key={entry.id}>
        <summary>{entry.kind === "pi.reset" ? "Agent working context started" : "Agent working context summarized"}</summary>
        {entry.data ? <pre>{JSON.stringify(entry.data, null, 2)}</pre> : null}
      </details>);
    } else if (!entry.model?.length) {
      content.push(<details className="native-entry" key={entry.id}><summary>Agent event · technical details</summary><pre>{JSON.stringify({ kind: entry.kind, data: entry.data }, null, 2)}</pre></details>);
    } else entry.model.forEach((message, index) => appendMessage(message, `${entry.id}:${index}`));
  }
  const generation = activity.live.generation;
  if (generation?.message) appendMessage(generation.message as Message, "live");
  tools.extra.forEach((tool, index) => appendTool(tool, `extra:${index}`));
  if (generation?.retry) content.push(<p className="run-outcome" role="status" key="retry">Retrying the response…</p>);
  if (!content.length) return null;
  return <section className="conversation-entry participant-activity" aria-label={`${author?.name || "Agent"} activity`}>
    <ParticipantContent author={author} participants={participants} createdAt={activity.createdAt} status={generation && author?.kind === "agent" ? `${participantStatus[author.status]}…` : "Activity"}>
      {content}
    </ParticipantContent>
  </section>;
}

function repeatsBashOutput(message: ConversationMessage, activity: ParticipantActivity): boolean {
  if (activity.messageId !== message.id || activity.participantId !== message.authorId || message.images?.length || message.attachments?.length) return false;
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

export const SharedTranscript = memo(function SharedTranscript({ snapshot, threadId = null, activeThreadId = null, onThread }: { snapshot: ChatSnapshot; threadId?: string | null; activeThreadId?: string | null; onThread?: (id: string) => void }) {
  const messagesByThread = useMemo(() => {
    const groups = new Map<string | null, ConversationMessage[]>();
    for (const message of snapshot.messages) {
      const group = groups.get(message.threadId);
      if (group) group.push(message);
      else groups.set(message.threadId, [message]);
    }
    return groups;
  }, [snapshot.messages]);
  const messages = messagesByThread.get(threadId) ?? [];
  const items = [
    ...messages.map(message => ({ kind: "message" as const, id: message.id, at: message.createdAt, message })),
    ...snapshot.activities.filter(activity => activity.threadId === threadId).map(activity => ({ kind: "activity" as const, id: activity.id, at: activity.createdAt, activity })),
  ].sort((a, b) => a.at - b.at);
  let date = "";
  return <>{items.map((item, index) => {
    const nextDate = new Date(item.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const showDate = nextDate !== date;
    date = nextDate;
    const previous = items[index - 1];
    return <div key={`${item.kind}:${item.id}`}>
      {showDate ? <div className="transcript-date"><span>{nextDate}</span></div> : null}
      {item.kind === "message" ? <PublicMessage message={item.message} participants={snapshot.participants} replies={messagesByThread.get(item.id)} selected={activeThreadId === item.id || Boolean(activeThreadId && item.message.aliases?.includes(activeThreadId))} onThread={onThread} outputInActivity={!showDate && previous?.kind === "activity" && repeatsBashOutput(item.message, previous.activity)} /> : <PublicActivity activity={item.activity} participants={snapshot.participants} />}
    </div>;
  })}</>;
});

function formatTime(timestamp: number) { return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

export function ConversationComposer({ id, chatId, active = true, draft, pending, error, participants, mentions, onMentionsChange, onDraftChange, onSend, thread = false, conversationTitle, disabled = false, attachments, onAddFiles, onRemoveAttachment, onRetryAttachment, children }: AttachmentComposerProps & {
  id: string; chatId: string; active?: boolean; draft: string; pending?: PendingMessage; error?: string; participants: ConversationParticipant[]; mentions: string[];
  onMentionsChange: (ids: string[]) => void; onDraftChange: (text: string) => void; onSend: (mentions: string[]) => void;
  thread?: boolean; conversationTitle?: string; disabled?: boolean; children?: ReactNode;
}) {
  const tooLong = draft.length > 100000;
  const [attachmentError, setAttachmentError] = useState<string>();
  useEffect(() => setAttachmentError(undefined), [id]);
  const addFiles = (files: File[]) => { if (!disabled && !pending?.sending) setAttachmentError(onAddFiles(files)); };
  const canSend = Boolean((draft.trim() || attachments.length) && attachments.every(item => item.attachment) && !tooLong && !pending?.sending && !disabled);
  const composing = useComposingPresence(chatId, active && !disabled && !pending?.sending);
  const send = () => { if (canSend) { composing.clear(); onSend(mentions); } };
  return <div className="composer-area">
    {pending?.error ? <Notice>{pending.error} Your message is kept here. Retry sends the same message once.</Notice> : error ? <Notice>{error}</Notice> : null}
    {attachmentError ? <Notice>{attachmentError}</Notice> : null}
    {tooLong ? <Notice>Shorten your message to 100,000 characters or fewer, including Markdown formatting.</Notice> : null}
    {composing.unavailable ? <p className="run-outcome" role="status">Typing status is unavailable. You can still send your message.</p> : null}
    <form className="composer" onInput={composing.pulse} onCompositionStart={composing.pulse} onCompositionUpdate={composing.pulse} onPaste={composing.pulse} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) composing.clear(); }} onSubmit={event => { event.preventDefault(); send(); }}>
      <DraftAttachments attachments={attachments} disabled={disabled || Boolean(pending?.sending)} onRemoveAttachment={onRemoveAttachment} onRetryAttachment={onRetryAttachment} />
      <MarkdownComposer onPasteFiles={addFiles} id={id} value={draft} disabled={disabled} readOnly={Boolean(pending?.sending)} onChange={onDraftChange} onSend={send}
        participants={participants} mentions={mentions} onMentionsChange={onMentionsChange} placeholder={thread ? "Reply to thread…" : conversationTitle ? `Message ${conversationTitle}…` : "Message conversation…"}
        toolbar={<><AttachmentPicker disabled={disabled || Boolean(pending?.sending)} onAddFiles={addFiles} /><div className="button-row">{children}<Button type="submit" className="send-button" disabled={!canSend} aria-label={pending?.error ? "Retry sending message" : thread ? "Send reply" : "Send message"}>{pending?.sending ? <Spinner label="Sending message" /> : pending?.error ? <RotateCcw /> : <ArrowUp />}</Button></div></>}
      />
    </form>
    <p className="attachment-sharing-note">Files picked or pasted here are shared immediately with conversation members and retained, even when removed from the draft.</p>
    {thread ? <p className="thread-visibility"><LockKeyhole size={12} /> Replies are visible to everyone in this conversation.</p> : null}
  </div>;
}

export function SharedContextPanel({ snapshot, models, threadId, draft, pending, error, mentions, onMentionsChange, onDraftChange, onSend, onInvite, onSnapshot, onClose, showHeader = true, attachments, onAddFiles, onRemoveAttachment, onRetryAttachment }: AttachmentComposerProps & {
  snapshot: ChatSnapshot; models: ApplicationConfig["models"]; threadId: string | null;
  draft: string; pending?: PendingMessage; error?: string; mentions: string[]; onMentionsChange: (ids: string[]) => void;
  onDraftChange: (text: string) => void; onSend: (mentions: string[]) => void; onInvite: () => void; onSnapshot: (snapshot: ChatSnapshot) => void; onClose: () => void; showHeader?: boolean;
}) {
  const { state, api } = useSession();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const participant = snapshot.participants.find(member => member.id === selectedId);
  useEffect(() => { setSelectedId(null); }, [snapshot.conversation.id, threadId]);
  const root = snapshot.messages.find(message => message.id === threadId || (threadId && message.aliases?.includes(threadId)));
  const replyCount = snapshot.messages.filter(message => message.threadId === (root?.id ?? threadId)).length;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => { atBottom.current = true; }, [threadId]);
  useEffect(() => { if (atBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [snapshot, threadId]);
  return <div tabIndex={-1} aria-label={threadId ? "Thread" : "Participants"} className={`shared-context ${threadId ? "thread-context" : "participants-context"}`}>
    {showHeader ? <header className="context-header"><h2>{threadId ? "Thread" : "Participants"}</h2><IconButton label={threadId ? "Close thread" : "Close participants"} onClick={onClose}><X size={18} /></IconButton></header> : null}
    {threadId ? <>
      <div className="thread-transcript" ref={scroller} onScroll={event => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {root ? <PublicMessage message={root} participants={snapshot.participants} /> : <Notice>The original message is not available.</Notice>}
        <p className="thread-reply-count">{replyCount} {replyCount === 1 ? "reply" : "replies"}</p>
        <SharedTranscript snapshot={snapshot} threadId={root?.id ?? threadId} />
        <ConversationPresence participants={snapshot.participants} />
      </div>
      <ConversationComposer attachments={attachments} onAddFiles={onAddFiles} onRemoveAttachment={onRemoveAttachment} onRetryAttachment={onRetryAttachment} id={`thread-${snapshot.conversation.id}-${threadId}`} chatId={snapshot.conversation.id} draft={draft} pending={pending} error={error} participants={snapshot.participants} mentions={mentions} onMentionsChange={onMentionsChange} onDraftChange={onDraftChange} onSend={onSend} disabled={snapshot.conversation.canParticipate === false} thread>
        {snapshot.conversation.status === "running" && snapshot.conversation.canParticipate !== false ? <Button variant="secondary" className="stop-button" disabled={stopping} onClick={() => {
          setStopping(true); setStopError(null);
          void api<ChatSnapshot>(`/api/chats/${encodeURIComponent(snapshot.conversation.id)}/stop`, {}).then(onSnapshot).catch(error => setStopError(errorMessage(error))).finally(() => setStopping(false));
        }}>{stopping ? <Spinner /> : <Square size={14} />} Stop all</Button> : null}
      </ConversationComposer>
      {stopError ? <Notice>{stopError}</Notice> : null}
    </> : <div className="participants-body">
      <Button className="invite-participants" variant="secondary" disabled={snapshot.conversation.canParticipate === false} onClick={onInvite}><UserPlus size={18} /> Add participants</Button>
      <div className="participant-list">{snapshot.participants.map(member => <button type="button" className={`participant-row ${participant?.id === member.id ? "selected" : ""}`} key={member.id} onClick={() => setSelectedId(member.id)} aria-pressed={participant?.id === member.id}>
        <ParticipantAvatar kind={member.kind} name={member.name} /><span className="participant-choice-copy"><strong>{participantName(member, snapshot.participants)}</strong><span>{member.kind === "agent" ? `Agent · ${participantStatus[member.status]}` : `${state?.state === "authenticated" && state.user.id === member.userId ? "You" : "Person"}${member.status === "typing" ? " · Typing" : ""}`}</span></span>
      </button>)}</div>
      <p className="history-access"><LockKeyhole size={14} /> {snapshot.conversation.sharedProjectId ? "Current project members can read the full history. Listed authors may include former members." : "Everyone here can read the full public history."}</p>
      {participant ? <section className="participant-details">
        <h3>{participantName(participant, snapshot.participants)}</h3>
        {participant.kind === "agent" ? <>
          <p>This conversation’s independent agent instance.</p>
          <dl className="context-facts"><div><dt>Based on</dt><dd>{participant.agent.name} · revision {participant.agentRevision}</dd></div><div><dt>Model</dt><dd>{models.find(model => model.id === participant.agent.modelId && model.provider === participant.agent.provider)?.name || participant.agent.modelId}</dd></div><div><dt>Provider</dt><dd>{participant.agent.provider}</dd></div><div><dt>Thinking</dt><dd>{participant.agent.thinkingLevel}</dd></div><div><dt>Tools</dt><dd>{describeAgentTools(participant.agent.tools)}</dd></div>{participant.agent.cwd ? <div><dt>Local workspace</dt><dd>{participant.agent.cwd}</dd></div> : null}</dl>
          {participant.error ? <Notice>{participant.error}</Notice> : null}
          <details><summary>Saved instructions</summary><Markdown>{participant.agent.instructions || "No additional instructions."}</Markdown></details>
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
  const joinedDefinitionIds = snapshot.participants.filter(member => member.kind === "agent").map(member => member.agentDefinitionId);
  const selectedAgentIds = agentIds.filter(id => !joinedDefinitionIds.includes(id));
  useEffect(() => {
    const controller = new AbortController();
    setPeopleError(null);
    void api<{ people: CompanyPerson[] }>("/api/people", undefined, controller.signal).then(result => setPeople(result.people)).catch(error => { if (!controller.signal.aborted) setPeopleError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, attempt]);
  async function invite() {
    if (busy) return;
    if (!request.current || JSON.stringify(request.current.agentDefinitionIds) !== JSON.stringify(selectedAgentIds) || JSON.stringify(request.current.userIds) !== JSON.stringify(userIds)) request.current = { requestId: crypto.randomUUID(), agentDefinitionIds: selectedAgentIds, userIds };
    setBusy(true); setError(null);
    try { onSnapshot(await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(snapshot.conversation.id)}/participants`, request.current)); onClose(); }
    catch (error) { setError(errorMessage(error)); if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) request.current = null; }
    finally { setBusy(false); }
  }
  const selected = selectedAgentIds.length + userIds.length;
  return <Modal title="Add participants" description={snapshot.conversation.title} open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <div className="conversation-picker invitation-picker">
      <Tabs.Root value={tab} onValueChange={value => setTab(String(value))}>
        <Tabs.List className="context-tab-list" aria-label="Participant type"><Tabs.Tab value="agents">Agents</Tabs.Tab><Tabs.Tab value="people" disabled={Boolean(snapshot.conversation.sharedProjectId)}>People</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="agents" keepMounted><AgentChoices agents={agents} selected={selectedAgentIds} onChange={setAgentIds} disabled={busy} joinedDefinitionIds={joinedDefinitionIds} /></Tabs.Panel>
        <Tabs.Panel value="people" keepMounted><SidebarSearch label="Find a person" value={search} onChange={setSearch} />
          {peopleError ? <><Notice>{peopleError}</Notice><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>Retry loading people</Button></> : !people ? <Spinner label="Loading people" /> : <div className="participant-choice-list">{people.filter(person => person.name.toLowerCase().includes(search.toLowerCase())).map(person => {
            const joined = snapshot.participants.some(member => member.kind === "human" && member.userId === person.id);
            return <label key={person.id} className={`participant-choice ${userIds.includes(person.id) ? "selected" : ""}`}><ParticipantAvatar kind="human" name={person.name} /><span className="participant-choice-copy"><strong>{person.name}</strong>{joined ? <span>Already here</span> : null}</span>{joined ? null : <><input type="checkbox" disabled={busy} checked={userIds.includes(person.id)} onChange={event => setUserIds(event.target.checked ? [...userIds, person.id] : userIds.filter(id => id !== person.id))} /><span className="participant-check" aria-hidden="true">{userIds.includes(person.id) ? <Check size={16} /> : null}</span></>}</label>;
          })}{!people.some(person => person.name.toLowerCase().includes(search.toLowerCase())) ? <p className="collection-empty">No people match your search.</p> : null}</div>}
        </Tabs.Panel>
      </Tabs.Root>
      <p className="history-access"><LockKeyhole size={15} /> {snapshot.conversation.sharedProjectId ? "Add people through project settings. New agent participants can read the full project conversation history." : "New participants can read the full conversation history."}</p>
      {error ? <Notice>{error} You can retry this invitation.</Notice> : null}
      <footer className="picker-actions"><span>{selected} selected</span><div className="button-row"><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || !selected} onClick={() => void invite()}>{busy ? <Spinner /> : <UserPlus size={16} />} Add {selected === 1 ? "participant" : "participants"}</Button></div></footer>
    </div>
  </Modal>;
}
