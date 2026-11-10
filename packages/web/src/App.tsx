import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Menu, Plus, Square, X, Paperclip, FileText, Search, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import type { Agent, Chat, Snapshot, SourceStatus } from '@/lib/contracts';

import { api, isDefiniteRejection } from '@/lib/api';
import { loadDelivery, saveDelivery, type Pending } from '@/lib/delivery';
import type { AttachmentFile } from '@/lib/contracts';
import { MessageScrollerItem } from '@/components/ui/message-scroller';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { Attachment, AttachmentMedia, AttachmentContent, AttachmentTitle } from '@/components/ui/attachment';
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from '@/components/ui/sidebar';
import { ToolTrace } from '@/components/tool-trace';
const agentName = (id: string) => id.includes('~') ? id.split('~').slice(1).join('~') : id;
const installationName = (id: string) => id.includes('~') ? id.split('~')[0] : 'native';
const sessionName = (chat: Chat, chats: Chat[]) => {
  const session = chat.session ?? '';
  if (!/^web-[a-f0-9]{32,}$/.test(session)) return session;
  let length = 12;
  while (length < session.length && chats.some(other => other.session !== session && other.session?.slice(0, length) === session.slice(0, length))) length++;
  return session.slice(0, length);
};
const route = (id: string) => `/api/chats/${encodeURIComponent(id)}`;
export default function App() {
  const [filter, setFilter] = useState('');
  const [readingFiles, setReadingFiles] = useState(false);
  const [files, setFiles] = useState<AttachmentFile[]>([]);
  const [deliveryReady, setDeliveryReady] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [agent, setAgent] = useState('');
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('dispatch-web:selected') ?? localStorage.getItem('agent-chat:selected'));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState('Connecting…');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('dispatch-web:pending') ?? sessionStorage.getItem('agent-chat:pending') ?? 'null')?.text ?? ''; } catch { return ''; }
  });
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState<{id: string; text: string} | null>(null);
  const [pending, setPending] = useState<Pending | null>(() => {
    try { return JSON.parse(sessionStorage.getItem('dispatch-web:pending') ?? sessionStorage.getItem('agent-chat:pending') ?? 'null'); } catch { return null; }
  });
  useEffect(() => { void loadDelivery().then(value => {if(value){setDraft(value.text);setFiles(value.attachments);setPending(value.pending);if(value.pending)setSelected(value.pending.chatId);}setDeliveryReady(true);}).catch(() => setError('Local draft storage unavailable. Sending is disabled to preserve recovery.')); }, []);
  useEffect(() => { if(deliveryReady) void saveDelivery({text:draft, attachments:files, pending}).catch(() => {setDeliveryReady(false);setError('Cannot retain draft/files locally. Free browser storage before sending.');}); }, [draft, files, pending, deliveryReady]);
  async function selectFiles(list: FileList | null) {
    if (!list) return;
    setReadingFiles(true);
    try {
      const added = await Promise.all(Array.from(list).map(file => new Promise<AttachmentFile>((resolve,reject) => {const reader=new FileReader();reader.onload=()=>resolve({name:file.name,mimeType:file.type,data:String(reader.result).split(',')[1]});reader.onerror=()=>reject(new Error(`Cannot read ${file.name}`));reader.readAsDataURL(file);})));setFiles(current=>{const attachments=[...current,...added];void saveDelivery({text:draft,attachments,pending}).catch(()=>setDeliveryReady(false));return attachments;});
    } catch(failure){setError((failure as Error).message);}
    setReadingFiles(false);
    if(fileInput.current)fileInput.current.value='';
  }
  const [navigation, setNavigation] = useState(false);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 700px)').matches);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = matchMedia('(max-width: 700px)');
    const change = () => { setNarrow(media.matches); setNavigation(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!navigation || !narrow) return;
    const before = document.activeElement as HTMLElement;
    const controls = () => [...sidebar.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select')];
    controls()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setNavigation(false); }
      if (event.key === 'Tab') {
        const items = controls(), first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (sidebar.current?.contains(document.activeElement)) before?.focus(); };
  }, [navigation, narrow]);
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
    if (!selected) { localStorage.removeItem('dispatch-web:selected'); localStorage.removeItem('agent-chat:selected'); setSnapshot(null); setConnection(''); return; }
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
      await saveDelivery({text:value.text,attachments:value.attachments ?? [],pending:value});
      const receipt = await api<{ submissionId: number }>(`${route(value.chatId)}/messages`, { text: value.text, requestId: value.requestId, attachments:value.attachments ?? [] });
      if (!Number.isSafeInteger(receipt?.submissionId) || receipt.submissionId < 1) throw new Error('Invalid admission receipt.');
      await saveDelivery({text:'',attachments:[],pending:null});
      sessionStorage.removeItem('dispatch-web:pending'); sessionStorage.removeItem('agent-chat:pending');
      setPending(null); setDraft(''); setFiles([]); setStopNotice(null); void refresh();
    } catch (failure) {
      if (isDefiniteRejection(failure, previouslyUncertain)) {
        await saveDelivery({text:value.text,attachments:value.attachments ?? [],pending:null});
        sessionStorage.removeItem('dispatch-web:pending'); sessionStorage.removeItem('agent-chat:pending');
        setPending(null); setDraft(value.text); setFiles(value.attachments ?? []);
        setError(`${failure.message} Message was not admitted. Edit it or choose another conversation.`);
      } else {
        setPending(value);
        setError(`${(failure as Error).message} Delivery is uncertain. Use Retry message to check or resend it safely.`);
      }
    }
    finally { setSending(false); }
  }
  async function send() {
    if (sending || (!draft.trim() && !files.length) || pending || !deliveryReady || readingFiles) return;
    returnFocus.current = document.activeElement === composer.current;
    setSending(true); setError('');
    try {
      const requestId = crypto.randomUUID();
      let id = selected;
      if (!id) {
        const chat = await api<Chat>('/api/chats', { agent, key: crypto.randomUUID() });
        id = chat.id; setSelected(id); setChats(current => [chat, ...current]);
      }
      await deliver({ chatId: id, text: draft, requestId, attachments: files });
    } catch (failure) { setError((failure as Error).message); }
    finally { setSending(false); setSendCompleted(value => value + 1); }
  }
  async function stop() {
    if (!selected) return;
    setStopping(true); setError('');
    try { await api(`${route(selected)}/stop`, {}); setStopNotice({id: selected, text: "Stop accepted for this conversation’s work."}); }
    catch (failure) { setError((failure as Error).message); }
    finally { setStopping(false); }
  }
  function choose(id: string | null) { setSelected(id); setError(''); setNavigation(false); composer.current?.focus(); }
  const busy = !!snapshot && (snapshot.running || snapshot.background || snapshot.queued > 0 || snapshot.tools.length > 0);
  const title = snapshot?.chat.title ?? chats.find(chat => chat.id === selected)?.title ?? 'New conversation';
  const lastTurn = snapshot?.turns?.at(-1);
  const turnOutcome = lastTurn?.status === 'unanswered' ? lastTurn.reason === 'aborted' ? 'Stopped · this turn was not completed' : `Not answered (${lastTurn.reason})` : lastTurn?.status === 'done' ? 'Turn completed' : '';
  const activity = snapshot?.observation ?? (snapshot?.retry ? `Retry ${snapshot.retry.attempt} scheduled for ${new Date(snapshot.retry.at).toLocaleTimeString()}` : snapshot?.tools.length ? `Using ${snapshot.tools.join(', ')}` : snapshot?.background ? 'Working in the background' : snapshot?.running ? 'Replying…' : snapshot?.queued ? 'Follow-up queued' : '');
  return <div className="app-shell">
    {navigation && <button className="nav-scrim" aria-label="Close conversation navigation" onClick={() => setNavigation(false)}/>}
    <aside ref={sidebar} inert={narrow && !navigation} className={navigation ? 'sidebar open' : 'sidebar'} aria-label="Conversations">
      <div className="sidebar-heading"><strong>Web</strong><Button variant="ghost" size="icon" className="mobile-only" aria-label="Close navigation" onClick={() => setNavigation(false)}><X/></Button></div>
      <Button variant="outline" className="new-chat" disabled={sending || !!pending} onClick={() => choose(null)}><Plus/> New conversation</Button>
      <label className="history-search"><Search size={14}/><input aria-label="Search conversations" placeholder="Search conversations" value={filter} onChange={event=>setFilter(event.target.value)}/></label><nav aria-label="Saved conversations" data-slot="sidebar-content">
        {!ready && <p className="nav-note">Loading conversations…</p>}
        {ready && !chats.length && <p className="nav-note">Your conversations will appear here.</p>}
        <SidebarMenu>{chats.filter(chat => `${chat.title} ${chat.agent} ${chat.sourceLabel} ${chat.session} ${chat.id}`.toLowerCase().includes(filter.toLowerCase())).map(chat => <SidebarMenuItem key={chat.id}><SidebarMenuButton isActive={selected === chat.id} tooltip={`${chat.agent} · ${chat.source} · ${chat.session ?? ''} · ${chat.id}`} className={`chat-item ${selected === chat.id ? 'selected' : ''}`} aria-current={selected === chat.id ? 'page' : undefined} disabled={sending || !!pending} onClick={() => choose(chat.id)}><span>{chat.title}</span><small>{agentName(chat.agent)} · {installationName(chat.agent)} · {chat.sourceLabel ?? chat.source}</small><small className="chat-identity" title={`${chat.agent} · ${chat.source} · ${chat.session ?? ''} · ${chat.id}`}>{sessionName(chat, chats)} · #{chat.conversationId}{chat.parentId ? ' · child' : ''}</small></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </nav>
      <div className="sidebar-footer">Configured native stores{sources.flatMap(source => source.issues.map((issue, index) => <p key={`${source.id}:${index}`} role="status">{source.label}: {issue}</p>))}</div>
    </aside>
    <main inert={narrow && navigation}>
      <header><Button aria-expanded={navigation} variant="ghost" size="icon" className="mobile-only" aria-label="Open conversations" onClick={() => setNavigation(true)}><Menu/></Button><h1 title={title}>{title}</h1><span className="agent-name">{selected ? agentName(snapshot?.chat.agent ?? agent) : 'Local'}</span></header>
      {!selected && <div className="agent-picker"><label htmlFor="agent">Agent</label><select id="agent" value={agent} disabled={!ready || sending} onChange={event => setAgent(event.target.value)}>{agents.map(item => <option key={item.id} value={item.id}>{agentName(item.id)} · {installationName(item.id)}</option>)}</select><p>{agents.find(item => item.id === agent)?.description}</p></div>}
      <Conversation key={selected ?? 'new'} className="conversation" aria-label="Message history" aria-busy={snapshot?.running ?? false}>
        <ConversationContent className="message-list">
          {(!selected || snapshot && !snapshot.messages.length && !snapshot.partial) && <ConversationEmptyState title={`Message ${agentName(snapshot?.chat.agent ?? agent) || 'an agent'}`} description=""/>}
          {selected && !snapshot && <p className="empty-loading">{connection}</p>}
          {snapshot?.messages.filter(message => message.provenance !== 'runtime').map(message => <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.provenance === 'user'}><Message align={message.provenance === 'user' ? 'end' : 'start'}><MessageContent><span className="message-author">{message.provenance === 'user' ? 'You' : message.author ?? agentName(snapshot.chat.agent)}{message.background ? ' · background' : ''}</span><Bubble align={message.provenance === 'user' ? 'end' : 'start'} variant={message.provenance === 'user' ? 'muted' : 'ghost'}><BubbleContent>{message.commentary && <p className="commentary">{message.commentary}</p>}<MessageResponse>{message.text}</MessageResponse>{snapshot.turns?.filter(turn => turn.status === 'unanswered' && String(turn.entryId) === message.id.split(':')[0]).map(turn => <p key={turn.submissionId} className="pending-note">{turn.reason === 'aborted' ? 'Stopped · this turn was not completed' : `Not answered (${turn.reason})`}</p>)}{message.attachments?.map((file,index)=><Attachment key={index} size="sm"><AttachmentMedia>{file.mimeType.startsWith('image/') ? <img alt={file.name} src={`data:${file.mimeType};base64,${file.data}`}/> : <FileText/>}</AttachmentMedia><AttachmentContent><AttachmentTitle><a download={file.name} href={`data:${file.mimeType || 'text/plain'};base64,${file.data}`}>{file.name}</a></AttachmentTitle></AttachmentContent></Attachment>)}{message.error && <p className="message-error">{message.error}</p>}{message.artifacts?.map(artifact => <a key={artifact.id} className="artifact-link" href={`${route(selected!)}/artifacts/${encodeURIComponent(artifact.id)}`}>Download {artifact.name}</a>)}</BubbleContent></Bubble></MessageContent></Message><ToolTrace calls={(snapshot.toolCalls ?? []).filter(call=>call.afterMessageId===message.id)}/></MessageScrollerItem>)}
          {snapshot && <ToolTrace calls={(snapshot.toolCalls ?? []).filter(call=>!snapshot.messages.some(message=>message.id===call.afterMessageId && message.provenance!=='runtime'))}/>}

          {snapshot?.partial && <Message align="start"><span className="message-author">{agentName(snapshot.chat.agent)}</span><MessageContent><MessageResponse>{snapshot.partial}</MessageResponse></MessageContent></Message>}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message"/>
      </Conversation>
      <div className="composer-region">
        <div className="activity" role="status"><span>{(busy ? activity : turnOutcome) || activity || (selected ? connection === 'Connected' ? <><Check size={12}/> Saved</> : connection : '')}{snapshot?.queued ? ` · ${snapshot.queued} queued` : ''}</span>{busy && <Button variant="outline" size="sm" disabled={stopping} onClick={() => void stop()}><Square size={12}/>{stopping ? 'Stopping…' : 'Stop this conversation'}</Button>}</div>
        {stopNotice?.id === selected && <p className="pending-note" role="status">{stopNotice.text}</p>}
        {snapshot?.readOnlyReason && <p className="pending-note" role="status">{snapshot.readOnlyReason}</p>}
        {(error || snapshot?.error) && <div className="error-banner" role="alert"><p>{error || snapshot?.error}</p>{!ready && <Button variant="outline" size="sm" onClick={() => { setError(''); void refresh(); }}>Reconnect</Button>}{pending && <Button size="sm" disabled={sending} onClick={() => void deliver(pending)}>Retry message</Button>}<Button variant="ghost" size="icon" aria-label="Dismiss error" onClick={() => setError('')}><X/></Button></div>}
        {pending && <div className="pending-note">Message delivery is uncertain. Your text and files are preserved. <Button variant="outline" size="sm" disabled={sending} onClick={() => { setSelected(pending.chatId); void deliver(pending); }}>Retry message</Button></div>}
        <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}><InputGroup>
          {!!files.length && <InputGroupAddon align="block-start" className="attachment-list">{files.map((file,index)=><Attachment key={index} size="sm"><AttachmentMedia>{file.mimeType.startsWith('image/') ? <img alt="" src={`data:${file.mimeType};base64,${file.data}`}/> : <FileText/>}</AttachmentMedia><AttachmentContent><AttachmentTitle>{file.name}</AttachmentTitle></AttachmentContent><Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${file.name}`} disabled={sending || !!pending} onClick={()=>setFiles(current=>current.filter((_,i)=>i!==index))}><X/></Button></Attachment>)}</InputGroupAddon>}
          <InputGroupTextarea ref={composer} aria-label="Message" placeholder={busy ? 'Send a follow-up…' : `Message ${agentName(agent) || 'agent'}…`} rows={2} value={draft} disabled={sending || !!pending || !deliveryReady} onChange={event => {const text=event.target.value;setDraft(text);void saveDelivery({text,attachments:files,pending}).catch(()=>setDeliveryReady(false));}} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send(); } }}/>
          <InputGroupAddon align="block-end"><input hidden ref={fileInput} type="file" multiple aria-label="Select attachments" onChange={event=>void selectFiles(event.target.files)}/><InputGroupButton size="icon-sm" variant="ghost" className="rounded-full" aria-label="Attach files" disabled={sending || !!pending || !deliveryReady} onClick={()=>fileInput.current?.click()}><Paperclip/></InputGroupButton><span className="input-note">{readingFiles ? 'Reading files…' : busy ? 'Follow-up' : 'Agents'}</span><InputGroupButton type="submit" size="icon-sm" variant="default" className="send-button rounded-full" aria-label={sending ? 'Sending message' : 'Send message'} disabled={(!draft.trim() && !files.length) || sending || !ready || !!pending || !deliveryReady || readingFiles}>{sending ? <LoaderCircle className="animate-spin"/> : <ArrowUp/>}</InputGroupButton></InputGroupAddon>
        </InputGroup></form>
        <p className="composer-hint">Enter to send · Shift+Enter for a new line{busy ? ' · Follow-ups wait for current work' : ''}</p>
      </div>
    </main>
  </div>;
}
