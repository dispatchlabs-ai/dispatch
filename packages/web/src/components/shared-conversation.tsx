import { PagedTranscript } from "./paged-transcript";
import { DefinitionOfDone, type CriteriaDraft } from "./definition-of-done";
import type { OpenInstanceForm } from "./add-instance";
import { ATTACHMENT_IMAGE_MAX_BYTES } from "../shared/contracts";
import { AttachmentPicker, DraftAttachments, type AttachmentComposerProps } from "./composer-attachments";
import { describeAgentTools } from "../lib/agent-tools";
import type { Message } from "@earendil-works/pi-ai";
import { Tabs } from "@base-ui/react/tabs";
import { ArrowUp, Check, Copy, Ear, LockKeyhole, Pencil, Reply, RotateCcw, Square, UserPlus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AddParticipantsInput, AgentDefinition, AgentParticipant, ApplicationConfig, ChatSnapshot, CompanyPerson, ConversationMessage, ConversationParticipant, ParticipantActivity } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useComposer } from "../lib/composers";
import { useSession } from "../lib/session";
import { useComposingPresence } from "../lib/composing";
import { agentMentionPrefix, mentionLabel, mentionUrl } from "../lib/mentions";
import { toolActivities, type ToolActivity } from "../lib/tool-activity";
import { AgentChoices, ParticipantAvatar } from "./conversation-people";
import { Markdown } from "./markdown";
import { MarkdownComposer } from "./markdown-composer";
import { SidebarSearch } from "./sidebar-search";
import { ToolActivityView } from "./tool-activity";
import { Button, IconButton, Modal, Notice, Spinner } from "./ui";

export const participantStatus = { idle: "Following", working: "Working", listening: "Listening", responding: "Responding", typing: "Typing", silent: "Following", stopped: "Stopped", failed: "Needs attention" };

function agentStatus(participant: AgentParticipant) {
  return participant.membership === "removed" ? "Removed" : participant.membership === "removing" ? (participant.removalError ? "Removal needs attention" : "Removing…") : participantStatus[participant.status];
}

export function ConversationPresence({ participants }: { participants: ConversationParticipant[] }) {
  const { state } = useSession();
  const userId = state?.state === "authenticated" ? state.user.id : undefined;
  return <div className="conversation-presence" role="status" aria-live="polite">{participants.filter(member => member.kind === "human" ? member.status === "typing" && member.userId !== userId : member.membership === "active" && ["working", "listening", "responding"].includes(member.status)).map(member => <div className="agent-working" key={member.id}>
    {member.status === "listening" ? <Ear size={15} aria-hidden="true" /> : member.status === "typing" ? <Pencil size={15} aria-hidden="true" /> : <Spinner label={`${member.name} is ${participantStatus[member.status].toLowerCase()}`} />}
    <span>{member.name}<span className="sr-only"> · {participantStatus[member.status]}</span></span>
  </div>)}</div>;
}

function ParticipantContent({ author, participants, createdAt, showAuthor = true, children }: {
  author?: ConversationParticipant; participants: ConversationParticipant[]; createdAt: number; showAuthor?: boolean; children: ReactNode;
}) {
  return <>
    {showAuthor ? <ParticipantAvatar kind={author?.kind || "human"} name={author?.name || "?"} /> : null}
    <div className="participant-body">
      {showAuthor ? <header className="message-heading"><strong>{author ? mentionLabel(author, participants) : "Former participant"}</strong>{author?.kind === "agent" ? <span className="agent-kind-badge">{author.membership === "removed" ? "Removed agent" : author.membership === "removing" ? "Removing agent" : "Agent"}</span> : null}<time dateTime={new Date(createdAt).toISOString()}>{formatTime(createdAt)}</time></header> : null}
      {children}
    </div>
  </>;
}

