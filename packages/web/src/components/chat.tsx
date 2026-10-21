import { applyChatDelta, type ChatDelta } from "../shared/chat-updates";
import type { OpenInstanceForm } from "./add-instance";
import type { AttachmentComposerProps } from "./composer-attachments";
import { ArrowDown, RotateCcw, Square, Users } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentDefinition, ChatSnapshot } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { chatStatusLabel, type ConnectionState } from "../lib/chat";
import { useSession } from "../lib/session";
import { Brand } from "./brand";
import { ConversationComposer, ConversationPresence, SharedTranscript } from "./shared-conversation";
import { Button, Notice, Spinner } from "./ui";

interface ChatPanelProps extends AttachmentComposerProps {
  chatId: string;
  focusComposer?: boolean;
  onComposerFocused?: () => void;
  agents: AgentDefinition[];
  active: boolean;
  connection: ConnectionState;
  snapshot?: ChatSnapshot;
  activeThreadId?: string | null;
  onParticipants: () => void;
  onAddInstance: OpenInstanceForm;
  onThread: (chatId: string, id: string) => void;
  onSnapshot: (snapshot: ChatSnapshot) => void;
  onAccessLost: (chatId: string) => void;
  onConnection: (chatId: string, state: ConnectionState) => void;
}

export function ChatPanel({ focusComposer, onComposerFocused, agents, active: visible, connection, chatId, snapshot, activeThreadId, onParticipants, onAddInstance, onThread, onSnapshot, onConnection, onAccessLost, attachments, onAddFiles, onRemoveAttachment, onRetryAttachment }: ChatPanelProps) {
  const { api, refreshSession } = useSession();
  const openThread = useCallback((id: string) => onThread(chatId, id), [chatId, onThread]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showLatest, setShowLatest] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const scrollPosition = useRef(0);

  useEffect(() => {
    if (!focusComposer || !visible || !snapshot || snapshot.conversation.canParticipate === false) return;
    document.getElementById(`composer-${chatId}`)?.focus();
    onComposerFocused?.();
  }, [focusComposer, visible, snapshot, chatId, onComposerFocused]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let stream: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    let active = true;
    const path = `/api/chats/${encodeURIComponent(chatId)}`;

    function closeStream() {
      stream?.close();
      stream = null;
    }
    function reconnect() {
      closeStream();
      if (!active || retryTimer !== undefined) return;
      onConnection(chatId, "reconnecting");
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    }
    function failed(error: unknown) {
      if (!active) return;
      if (!(error instanceof ApiError) || error.status >= 500 || [0, 408, 429].includes(error.status)) {
        reconnect();
        return;
      }
      if (error instanceof ApiError && [403, 404].includes(error.status)) onAccessLost(chatId);
      setLoadError(errorMessage(error));
      onConnection(chatId, "error");
    }
    async function connect() {
      try {
        const initial = await api<ChatSnapshot>(path, undefined, controller.signal);
        if (!active) return;
        onSnapshot(initial);
        const source = new EventSource(`${path}/events`);
        stream = source;
        let delivered: ChatSnapshot | undefined;
        source.addEventListener("snapshot", event => {
          if (!active || stream !== source) return;
          try {
            const next = JSON.parse((event as MessageEvent<string>).data) as ChatSnapshot;
            if (next.conversation.id !== chatId) return;
            delivered = next;
            onSnapshot(next);
            retryDelay = 1_000;
            onConnection(chatId, "connected");
            setLoadError(null);
          } catch {
            closeStream();
            setLoadError("An update could not be read. Reconnect to restore the chat.");
            onConnection(chatId, "error");
          }
        });
        source.addEventListener("delta", event => {
          if (!active || stream !== source) return;
          try {
            if (!delivered) throw new Error("Missing initial snapshot");
            delivered = applyChatDelta(delivered, JSON.parse((event as MessageEvent<string>).data) as ChatDelta);
            onSnapshot(delivered);
          } catch {
            reconnect();
          }
        });
        source.addEventListener("session-ended", () => {
          if (!active || stream !== source) return;
          closeStream();
          // A factor change can replace the cookie before the old stream ends.
          void refreshSession().then(reconnect, failed);
        });
        source.onerror = () => {
          if (!active || stream !== source) return;
          // HTTP errors such as 503 close EventSource permanently; native retry stops.
          reconnect();
          void refreshSession().catch(() => { });
        };
      } catch (error) {
        failed(error);
      }
    }
    onConnection(chatId, "connecting");
    setLoadError(null);
    void connect();
    return () => { active = false; controller.abort(); closeStream(); clearTimeout(retryTimer); };
  }, [visible, chatId, attempt, api, refreshSession, onSnapshot, onConnection, onAccessLost]);

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

  return <div className="chat-panel shared-chat-panel">
    <header className="view-heading">
      <div>
        <h1 title={snapshot?.conversation.title || "Chat"}>{snapshot?.conversation.title || "Chat"}</h1>
        <p>{snapshot ? "Shared chat" : "Loading chat…"}</p>
      </div>
      <div className="conversation-header-actions"><Button variant="secondary" className="participants-button" id={`participants-${chatId}`} onClick={onParticipants} disabled={!snapshot}><Users size={16} />{snapshot?.participants.length ?? 0} participants</Button>
      {snapshot?.conversation.status !== "idle" ? <span className={`status-badge status-${snapshot?.conversation.status || "idle"}`}>{snapshot ? chatStatusLabel(snapshot) : "Loading"}</span> : null}</div>
    </header>
    {connection === "reconnecting" ? <div className="chat-connection-notice">
      <Notice tone="info">Reconnecting to this chat. Updates will appear when the connection returns.</Notice>
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
      setShowLatest(!atBottom.current);
    }}>
      <div className="transcript-inner">
        {!snapshot && !loadError ? <div className="page-state">
          <Spinner label="Loading chat" />
        </div> : null}
        {snapshot && !hasMessages ? <div className="chat-empty">
          <div className="chat-empty-mark">
            <Brand compact />
          </div>
          <h2>What are we working on?</h2>
          <p>Bring a question, a rough idea, or a problem to work through.</p>
        </div> : null}
        {snapshot ? <SharedTranscript snapshot={snapshot} activeThreadId={activeThreadId} onThread={openThread} /> : null}
        {snapshot ? <ConversationPresence participants={snapshot.participants} /> : null}
        {snapshot?.conversation.status === "stopped" ? <p className="run-outcome" role="status">
          <Square size={13} /> Response stopped. You can continue the chat.</p> : null}
        {snapshot?.conversation.status === "failed" ? <Notice>{snapshot.conversation.error || "The response could not be completed. You can send another message to continue."}</Notice> : null}
      </div>
    </div>
    {showLatest ? <div className="latest-row">
      <Button className="latest-button" variant="secondary" onClick={scrollToLatest}>
        <ArrowDown /> Latest messages</Button>
    </div> : null}
    <ConversationComposer key={chatId} attachments={attachments} onAddFiles={onAddFiles} onRemoveAttachment={onRemoveAttachment} onRetryAttachment={onRetryAttachment} id={`composer-${chatId}`} conversationTitle={snapshot?.conversation.title} chatId={chatId} active={visible} agents={agents} participants={snapshot?.participants ?? []} disabled={!snapshot || snapshot.conversation.canParticipate === false} onBeforeSend={scrollToLatest} onAddInstance={onAddInstance} running={running} onSnapshot={onSnapshot} />
  </div>;
}
