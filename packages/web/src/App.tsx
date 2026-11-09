import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Menu, Plus, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import type { Agent, Chat, Snapshot, SourceStatus } from '@/lib/contracts';

import { api, isDefiniteRejection } from '@/lib/api';
interface Pending { chatId: string; text: string; requestId: string }
const route = (id: string) => `/api/chats/${encodeURIComponent(id)}`;
export default function App() {
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [agent, setAgent] = useState('');
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('dispatch-web:selected'));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState('Connecting…');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('dispatch-web:pending') ?? 'null')?.text ?? ''; } catch { return ''; }
  });
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pending, setPending] = useState<Pending | null>(() => {
    try { return JSON.parse(sessionStorage.getItem('dispatch-web:pending') ?? 'null'); } catch { return null; }
  });
  const [navigation, setNavigation] = useState(false);
  const [ready, setReady] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const returnFocus = useRef(false);
  const [sendCompleted, setSendCompleted] = useState(0);
  useEffect(() => {
    const cancel = () => { returnFocus.current = false; };
    const moved = (event: FocusEvent) => {
      if (event.target !== composer.current && event.target !== document.body) cancel();
    };
    // Disabling the textarea may move focus to BODY. An intentional click, tab
    // to another control, or leaving the window instead relinquishes our intent.
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', moved, true);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', moved, true);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  useEffect(() => {
    if (sending) return;
    const restore = returnFocus.current;
    returnFocus.current = false;
    if (restore && !pending && document.hasFocus() &&
      (document.activeElement === document.body || document.activeElement === composer.current)) {
      composer.current?.focus();
    }
  }, [sending, pending, sendCompleted]);
  const refresh = useCallback(async () => {
    try {
      const [available, history, configured] = await Promise.all([api<Agent[]>('/api/agents'), api<Chat[]>('/api/chats'), api<SourceStatus[]>('/api/sources')]);
      setSources(configured);
      setAgents(available); setChats(history); setReady(true);
      setAgent(current => available.some(a => a.id === current) ? current : available[0]?.id ?? '');
    } catch (failure) { setError((failure as Error).message); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!selected) { localStorage.removeItem('dispatch-web:selected'); setSnapshot(null); setConnection(''); return; }
    localStorage.setItem('dispatch-web:selected', selected); setSnapshot(null); setConnection('Connecting…');
    let active = true;
    const events = new EventSource(`${route(selected)}/events`);
    events.addEventListener('snapshot', event => {
      if (!active) return;
      const value = JSON.parse((event as MessageEvent).data) as Snapshot;
      setSnapshot(value); setAgent(value.chat.agent); setConnection('Connected');
      setChats(current => [value.chat, ...current.filter(chat => chat.id !== value.chat.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    });
    events.addEventListener('failure', () => { if (active) setConnection('Observation interrupted. Reconnecting…'); });
    events.onerror = () => { if (active) setConnection('Disconnected. Reconnecting to saved history…'); };
    // A missing saved selection is actionable; EventSource does not expose HTTP errors.
    void api<Snapshot>(route(selected)).catch(failure => { if (active) setError((failure as Error).message); });
    return () => { active = false; events.close(); };
  }, [selected]);
  async function deliver(value: Pending) {
    // Existing pending state is already uncertain. Never discard its identity on
    // a later ownership/validation rejection: an earlier owner may have admitted.
    const previouslyUncertain = pending?.requestId === value.requestId;
    setSending(true); setError('');
    try {
      sessionStorage.setItem('dispatch-web:pending', JSON.stringify(value));
      await api(`${route(value.chatId)}/messages`, { text: value.text, requestId: value.requestId });
      sessionStorage.removeItem('dispatch-web:pending');
      setPending(null); setDraft(''); void refresh();
    } catch (failure) {
      if (isDefiniteRejection(failure, previouslyUncertain)) {
        sessionStorage.removeItem('dispatch-web:pending');
        setPending(null); setDraft(value.text);
        setError(`${failure.message} Message was not admitted. Edit it or choose another conversation.`);
      } else {
        setPending(value);
        setError(`${(failure as Error).message} Delivery is uncertain. Use Retry message to check or resend it safely.`);
      }
    }
    finally { setSending(false); }
  }
  async function send() {
    if (sending || !draft.trim() || pending) return;
    returnFocus.current = document.activeElement === composer.current;
    setSending(true); setError('');
    try {
      const requestId = crypto.randomUUID();
      let id = selected;
      if (!id) {
        const chat = await api<Chat>('/api/chats', { agent, key: crypto.randomUUID() });
        id = chat.id; setSelected(id); setChats(current => [chat, ...current]);
      }
      await deliver({ chatId: id, text: draft, requestId });
    } catch (failure) { setError((failure as Error).message); }
    finally { setSending(false); setSendCompleted(value => value + 1); }
  }
  async function stop() {
    if (!selected) return;
    setStopping(true); setError('');
    try { await api(`${route(selected)}/stop`, {}); }
    catch (failure) { setError((failure as Error).message); }
    finally { setStopping(false); }
  }
  function choose(id: string | null) { setSelected(id); setError(''); setNavigation(false); composer.current?.focus(); }
  const busy = !!snapshot && (snapshot.running || snapshot.background || snapshot.queued > 0 || snapshot.tools.length > 0);
  const title = snapshot?.chat.title ?? chats.find(chat => chat.id === selected)?.title ?? 'New conversation';
  const activity = snapshot?.observation ?? (snapshot?.retry ? `Retry ${snapshot.retry.attempt} scheduled for ${new Date(snapshot.retry.at).toLocaleTimeString()}` : snapshot?.tools.length ? `Using ${snapshot.tools.join(', ')}` : snapshot?.background ? 'Working in the background' : snapshot?.running ? 'Replying…' : snapshot?.queued ? 'Follow-up queued' : '');
  return <div className="app-shell">
    {navigation && <button className="nav-scrim" aria-label="Close conversation navigation" onClick={() => setNavigation(false)}/>}
    <aside className={navigation ? 'sidebar open' : 'sidebar'} aria-label="Conversations">
      <div className="sidebar-heading"><strong>Web</strong><Button variant="ghost" size="icon" className="mobile-only" aria-label="Close navigation" onClick={() => setNavigation(false)}><X/></Button></div>
      <Button variant="outline" className="new-chat" disabled={sending || !!pending} onClick={() => choose(null)}><Plus/> New conversation</Button>
      <nav aria-label="Saved conversations">
        {!ready && <p className="nav-note">Loading conversations…</p>}
        {ready && !chats.length && <p className="nav-note">Your conversations will appear here.</p>}
        {chats.map(chat => <button key={chat.id} className={`chat-item ${selected === chat.id ? 'selected' : ''}`} aria-current={selected === chat.id ? 'page' : undefined} disabled={sending || !!pending} onClick={() => choose(chat.id)}><span>{chat.title}</span><small>{chat.agent} · {chat.sourceLabel ?? chat.source} · {chat.session}{chat.parentId ? ' · child' : ''}</small></button>)}
      </nav>
      <div className="sidebar-footer">Configured native stores{sources.flatMap(source => source.issues.map((issue, index) => <p key={`${source.id}:${index}`} role="status">{source.label}: {issue}</p>))}</div>
    </aside>
    <main>
      <header><Button variant="ghost" size="icon" className="mobile-only" aria-label="Open conversations" onClick={() => setNavigation(true)}><Menu/></Button><h1 title={title}>{title}</h1><span className="agent-name">{selected ? snapshot?.chat.agent ?? agent : 'Local'}</span></header>
      {!selected && <div className="agent-picker"><label htmlFor="agent">Agent</label><select id="agent" value={agent} disabled={!ready || sending} onChange={event => setAgent(event.target.value)}>{agents.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select><p>{agents.find(item => item.id === agent)?.description}</p></div>}
      <Conversation key={selected ?? 'new'} className="conversation" aria-label="Message history" aria-busy={snapshot?.running ?? false}>
        <ConversationContent className="message-list">
          {(!selected || snapshot && !snapshot.messages.length && !snapshot.partial) && <ConversationEmptyState title={selected ? `Message ${snapshot?.chat.agent}` : `What can ${agent || 'your agent'} help with?`} description="Same agents, tools and skills. A fresh conversation."/>}
          {selected && !snapshot && <p className="empty-loading">{connection}</p>}
          {snapshot?.messages.filter(message => message.provenance !== 'runtime').map(message => <Message key={message.id} from={message.provenance === 'user' ? 'user' : 'assistant'}><span className="message-author">{message.provenance === 'user' ? 'You' : message.author ?? snapshot.chat.agent}{message.background ? ' · background' : ''}</span><MessageContent>{message.commentary && <p className="commentary">{message.commentary}</p>}<MessageResponse>{message.text}</MessageResponse>{message.error && <p className="message-error">{message.error}</p>}{message.artifacts?.map(artifact => <a key={artifact.id} className="artifact-link" href={`${route(selected!)}/artifacts/${encodeURIComponent(artifact.id)}`}>Download {artifact.name}</a>)}</MessageContent></Message>)}
          {snapshot?.partial && <Message from="assistant"><span className="message-author">{snapshot.chat.agent}</span><MessageContent><MessageResponse>{snapshot.partial}</MessageResponse></MessageContent></Message>}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message"/>
      </Conversation>
      <div className="composer-region">
        <div className="activity" role="status"><span>{activity || (selected ? connection === 'Connected' ? <><Check size={12}/> Saved</> : connection : '')}{snapshot?.queued ? ` · ${snapshot.queued} queued` : ''}</span>{busy && <Button variant="outline" size="sm" disabled={stopping} onClick={() => void stop()}><Square size={12}/>{stopping ? 'Stopping…' : 'Stop all work'}</Button>}</div>
        {snapshot?.readOnlyReason && <p className="pending-note" role="status">{snapshot.readOnlyReason}</p>}
        {(error || snapshot?.error) && <div className="error-banner" role="alert"><p>{error || snapshot?.error}</p>{!ready && <Button variant="outline" size="sm" onClick={() => { setError(''); void refresh(); }}>Reconnect</Button>}{pending && <Button size="sm" disabled={sending} onClick={() => void deliver(pending)}>Retry message</Button>}<Button variant="ghost" size="icon" aria-label="Dismiss error" onClick={() => setError('')}><X/></Button></div>}
        {pending && <div className="pending-note">Message delivery is uncertain. Your text is preserved. <Button variant="outline" size="sm" disabled={sending} onClick={() => { setSelected(pending.chatId); void deliver(pending); }}>Retry message</Button></div>}
        <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}><textarea ref={composer} aria-label="Message" placeholder={busy ? 'Send a follow-up…' : `Message ${agent || 'agent'}…`} rows={2} value={draft} disabled={sending || !!pending} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><Button type="submit" size="icon" aria-label={sending ? 'Sending message' : 'Send message'} disabled={!draft.trim() || sending || !ready || !!pending}><ArrowUp/></Button></form>
        <p className="composer-hint">Enter to send · Shift+Enter for a new line{busy ? ' · Follow-ups wait for current work' : ''}</p>
      </div>
    </main>
  </div>;
}