export function PublicMessage({ message, participants, replies = [], onThread, outputInActivity = false, selected = false, chatId }: {
  chatId?: string; message: ConversationMessage; participants: ConversationParticipant[]; replies?: ConversationMessage[]; selected?: boolean; onThread?: (id: string) => void; outputInActivity?: boolean;
}) {
  const { api } = useSession();
  const author = participants.find(participant => participant.id === message.authorId);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<number | null>(null);
  const replyCount = message.replySummary?.count ?? replies.length;
  const replyAuthors = [...new Set(message.replySummary?.authorIds ?? replies.map(reply => reply.authorId))].map(id => participants.find(participant => participant.id === id)).filter((participant): participant is ConversationParticipant => Boolean(participant));
  const lastReplyAt = message.replySummary?.lastAt ?? replies.reduce((last, reply) => Math.max(last, reply.createdAt), 0);
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
      {message.truncated && chatId ? <a href={`/api/chats/${encodeURIComponent(chatId)}/detail/message/${encodeURIComponent(message.id)}?download=1`}>Download complete message</a> : null}
      {message.images?.map((image, index) => <img className="message-image" key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="Image attached to the message" />)}
      {detachedMentions.length ? <div className="message-mentions" aria-label="Mentioned participants">{detachedMentions.map(id => <span key={id}>@{participants.find(participant => participant.id === id)?.name || "Former participant"}</span>)}</div> : null}
      <div className="message-actions shared-message-actions" aria-label="Message actions">
        {onThread ? <IconButton label="Reply in thread" onClick={() => onThread(message.threadId || message.id)}><Reply size={15} /></IconButton> : null}
        <IconButton label={copied ? "Copied message" : "Copy message"} onClick={() => {
          const text = message.truncated && chatId ? api<ConversationMessage>(`/api/chats/${encodeURIComponent(chatId)}/detail/message/${encodeURIComponent(message.id)}`).then(full => full.text) : Promise.resolve(message.text);
          void text.then(value => navigator.clipboard.writeText(value)).then(() => { setCopied(true); setCopyError(false); timer.current = window.setTimeout(() => setCopied(false), 2000); }).catch(() => setCopyError(true));
        }}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton>
      </div>
      {copyError ? <p className="message-copy-error" role="status">Couldn’t copy. Select the text to copy it.</p> : null}
      {replyCount && onThread ? <button type="button" className="thread-summary" onClick={() => onThread(message.id)} aria-label={`${replyCount} ${replyCount === 1 ? "reply" : "replies"}${replyAuthors.length ? ` from ${replyAuthors.map(author => author.name).join(", ")}` : ""}`} aria-expanded={selected}>
        <span className="thread-summary-avatars" aria-hidden="true">{replyAuthors.slice(0, 3).map(author => <ParticipantAvatar key={author.id} kind={author.kind} name={author.name} />)}</span>
        <span className="thread-summary-count">{replyCount} {replyCount === 1 ? "reply" : "replies"}</span>
        {lastReplyAt ? <span className="thread-summary-time">Last reply <time dateTime={new Date(lastReplyAt).toISOString()} title={new Date(lastReplyAt).toLocaleString()}>{formatTime(lastReplyAt)}</time></span> : null}
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
    <ParticipantContent author={author} participants={participants} createdAt={activity.createdAt}>
      {content}
    </ParticipantContent>
  </section>;
}

export const SharedTranscript = PagedTranscript;

function formatTime(timestamp: number) { return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }

export function ConversationComposer({ id, chatId, active = true, threadId, onBeforeSend, participants, agents, onAddInstance, thread = false, conversationTitle, disabled = false, attachments, onAddFiles, onRemoveAttachment, onRetryAttachment, running = false, onSnapshot }: AttachmentComposerProps & {
  id: string; chatId: string; active?: boolean; threadId?: string; onBeforeSend?: () => void; participants: ConversationParticipant[]; agents: AgentDefinition[];
  onAddInstance: OpenInstanceForm;
  thread?: boolean; conversationTitle?: string; disabled?: boolean; running?: boolean; onSnapshot: (snapshot: ChatSnapshot) => void;
}) {
  const { text: draft, pending, error, mentions, changeText: onDraftChange, changeMentions: onMentionsChange, send: onSend } = useComposer(chatId, threadId);
  const mentionPeople = useMemo(() => [
    ...participants.filter(person => person.kind === "human" ? person.membership !== "removed" : person.membership === "active"),
    ...agents.filter(agent => !agent.archived && !participants.some(person => person.kind === "agent" && person.membership !== "removed" && person.agentDefinitionId === agent.id))
      .map(agent => ({ id: `${agentMentionPrefix}${agent.id}`, name: agent.name, kind: "agent" as const, inviteOnSend: true })),
  ], [participants, agents]);
  const { api } = useSession();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string>();
  const [editorHasContent, setEditorHasContent] = useState(Boolean(draft.length));
  const [imeComposing, setImeComposing] = useState(false);
  const tooLong = draft.length > 100000;
  const [attachmentError, setAttachmentError] = useState<string>();
  useEffect(() => setAttachmentError(undefined), [id]);
  const addFiles = (files: File[]) => { if (!disabled && !pending?.sending) setAttachmentError(onAddFiles(files)); };
  const canSend = Boolean((draft.trim() || attachments.length) && attachments.every(item => item.attachment) && !tooLong && !pending?.sending && !stopping && !imeComposing && !disabled);
  const composing = useComposingPresence(chatId, active && !disabled && !pending?.sending);
  const send = () => { if (canSend) { composing.clear(); onBeforeSend?.(); onSend(mentions); } };
  const showStop = running && !draft.length && !editorHasContent && !imeComposing && !attachments.length && !pending;
  const actionLabel = stopping ? "Stopping responses" : showStop ? "Stop all responses in this chat" : pending?.sending ? "Sending message" : pending?.error ? "Retry sending message" : thread ? "Send reply" : "Send message";
  const stop = () => {
    if (!showStop || stopping || disabled) return;
    setStopping(true); setStopError(undefined);
    void api<ChatSnapshot>(`/api/chats/${encodeURIComponent(chatId)}/stop`, {}).then(onSnapshot).catch(error => setStopError(errorMessage(error))).finally(() => setStopping(false));
  };
  return <div className="composer-area">
    {pending?.sending ? <div className="pending-message">
      <p className="run-outcome" role="status"><Spinner /> Sending…</p>
      {pending.text ? <div className="pending-message-text">{pending.text}</div> : null}
      {attachments.length ? <DraftAttachments attachments={attachments} disabled onRemoveAttachment={onRemoveAttachment} onRetryAttachment={onRetryAttachment} /> : null}
    </div> : null}
    {pending?.error ? <Notice>{pending.error} Your message is kept here. Retry sends the same message once.</Notice> : error ? <Notice>{error}</Notice> : null}
    {stopError ? <Notice>{stopError}</Notice> : null}
    {attachmentError ? <Notice>{attachmentError}</Notice> : null}
    {tooLong ? <Notice>Shorten your message to 100,000 characters or fewer, including Markdown formatting.</Notice> : null}
    {composing.unavailable ? <p className="run-outcome" role="status">Typing status is unavailable. You can still send your message.</p> : null}
    <form className="composer" onInput={composing.pulse} onCompositionStart={() => { setImeComposing(true); composing.pulse(); }} onCompositionEnd={() => setImeComposing(false)} onCompositionUpdate={composing.pulse} onPaste={composing.pulse} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) composing.clear(); }} onSubmit={event => { event.preventDefault(); send(); }}>
      {!pending?.sending ? <DraftAttachments attachments={attachments} disabled={disabled} onRemoveAttachment={onRemoveAttachment} onRetryAttachment={onRetryAttachment} /> : null}
      <MarkdownComposer onPasteFiles={addFiles} id={id} value={draft} disabled={disabled} readOnly={Boolean(pending?.sending)} onChange={onDraftChange} onContentPresenceChange={setEditorHasContent} onSend={send}
        instanceChoices={agents.filter(agent => !agent.archived && !participants.some(person => person.kind === "agent" && person.membership === "removing" && person.agentDefinitionId === agent.id) && participants.some(person => person.kind === "agent" && person.membership === "active" && person.agentDefinitionId === agent.id)).map(agent => ({ id: agent.id, name: agent.name, kind: "agent" as const }))} onAddInstance={onAddInstance} participants={mentionPeople} mentions={mentions} onMentionsChange={onMentionsChange} placeholder={thread ? "Reply to thread…" : conversationTitle ? `Message ${conversationTitle}…` : "Message chat…"}
        toolbar={<><AttachmentPicker disabled={disabled || Boolean(pending?.sending)} onAddFiles={addFiles} /><div className="button-row"><Button type={showStop ? "button" : "submit"} className="send-button" disabled={disabled || stopping || (showStop ? false : !canSend)} aria-label={actionLabel} title={actionLabel} onClick={showStop ? stop : undefined}>{stopping ? <Spinner label="Stopping responses" /> : pending?.sending ? <Spinner label="Sending message" /> : showStop ? <Square className="composer-stop-icon" fill="currentColor" aria-hidden="true" /> : pending?.error ? <RotateCcw aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}</Button></div></>}
      />
    </form>
    {thread ? <p className="thread-visibility"><LockKeyhole size={12} /> Replies are visible to everyone in this chat.</p> : null}
  </div>;
}

