import { ArrowDown, RotateCcw, Square, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatSnapshot } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { chatStatusLabel, type ConnectionState, type PendingMessage } from "../lib/chat";
import { useSession } from "../lib/session";
import { Brand } from "./brand";
import { ConversationComposer, ConversationPresence, SharedTranscript } from "./shared-conversation";
import { Button, Notice, Spinner } from "./ui";

interface ChatPanelProps {
  chatId: string;
  active: boolean;
  connection: ConnectionState;
  snapshot?: ChatSnapshot;
  draft: string;
  pending?: PendingMessage;
  sendError?: string;
  onDraftChange: (text: string) => void;
  mentions: string[];
  onMentionsChange: (ids: string[]) => void;
  onSend: (mentions: string[]) => void;
  onParticipants: () => void;
  onThread: (id: string) => void;
  onSnapshot: (snapshot: ChatSnapshot) => void;
  onConnection: (chatId: string, state: ConnectionState) => void;
}

export function ChatPanel({ active: visible, connection, chatId, snapshot, draft, pending, sendError, mentions, onMentionsChange, onDraftChange, onSend, onParticipants, onThread, onSnapshot, onConnection }: ChatPanelProps) {
  const { api, refreshSession } = useSession();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const scrollPosition = useRef(0);

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

  const running = snapshot?.conversation.status === "running";
  const hasMessages = Boolean(snapshot?.messages.length);

  function scrollToLatest() {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    atBottom.current = true;
    setShowLatest(false);
  }

  function sendDraft(mentions: string[]) {
    scrollToLatest();
    onSend(mentions);
  }

  return <div className="chat-panel">
    <header className="view-heading">
      <div>
        <h1>{snapshot?.conversation.title || "Conversation"}</h1>
        <p>{snapshot ? "Shared conversation" : "Loading conversation…"}</p>
      </div>
      <div className="conversation-header-actions"><Button variant="secondary" className="participants-button" onClick={onParticipants} disabled={!snapshot}><Users size={16} />{snapshot?.participants.length ?? 0} participants</Button>
      <span className={`status-badge status-${snapshot?.conversation.status || "idle"}`}>{snapshot ? chatStatusLabel(snapshot) : "Loading"}</span></div>
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
        {snapshot ? <SharedTranscript snapshot={snapshot} onThread={onThread} /> : null}
        {snapshot ? <ConversationPresence participants={snapshot.participants} /> : null}
        {snapshot?.conversation.status === "stopped" ? <p className="run-outcome" role="status">
          <Square size={13} /> Response stopped. You can continue the conversation.</p> : null}
        {snapshot?.conversation.status === "failed" ? <Notice>{snapshot.conversation.error || "The response could not be completed. You can send another message to continue."}</Notice> : null}
      </div>
    </div>
    {showLatest ? <div className="latest-row">
      <Button className="latest-button" variant="secondary" onClick={scrollToLatest}>
        <ArrowDown /> Latest messages</Button>
    </div> : null}
    {stopError ? <Notice>{stopError}</Notice> : null}
    <ConversationComposer id={`composer-${chatId}`} chatId={chatId} active={visible} draft={draft} pending={pending} error={sendError} participants={snapshot?.participants ?? []} mentions={mentions} onMentionsChange={onMentionsChange} disabled={!snapshot} onDraftChange={onDraftChange} onSend={sendDraft}>
      {running ? <Button variant="secondary" className="stop-button" disabled={stopping} onClick={() => {
        setStopping(true); setStopError(null);
        void api<ChatSnapshot>(`/api/chats/${encodeURIComponent(chatId)}/stop`, {}).then(onSnapshot).catch(error => setStopError(errorMessage(error))).finally(() => setStopping(false));
      }}>{stopping ? <Spinner /> : <Square />} Stop all</Button> : null}
    </ConversationComposer>
  </div>;
}
