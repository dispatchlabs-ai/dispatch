import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { ArrowDown, ArrowUp, Check, Copy, MessageSquare, RotateCcw, Square, Wrench } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatSnapshot } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { chatLive, statusLabels, type ConnectionState, type PendingMessage } from "../lib/chat";
import { useSession } from "../lib/session";
import { Brand } from "./brand";
import { Markdown } from "./markdown";
import { Button, IconButton, Notice, Spinner } from "./ui";

interface ChatPanelProps {
  chatId: string;
  active: boolean;
  connection: ConnectionState;
  snapshot?: ChatSnapshot;
  draft: string;
  pending?: PendingMessage;
  sendError?: string;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onSnapshot: (snapshot: ChatSnapshot) => void;
  onConnection: (chatId: string, state: ConnectionState) => void;
}

export function ChatPanel({ active: visible, connection, chatId, snapshot, draft, pending, sendError, onDraftChange, onSend, onSnapshot, onConnection }: ChatPanelProps) {
  const { api, refreshSession } = useSession();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const scrollPosition = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let stream: EventSource | null = null;
    let active = true;
    onConnection(chatId, "connecting");
    setLoadError(null);
    api<ChatSnapshot>(`/api/chats/${encodeURIComponent(chatId)}`, undefined, controller.signal).then(initial => {
      if (!active) return;
      onSnapshot(initial);
      stream = new EventSource(`/api/chats/${encodeURIComponent(chatId)}/events`);
      stream.addEventListener("snapshot", event => {
        if (!active) return;
        try {
          const next = JSON.parse((event as MessageEvent<string>).data) as ChatSnapshot;
          if (next.conversation.id !== chatId) return;
          onSnapshot(next);
          onConnection(chatId, "connected");
          setLoadError(null);
        } catch {
          setLoadError("An update could not be read. Reconnect to restore the conversation.");
          onConnection(chatId, "error");
        }
      });
      stream.addEventListener("session-ended", () => {
        stream?.close();
        if (!active) return;
        void refreshSession().catch(() => { });
      });
      stream.onerror = () => {
        if (!active) return;
        onConnection(chatId, "reconnecting");
        void refreshSession().catch(() => { });
      };
    }).catch(error => {
      if (!active) return;
      setLoadError(errorMessage(error));
      onConnection(chatId, "error");
    });
    return () => { active = false; controller.abort(); stream?.close(); };
  }, [visible, chatId, attempt, api, refreshSession, onSnapshot, onConnection]);

  useLayoutEffect(() => {
    if (!visible) return;
    const element = transcript.current;
    if (!element) return;
    element.scrollTop = atBottom.current ? element.scrollHeight : scrollPosition.current;
    if (!atBottom.current && snapshot) setShowLatest(true);
  }, [snapshot, visible]);

  useEffect(() => {
    if (!visible || !textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${Math.min(textarea.current.scrollHeight, 180)}px`;
  }, [draft, visible]);

  const live = snapshot ? chatLive(snapshot) : {};
  const agentName = snapshot?.conversation.agentName || "Agent";
  const running = snapshot?.conversation.status === "running";
  const entries = snapshot?.view.entries || [];
  const initialSetupId = entries.find(entry => entry.model?.some(message => message.role === "system"))?.id;
  const hasMessages = entries.some(entry => entry.model?.some(message => message.role === "user" || message.role === "assistant"));

  function scrollToLatest() {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    atBottom.current = true;
    setShowLatest(false);
  }

  return <div className="chat-panel">
    <header className="chat-heading">
      <div>
        <h1>{snapshot?.conversation.title || "Conversation"}</h1>
        <p>{snapshot ? agentName : "Loading agent…"}</p>
      </div>
      <span className={`status-badge status-${snapshot?.conversation.status || "idle"}`}>{snapshot ? statusLabels[snapshot.conversation.status] : "Loading"}</span>
    </header>
    {connection === "reconnecting" ? <div className="chat-connection-notice">
      <Notice tone="info">Reconnecting to this conversation. Agent work continues; updates will appear when the connection returns.</Notice>
    </div> : null}
        {loadError ? <div className="chat-load-error">
          <Notice>{loadError}</Notice>
          <Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>
            <RotateCcw /> Reconnect</Button>
        </div> : null}
    <div className="transcript" ref={transcript} onScroll={() => {
      const element = transcript.current;
      if (!visible || !element) return;
      scrollPosition.current = element.scrollTop;
      atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      if (atBottom.current) setShowLatest(false);
    }}>
      <div className="transcript-inner">
        {!snapshot && !loadError ? <div className="page-state">
          <Spinner label="Loading conversation" />
        </div> : null}
        {snapshot && !hasMessages ? <div className="chat-empty">
          <div className="chat-empty-mark">
            <Brand compact />
          </div>
          <h2>What are we working on?</h2>
          <p>Bring a question, a rough idea, or a problem to work through.</p>
        </div> : null}
        {entries.map(entry => <TranscriptEntry key={entry.id} entry={entry} agentName={agentName} initialSetup={entry.id === initialSetupId} />)}
        {live.generation?.message ? <TranscriptMessage message={live.generation.message as Message} agentName={agentName} streaming /> : null}
        {live.tools?.filter(tool => tool.status !== "done").map(tool => <details className="tool-entry" key={tool.callId}>
          <summary>
            <Wrench size={15} /> {tool.name} <span>{tool.status === "running" ? "Working" : "Waiting"}</span>
          </summary>{tool.output ? <details>
            <summary>Technical details</summary>
            <pre>{tool.output}</pre>
          </details> : <p>The tool is working.</p>}</details>)}
        {running && !live.generation?.message && !live.tools?.some(tool => tool.status !== "done") ? <div className="agent-working" role="status">
          <Spinner label="Agent is working" />
          <span>{live.generation?.retry ? "Retrying the response…" : "Working on your response…"}</span>
        </div> : null}
        {snapshot?.conversation.status === "stopped" ? <p className="run-outcome" role="status">
          <Square size={13} /> Response stopped. You can continue the conversation.</p> : null}
        {snapshot?.conversation.status === "failed" ? <Notice>{snapshot.conversation.error || "The response could not be completed. You can send another message to continue."}</Notice> : null}
      </div>
    </div>
    {showLatest ? <div className="latest-row">
      <Button className="latest-button" variant="secondary" onClick={scrollToLatest}>
        <ArrowDown /> Latest messages</Button>
    </div> : null}
    <div className="composer-area">
      {pending?.error ? <Notice>{pending.error} Your message is kept here. Retry sends the same message once.</Notice> : sendError ? <Notice>{sendError}</Notice> : null}
      {stopError ? <Notice>{stopError}</Notice> : null}
      <form className="composer" onSubmit={event => { event.preventDefault(); scrollToLatest(); onSend(); }}>
        <label className="sr-only" htmlFor={`composer-${chatId}`}>Message your agent</label>
        <textarea ref={textarea} id={`composer-${chatId}`} value={draft} maxLength={100000} onChange={event => onDraftChange(event.target.value)} placeholder="Message your agent…" rows={2} readOnly={pending?.sending} disabled={!snapshot} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) { event.preventDefault(); if (draft.trim() && !pending?.sending) { scrollToLatest(); onSend(); } }
        }} />
        <div className="composer-toolbar">
          <span>{pending?.sending ? "Sending…" : running ? "You can send another message while your agent works." : "Your conversations are private to you."}</span>
          <div className="button-row">
            {running ? <Button variant="secondary" className="stop-button" disabled={stopping} onClick={() => {
              setStopping(true); setStopError(null);
              void api<ChatSnapshot>(`/api/chats/${encodeURIComponent(chatId)}/stop`, {}).then(onSnapshot).catch(error => setStopError(errorMessage(error))).finally(() => setStopping(false));
            }}>{stopping ? <Spinner /> : <Square />} Stop</Button> : null}
            <Button type="submit" className="send-button" disabled={!draft.trim() || pending?.sending || !snapshot} aria-label={pending?.error ? "Retry sending message" : "Send message"}>{pending?.sending ? <Spinner label="Sending message" /> : pending?.error ? <RotateCcw /> : <ArrowUp />}</Button>
          </div>
        </div>
      </form>
    </div>
  </div>;
}

function TranscriptEntry({ entry, agentName, initialSetup }: { entry: EntryRecord; agentName: string; initialSetup: boolean }) {
  if (initialSetup && entry.model?.every(message => message.role === "system")) return null;
  if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") {
    return <details className="native-entry">
      <summary>{entry.kind === "pi.reset" ? "Conversation context started" : "Earlier context summarized"}</summary>{entry.model?.map((message, index) => <TranscriptMessage key={index} message={message} agentName={agentName} initialSetup={initialSetup} />)}{entry.data ? <details>
        <summary>Technical details</summary>
        <pre>{JSON.stringify(entry.data, null, 2)}
        </pre>
      </details> : null}
    </details>;
  }
  if (!entry.model?.length) return <details className="native-entry">
    <summary>Conversation event · technical details</summary>
    <pre>{JSON.stringify({ kind: entry.kind, data: entry.data }, null, 2)}
    </pre>
  </details>;
  return <>{entry.model.map((message, index) => <TranscriptMessage key={index} message={message} agentName={agentName} initialSetup={initialSetup} />)}{entry.data && entry.kind !== "pi.tool-result" ? <details className="native-entry">
    <summary>Technical entry details</summary>
    <pre>{JSON.stringify(entry.data, null, 2)}
    </pre>
  </details> : null}
  </>;
}

function TranscriptMessage({ message, agentName, initialSetup = false, streaming = false }: { message: Message; agentName: string; initialSetup?: boolean; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); }, []);
  const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  const text = content.filter(part => part.type === "text").map(part => part.text).join("\n\n");
  if (message.role === "system" && initialSetup) return null;
  if (message.role === "system") return <details className="native-entry">
    <summary>Agent setup changed</summary>{text ? <Markdown>{text}</Markdown> : null}{message.sections ? <details>
      <summary>Technical setup details</summary>
      <pre>{JSON.stringify(message.sections, null, 2)}
      </pre>
    </details> : null}
  </details>;
  if (message.role === "toolResult") return <details className={`tool-entry ${message.isError ? "tool-error" : ""}`}>
    <summary>
      <Wrench size={15} /> {message.toolName}<span>{message.isError ? "Failed" : "Completed"}</span>
    </summary>
    <Markdown>{text}</Markdown>{message.details || message.nestedCalls ? <details>
      <summary>Technical tool details</summary>
      <pre>{JSON.stringify({ details: message.details, nestedCalls: message.nestedCalls }, null, 2)}
      </pre>
    </details> : null}
  </details>;
  return <article className={`message message-${message.role}`} aria-label={message.role === "user" ? "Your message" : "Agent response"}>
    <div className="message-heading">
      <span className="message-avatar">{message.role === "assistant" ? <Brand compact decorative /> : <MessageSquare size={15} />}</span>
      <strong>{message.role === "user" ? "You" : agentName}</strong>{message.timestamp ? <time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
      </time> : null}
    </div>
    <div className="message-content">{content.map((part, index) => {
      if (part.type === "text") return message.role === "user" ? <p className="user-message-text" key={index}>{part.text}</p> : <Markdown key={index}>{part.text}</Markdown>;
      if (part.type === "thinking") return part.redacted ? <p className="thinking-redacted" key={index}>Reasoning is not available.</p> : <details className="thinking-entry" key={index}>
        <summary>{streaming ? "Thinking…" : "Reasoning"}</summary>
        <Markdown>{part.thinking}</Markdown>
      </details>;
      if (part.type === "toolCall") return <details className="tool-entry" key={part.id}>
        <summary>
          <Wrench size={15} /> {part.name}</summary>
        <details>
          <summary>Technical call arguments</summary>
          <pre>{JSON.stringify(part.arguments, null, 2)}
          </pre>
        </details>
      </details>;
      if (part.type === "image") return <img className="message-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="Image attached to the message" />;
      return null;
    })}
      {message.role === "assistant" && message.stopReason === "error" ? <Notice>{message.errorMessage || "This response failed before completing."}</Notice> : null}
      {message.role === "assistant" && message.stopReason === "aborted" ? <p className="run-outcome">This response was stopped.</p> : null}
      {!streaming && text ? <div className="message-actions">
        <IconButton label={copied ? "Copied message" : "Copy message"} onClick={() => {
          void navigator.clipboard.writeText(text).then(() => { setCopied(true); setCopyError(false); copiedTimer.current = window.setTimeout(() => setCopied(false), 2000); }).catch(() => setCopyError(true));
        }}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton>{copyError ? <span role="status">Couldn’t copy. Select the text to copy it.</span> : null}
      </div> : null}
    </div>
  </article>;
}