export function SharedContextPanel({ criteriaDraft, onCriteriaDraft, snapshot, agents, models, threadId, onInvite, onAddInstance, onSnapshot, onClose, showHeader = true, attachments, onAddFiles, onRemoveAttachment, onRetryAttachment }: AttachmentComposerProps & {
  criteriaDraft?: CriteriaDraft; onCriteriaDraft: (draft: CriteriaDraft | undefined) => void;
  snapshot: ChatSnapshot; agents: AgentDefinition[]; models: ApplicationConfig["models"]; threadId: string | null;
  onInvite: () => void; onAddInstance: OpenInstanceForm; onSnapshot: (snapshot: ChatSnapshot) => void; onClose: () => void; showHeader?: boolean;
}) {
  const { state } = useSession();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const participant = snapshot.participants.find(member => member.id === selectedId);
  useEffect(() => { setSelectedId(null); }, [snapshot.conversation.id, threadId]);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => { atBottom.current = true; }, [threadId]);
  useEffect(() => { if (atBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [snapshot, threadId]);
  return <div tabIndex={-1} aria-label={threadId ? "Thread" : "Participants"} className={`shared-context ${threadId ? "thread-context" : "participants-context"}`}>
    {showHeader ? <header className="context-header"><h2>{threadId ? "Thread" : "Participants"}</h2><IconButton label={threadId ? "Close thread" : "Close participants"} onClick={onClose}><X size={18} /></IconButton></header> : null}
    {threadId ? <>
      <div className="thread-transcript" ref={scroller} onScroll={event => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        
        <SharedTranscript snapshot={snapshot} threadId={threadId} />
        <ConversationPresence participants={snapshot.participants} />
      </div>
      <ConversationComposer key={`${snapshot.conversation.id}:${threadId}`} attachments={attachments} onAddFiles={onAddFiles} onRemoveAttachment={onRemoveAttachment} onRetryAttachment={onRetryAttachment} id={`thread-${snapshot.conversation.id}-${threadId}`} chatId={snapshot.conversation.id} threadId={threadId} participants={snapshot.participants} agents={agents} onAddInstance={onAddInstance} disabled={snapshot.conversation.canParticipate === false} thread running={snapshot.conversation.status === "running"} onSnapshot={onSnapshot} />
    </> : <div className="participants-body">
      <DefinitionOfDone snapshot={snapshot} draft={criteriaDraft} onDraft={onCriteriaDraft} onSnapshot={onSnapshot} />
      <Button className="invite-participants" variant="secondary" disabled={snapshot.conversation.canParticipate === false} onClick={onInvite}><UserPlus size={18} /> Add participants</Button>
      <Button variant="secondary" disabled={snapshot.conversation.canParticipate === false || !agents.some(agent => !agent.archived)} onClick={() => onAddInstance()}><UserPlus size={18} /> Add agent instance</Button>
      <div className="participant-list">{snapshot.participants.map(member => <button type="button" className={`participant-row ${participant?.id === member.id ? "selected" : ""}`} key={member.id} onClick={() => setSelectedId(member.id)} aria-pressed={participant?.id === member.id}>
        <ParticipantAvatar kind={member.kind} name={member.name} /><span className="participant-choice-copy"><strong>{mentionLabel(member, snapshot.participants)}</strong><span>{member.kind === "agent" ? `Agent · ${agentStatus(member)}` : member.membership === "removed" ? "Former member" : `${state?.state === "authenticated" && state.user.id === member.userId ? "You" : "Person"}${member.status === "typing" ? " · Typing" : ""}`}</span></span>
      </button>)}</div>
      <p className="history-access"><LockKeyhole size={14} /> {snapshot.conversation.sharedProjectId ? "Current project members can read the full history. Listed authors may include former members." : "Active participants can read the full public history."}</p>
      {participant ? <section className="participant-details">
        <h3>{mentionLabel(participant, snapshot.participants)}</h3>
        {participant.kind === "agent" ? <>
          <AgentRemoval key={`${snapshot.conversation.id}:${participant.id}`} participant={participant} chatId={snapshot.conversation.id} canParticipate={snapshot.conversation.canParticipate !== false} onSnapshot={onSnapshot} />
          <dl className="context-facts"><div><dt>Base revision applied</dt><dd>{participant.agent.name} · {participant.agentRevision}</dd></div><div><dt>Model</dt><dd>{models.find(model => model.id === participant.agent.modelId && model.provider === participant.agent.provider)?.name || participant.agent.modelId}</dd></div><div><dt>Provider</dt><dd>{participant.agent.provider}</dd></div><div><dt>Thinking</dt><dd>{participant.agent.thinkingLevel}</dd></div><div><dt>Tools</dt><dd>{describeAgentTools(participant.agent.tools)}</dd></div>{participant.agent.cwd ? <div><dt>Local workspace</dt><dd>{participant.agent.cwd}</dd></div> : null}</dl>
          {participant.savedAgentRevision !== undefined && participant.savedAgentRevision !== participant.agentRevision ? <p role="status">Base revision {participant.savedAgentRevision} saved · Pending</p> : null}
          {participant.upgradeError ? <Notice>{participant.upgradeError}</Notice> : null}
          <details><summary>Instance connections{participant.connectionsPending ? " · Pending update" : ""}</summary>{participant.agent.connections?.length ? <ul>{participant.agent.connections.map(connection => <li key={connection.id}>{connection.name}</li>)}</ul> : <p>No connections.</p>}</details>
          {participant.error ? <Notice>{participant.error}</Notice> : null}
          <details><summary>Base instructions</summary><Markdown>{participant.agent.instructions || "No base instructions."}</Markdown></details>
          <details><summary>Instance instructions</summary><Markdown>{participant.instanceInstructions || "No additional instructions."}</Markdown></details>
          {snapshot.conversation.canParticipate !== false && agents.some(agent => agent.id === participant.agentDefinitionId && !agent.archived) && !snapshot.participants.some(person => person.kind === "agent" && person.agentDefinitionId === participant.agentDefinitionId && person.membership === "removing") ? <Button variant="secondary" onClick={() => onAddInstance(participant.agentDefinitionId)}>Add another instance</Button> : null}
          <ParticipantRunDetails participant={participant} activities={snapshot.activities} />
          <p>Coding tools use the service machine’s access. This workspace is not a sandbox.</p>
        </> : <p>Human participant since {new Date(participant.joinedAt).toLocaleDateString()}.</p>}
        <details><summary>Participant identity</summary><p className="identity-value">{participant.id}</p></details>
      </section> : <p className="participant-hint">Select a participant to see their details.</p>}
    </div>}
  </div>;
}

function AgentRemoval({ participant, chatId, canParticipate, onSnapshot }: {
  participant: AgentParticipant; chatId: string; canParticipate: boolean; onSnapshot: (snapshot: ChatSnapshot) => void;
}) {
  const { api } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = participant.membership === "removing" && Boolean(participant.removalError);
  async function remove() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      onSnapshot(await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(chatId)}/participants/${encodeURIComponent(participant.id)}/remove`, {}));
      setConfirming(false);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <>
    <p role="status">{agentStatus(participant)}</p>
    {participant.removalError ? <Notice>{participant.removalError}</Notice> : null}
    {canParticipate && (participant.membership === "active" || retry) ? <Button variant="danger" disabled={busy} onClick={() => setConfirming(true)}>{retry ? "Retry removal" : "Remove from chat"}</Button> : null}
    <Modal title={retry ? `Retry removing ${participant.name}?` : `Remove ${participant.name}?`} description="Stops this instance. Its history stays." open={confirming} onOpenChange={open => { if (!busy) setConfirming(open); }}>
      <p>Completed file changes and external actions cannot be undone.</p>
      {error ? <Notice>{error}</Notice> : null}
      <div className="button-row"><Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button><Button variant="danger" disabled={busy || !canParticipate || participant.membership === "removed"} onClick={() => void remove()}>{busy ? <Spinner label="Removing agent" /> : null}{retry ? "Retry removal" : "Remove"}</Button></div>
    </Modal>
  </>;
}

function ParticipantRunDetails({ participant, activities }: { participant: AgentParticipant; activities: ParticipantActivity[] }) {
  const models = Object.entries(participant.usage.models);
  const tokens = models.reduce((sum, [, usage]) => sum + usage.totalTokens, 0);
  const cost = models.reduce((sum, [, usage]) => sum + usage.cost.total, 0);
  const submissions = [...new Map(activities.filter(activity => activity.participantId === participant.id).flatMap(activity => activity.submissions).map(submission => [submission.id, submission])).values()];
  return <details className="participant-run">
    <summary>Run &amp; usage</summary>
    <p>{participant.name} · {agentStatus(participant)}</p>
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
  const joinedDefinitionIds = snapshot.participants.filter((member): member is AgentParticipant => member.kind === "agent" && member.membership !== "removed").map(member => member.agentDefinitionId);
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
      <p className="history-access"><LockKeyhole size={15} /> {snapshot.conversation.sharedProjectId ? "Add people through project settings. New agent participants can read the full project chat history." : "New participants can read the full chat history."}</p>
      {error ? <Notice>{error} You can retry this invitation.</Notice> : null}
      <footer className="picker-actions"><span>{selected} selected</span><div className="button-row"><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || !selected} onClick={() => void invite()}>{busy ? <Spinner /> : <UserPlus size={16} />} Add {selected === 1 ? "participant" : "participants"}</Button></div></footer>
    </div>
  </Modal>;
}
