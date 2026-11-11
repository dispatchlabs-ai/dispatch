import { Avatar } from '@/components/avatar';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, FileText, LoaderCircle, Lock, Menu, Paperclip, Plus, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import type { Agent, Chat, Snapshot, SourceStatus, SidebarSnapshot } from '@/lib/contracts';

import { api, isDefiniteRejection } from '@/lib/api';
import { loadDelivery, saveDelivery, type Pending } from '@/lib/delivery';
import type { AttachmentFile } from '@/lib/contracts';
import { MessageScrollerItem } from '@/components/ui/message-scroller';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { Attachment, AttachmentMedia, AttachmentContent, AttachmentTitle } from '@/components/ui/attachment';
import { ToolTrace, TaskInput } from '@/components/tool-trace';
import { ItemContext } from '@/components/item-context';
import { ConversationSidebar } from '@/components/conversation-sidebar';
import { agentName, installationName } from '@/lib/names';
const authorAgent = (agent: string, author?: string) => {
  if (!author) return agent;
  // Native peer authors are instance IDs; artwork belongs to their role.
  const role = author.replace(/:([1-9][0-9]*)$/, '');
  return role.includes('~') || !agent.includes('~') ? role : `${installationName(agent)}~${role}`;
};
// Consecutive messages from one author share a header; task inputs do not break a group.
const authorKey = (message: Snapshot['messages'][number]) => message.provenance === 'user' ? 'user' : `agent:${message.author ?? ''}`;
// Task inputs render as collapsed rows; other entries need visible content (no empty turns).
const visibleMessage = (message: Snapshot['messages'][number]) => message.provenance === 'runtime' ? !!message.text : !!(message.text || message.commentary || message.error || message.attachments?.length || message.artifacts?.length);
// Touch keyboards have no Shift+Enter, so Return adds a line there and Send sends.
const softKeyboard = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const route = (id: string) => `/api/chats/${encodeURIComponent(id)}`;
export default function App() {
  const [link, setLink] = useState(() => {
    const query = new URLSearchParams(location.search);
    return query.has('installation') || query.has('chat') || query.has('key') ? query : null;
  });
  const [linkReady, setLinkReady] = useState(false);
  const [linkError, setLinkError] = useState('');
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => {
      document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
      document.documentElement.style.setProperty('--app-top', `${viewport.offsetTop}px`);
    };
    resize(); viewport.addEventListener('resize', resize); viewport.addEventListener('scroll', resize);
    window.addEventListener('resize', resize); document.addEventListener('focusin', resize);
    return () => { viewport.removeEventListener('resize', resize); viewport.removeEventListener('scroll', resize); window.removeEventListener('resize', resize); document.removeEventListener('focusin', resize); };
  }, []);
  const [readingFiles, setReadingFiles] = useState(false);
  const [files, setFiles] = useState<AttachmentFile[]>([]);
  const [deliveryReady, setDeliveryReady] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [avatars, setAvatars] = useState<string[]>([]);
  const [sidebarConnection, setSidebarConnection] = useState('Connecting…');
  const [sidebarRetry, setSidebarRetry] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('dispatch-web:sidebar-width'));
    return Number.isFinite(saved) && saved >= 220 ? saved : 300;
  });
  const [viewportWidth, setViewportWidth] = useState(innerWidth);
  const resizeWidth = (width: number) => {
    const value = Math.max(220, Math.min(width, innerWidth - 360));
    setSidebarWidth(value); localStorage.setItem('dispatch-web:sidebar-width', String(value));
  };
  useEffect(() => { const resize = () => setViewportWidth(innerWidth); addEventListener('resize', resize); return () => removeEventListener('resize', resize); }, []);
  const [chats, setChats] = useState<Chat[]>([]);
  const [agent, setAgent] = useState('');
  const [selected, setSelected] = useState<string | null>(() => link ? null : localStorage.getItem('dispatch-web:selected') ?? localStorage.getItem('agent-chat:selected'));
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
  useEffect(() => {
    if (!link || !deliveryReady) return;
    let active = true;
    setLinkReady(false); setLinkError('');
    if (link.has('key') && (link.has('chat') || !link.get('installation') || !link.get('title') || !link.get('key')?.startsWith('attention-item:') || link.get('key') === 'attention-item:' || /[\u0000-\u001f\u007f-\u009f]/.test(link.get('key')!))) {
      setLinkError('Invalid keyed conversation link.'); setLinkReady(true); return;
    }
    if (link.has('key') && pending) {
      setLinkError('Resolve the pending message before opening this conversation link.'); setLinkReady(true); return;
    }
    const request = link.has('key')
      ? api<Chat>('/api/chat-link', { installation: link.get('installation'), key: link.get('key'), title: link.get('title') })
      : api<Chat>(`/api/chat-link?${link}`);
    void request.then(chat => {
      if (!active) return;
      if (pending && pending.chatId !== chat.id) {
        setLinkError('Resolve the pending message before opening this conversation link.');
      } else setSelected(chat.id);
      setLinkReady(true);
    }).catch(failure => { if (active) { setLinkError(`Conversation link unavailable. ${(failure as Error).message}`); setLinkReady(true); } });
    return () => { active = false; };
  }, [link, deliveryReady, pending]);
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
  const refresh = () => setSidebarRetry(value => value + 1);
  // A new conversation needs an agent that permits creation. Selecting a restricted
  // agent's chat sets `agent`; replace it (drafts/files untouched) once composing anew.
  useEffect(() => {
    if (selected || link || agents.some(item => item.id === agent && item.capabilities?.create !== false)) return;
    const eligible = agents.find(item => item.capabilities?.create !== false)?.id;
    if (eligible) setAgent(eligible);
  }, [selected, link, agents, agent]);
  useEffect(() => {
    const events = new EventSource('/api/sidebar/events');
    events.addEventListener('snapshot', event => {
      const value = JSON.parse((event as MessageEvent).data) as SidebarSnapshot;
      setSources(value.sources); setAgents(value.agents); setChats(value.chats); setAvatars(value.avatars ?? []);
      setReady(true); setSidebarConnection('Live');
      setAgent(current => value.agents.some(agent => agent.id === current) ? current : value.agents.find(agent => agent.capabilities?.create !== false)?.id ?? '');
    });
    // Keep last known activity; the stale flag renders it as unconfirmed.
    const disconnected = () => setSidebarConnection('Reconnecting…');
    events.addEventListener('failure', disconnected); events.onerror = disconnected;
    return () => events.close();
  }, [sidebarRetry]);
  useEffect(() => {
    if (!selected) { if (link) { setSnapshot(null); setConnection(''); return; } localStorage.removeItem('dispatch-web:selected'); localStorage.removeItem('agent-chat:selected'); setSnapshot(null); setConnection(''); return; }
    localStorage.setItem('dispatch-web:selected', selected); setSnapshot(null); setConnection('Connecting…');
    let active = true;
    const events = new EventSource(`${route(selected)}/events`);
    events.addEventListener('snapshot', event => {
      if (!active) return;
      const value = JSON.parse((event as MessageEvent).data) as Snapshot;
      setSnapshot(value); setAgent(value.chat.agent); setConnection('Connected');
    });
    events.addEventListener('failure', () => { if (active) setConnection('Observation interrupted. Reconnecting…'); });
    events.onerror = () => { if (active) setConnection('Disconnected. Reconnecting to saved history…'); };
    // A missing saved selection is actionable; EventSource does not expose HTTP errors.
    void api<Snapshot>(route(selected)).catch(failure => { if (active) setError((failure as Error).message); });
    return () => { active = false; events.close(); };
  }, [selected, link]);
  async function deliver(value: Pending) {
    // Existing pending state is already uncertain. Never discard its identity on
    // a later ownership/validation rejection: an earlier owner may have admitted.
    const previouslyUncertain = pending?.requestId === value.requestId;
    setSending(true); setError('');
    try {
      await saveDelivery({text:value.draftText ?? value.text,attachments:value.attachments ?? [],pending:value});
      const receipt = await api<{ submissionId: number }>(`${route(value.chatId)}/messages`, { text: value.text, requestId: value.requestId, attachments:value.attachments ?? [] });
      if (!Number.isSafeInteger(receipt?.submissionId) || receipt.submissionId < 1) throw new Error('Invalid admission receipt.');
      await saveDelivery({text:'',attachments:[],pending:null});
      sessionStorage.removeItem('dispatch-web:pending'); sessionStorage.removeItem('agent-chat:pending');
      setPending(null); setDraft(''); setFiles([]); setStopNotice(null);
    } catch (failure) {
      if (isDefiniteRejection(failure, previouslyUncertain)) {
        await saveDelivery({text:value.draftText ?? value.text,attachments:value.attachments ?? [],pending:null});
        sessionStorage.removeItem('dispatch-web:pending'); sessionStorage.removeItem('agent-chat:pending');
        setPending(null); setDraft(value.draftText ?? value.text); setFiles(value.attachments ?? []);
        setError(`${failure.message} Message was not admitted. Edit it or choose another conversation.`);
      } else {
        setPending(value);
        setError(`${(failure as Error).message} Delivery is uncertain. Use Retry message to check or resend it safely.`);
      }
    }
    finally { setSending(false); }
  }
  async function send() {
    if (linkBlocked || selected && !snapshot || !selected && !canCreate || sending || (!draft.trim() && !files.length) || pending || !deliveryReady || readingFiles) return;
    returnFocus.current = document.activeElement === composer.current;
    setSending(true); setError('');
    try {
      const requestId = crypto.randomUUID();
      let id = selected;
      if (!id) {
        const chat = await api<Chat>('/api/chats', { agent, key: crypto.randomUUID() });
        id = chat.id; setSelected(id); setChats(current => [chat, ...current]);
      }
      const chatId = id;
      const submit = async () => {
        let text = draft;
        if (link?.has('key')) {
          const current = await api<Snapshot>(route(chatId));
          if (!current.messages.some(message => message.provenance === 'user'))
            text = `About this Attention item: ${link.get('title')}\n${link.get('context') ?? ''}\n\n${draft}`;
        }
        await deliver({ chatId, text, draftText: draft, requestId, attachments: files });
      };
      // Serialize native first-message observation/admission across this origin's tabs.
      // The retained payload, not this composition step, is used for uncertain retries.
      if (link?.has('key')) await navigator.locks.request(`dispatch-web:first-message:${chatId}`, submit);
      else await submit();
    } catch (failure) { setError((failure as Error).message); }
    finally { setSending(false); setSendCompleted(value => value + 1); }
  }
  async function stop() {
    if (!selected || performance.now() - stopShownAt.current < 500) return;
    setStopping(true); setError('');
    try { await api(`${route(selected)}/stop`, {}); setStopNotice({id: selected, text: "Stop accepted for this conversation’s work."}); }
    catch (failure) { setError((failure as Error).message); }
    finally { setStopping(false); }
  }
  function choose(id: string | null) { history.replaceState(null, '', location.pathname); setLink(null); setLinkError(''); setSelected(id); setError(''); setNavigation(false); composer.current?.focus(); }
  const listedChat = chats.find(chat => chat.id === selected);
  const selectedChat = snapshot?.chat ?? listedChat;
  const canCreate = (selectedChat ?? agents.find(item => item.id === agent))?.capabilities?.create !== false;
  // New conversation depends on the agent catalog, not on the selected conversation.
  const anyCreate = agents.some(item => item.capabilities?.create !== false);
  const chatAgent = selectedChat?.agent ?? agent;
  const parentId = selectedChat?.parentId;
  const parent = parentId ? chats.find(chat => chat.id === parentId) : undefined;
  // Older adapters only send the sentence; every such sentence means sending here is unavailable.
  const readOnly = snapshot?.readOnly ?? (snapshot?.readOnlyReason ? 'owner' : undefined);
  const canAttach = (selectedChat ?? agents.find(item => item.id === agent))?.capabilities?.attachments !== false;
  const linkBlocked = !!link && (!linkReady || !!linkError);
  const busy = !!snapshot && (snapshot.running || snapshot.background || snapshot.queued > 0 || snapshot.tools.length > 0);
  // One composer action: Stop while work is active and nothing is drafted, otherwise Send.
  const showStop = busy && !(draft.trim() || files.length);
  // Stop appears where Send was tapped; a repeated tap meant for Send must not stop the work.
  const stopShownAt = useRef(0);
  useEffect(() => { if (showStop) stopShownAt.current = performance.now(); }, [showStop]);
  // The sidebar and selected stream can observe a generated title in either order.
  const title = (listedChat?.nativeTitle ? listedChat : snapshot?.chat ?? listedChat)?.title ?? (link ? 'Linked conversation' : 'New conversation');
  // Before the first message, keyed item context is the conversation's content; afterwards the first message carries it.
  const itemContext = link?.has('key') && linkReady && !linkError && snapshot && !snapshot.messages.some(message => message.provenance === 'user') && !snapshot.partial ? link.get('context') : null;
  const activity = snapshot?.observation ?? (snapshot?.retry ? `Retry ${snapshot.retry.attempt} scheduled for ${new Date(snapshot.retry.at).toLocaleTimeString()}` : snapshot?.tools.length ? `Using ${snapshot.tools.join(', ')}` : snapshot?.background ? 'Working…' : snapshot?.running ? 'Replying…' : snapshot?.queued ? 'Input pending' : '');
  const stale = ready && sidebarConnection !== 'Live';
  const lastTurn = snapshot?.turns?.at(-1);
  // Stopped/unanswered outcomes stay visible when idle; completion needs no status.
  const outcome = lastTurn?.status === 'unanswered' ? lastTurn.reason === 'aborted' ? 'Stopped · this turn was not completed' : `Not answered (${lastTurn.reason})` : '';
  const status = readingFiles ? 'Reading files…' : busy ? `${activity}${stopNotice?.id === selected ? ' · Stop requested' : ''}${snapshot?.queued ? ` · ${snapshot.queued} pending` : ''}` : selected && snapshot && connection !== 'Connected' ? connection : outcome;
  const failure = error || snapshot?.error;
  const visible = (snapshot?.messages ?? []).filter(visibleMessage).map((message, index, all) => {
    let previous = index - 1;
    while (previous >= 0 && all[previous].provenance === 'runtime') previous--;
    return { message, continued: message.provenance === 'runtime' ? index > 0 : previous >= 0 && authorKey(all[previous]) === authorKey(message) };
  });
  return <div className="app-shell">
    {navigation && <button className="nav-scrim" aria-label="Close conversation navigation" onClick={() => setNavigation(false)}/>}
    <aside style={narrow ? undefined : { width: Math.max(220, Math.min(sidebarWidth, viewportWidth - 360)) }} ref={sidebar} inert={narrow && !navigation} className={navigation ? 'sidebar open' : 'sidebar'} aria-label="Conversations">
      <div className="sidebar-heading"><strong>Agent Chat</strong>
        {ready && anyCreate && !linkBlocked && <Button variant="ghost" size="icon-sm" aria-label="New conversation" title="New conversation" disabled={sending || !!pending} onClick={() => choose(null)}><Plus/></Button>}
        <Button variant="ghost" size="icon-sm" className="mobile-only" aria-label="Close navigation" onClick={() => setNavigation(false)}><X/></Button></div>
      <ConversationSidebar chats={chats} selected={selected} avatars={avatars} ready={ready} stale={stale} disabled={sending || !!pending} onChoose={choose}/>
      <div className="sidebar-footer"><span role="status" className={stale || !ready ? 'live stale' : 'live'}><i/>{sidebarConnection}</span>{sidebarConnection !== 'Live' && <button onClick={refresh}>Reconnect</button>}{sources.flatMap(source => source.issues.map((issue, index) => <p key={`${source.id}:${index}`} role="status">{source.label}: {issue}</p>))}</div>
    </aside>
    {!narrow && <div className="sidebar-resizer" role="separator" aria-label="Resize conversation sidebar" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={Math.max(220, viewportWidth - 360)} aria-valuenow={Math.max(220, Math.min(sidebarWidth, viewportWidth - 360))} tabIndex={0}
      onKeyDown={event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); resizeWidth(event.key === 'Home' ? 220 : event.key === 'End' ? innerWidth - 360 : Math.min(sidebarWidth, innerWidth - 360) + (event.key === 'ArrowLeft' ? -20 : 20)); } }}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeWidth(event.clientX); }}
      onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}/>}
    <main inert={narrow && navigation}>
      <header><Button aria-expanded={navigation} variant="ghost" size="icon" className="mobile-only" aria-label="Open conversations" onClick={() => setNavigation(true)}><Menu/></Button>
        <div className="heading"><h1 title={title}>{title}</h1>
          {parentId && (parent ? <button type="button" className="parent-link" onClick={() => choose(parent.id)}><span>Worker of “{parent.title}”</span><ChevronRight/></button> : <span className="parent-link">Worker conversation</span>)}</div>
        {selected && <span className="agent-name"><Avatar identity={chatAgent} available={avatars}/><span>{agentName(chatAgent)}</span></span>}</header>
      {!selected && !link && <div className="agent-picker"><label htmlFor="agent">Agent</label><select id="agent" value={agent} disabled={!ready || sending} onChange={event => setAgent(event.target.value)}>{agents.filter(item => item.capabilities?.create !== false).map(item => <option key={item.id} value={item.id}>{agentName(item.id)} · {installationName(item.id)}</option>)}</select><p>{agents.find(item => item.id === agent)?.description}</p></div>}
      <Conversation key={selected ?? 'new'} className="conversation" aria-label="Message history" aria-busy={snapshot?.running ?? false}>
        <ConversationContent className="message-list">
          {itemContext && <ItemContext title={link!.get('title') ?? ''} context={itemContext}/>}
          {(!selected && !link || snapshot && !snapshot.messages.length && !snapshot.partial && !itemContext) && <ConversationEmptyState title={`Message ${agentName(snapshot?.chat.agent ?? agent) || 'an agent'}`} description=""/>}
          {link && !linkReady && <p className="empty-loading">Opening linked conversation…</p>}
          {selected && !snapshot && <p className="empty-loading">{connection}</p>}
          {snapshot && visible.map(({ message, continued }) => message.provenance === 'runtime'
            ? <MessageScrollerItem key={message.id} messageId={message.id} className={continued ? 'continued' : undefined}><TaskInput text={message.text}/><ToolTrace calls={(snapshot.toolCalls ?? []).filter(call => call.afterMessageId === message.id && call.name !== 'request_status')}/></MessageScrollerItem>
            : <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.provenance === 'user'} className={continued ? 'continued' : undefined}><Message align={message.provenance === 'user' ? 'end' : 'start'}><MessageContent>
              {!continued && <span className="message-author"><Avatar user={message.provenance === 'user'} identity={authorAgent(snapshot.chat.agent, message.author)} available={avatars}/>{message.provenance === 'user' ? 'You' : message.author ?? agentName(snapshot.chat.agent)}</span>}
              <Bubble align={message.provenance === 'user' ? 'end' : 'start'} variant={message.provenance === 'user' ? 'muted' : 'ghost'}><BubbleContent>{message.background && <p className="commentary">Background</p>}{message.commentary && <p className="commentary">{message.commentary}</p>}<MessageResponse>{message.text}</MessageResponse>{snapshot.turns?.filter(turn => turn.status === 'unanswered' && String(turn.entryId) === message.id.split(':')[0]).map(turn => <p key={turn.submissionId} className="message-note">{turn.reason === 'aborted' ? 'Stopped · this turn was not completed' : `Not answered (${turn.reason})`}</p>)}{message.attachments?.map((file,index)=><Attachment key={index} size="sm"><AttachmentMedia>{file.mimeType.startsWith('image/') ? <img alt={file.name} src={`data:${file.mimeType};base64,${file.data}`}/> : <FileText/>}</AttachmentMedia><AttachmentContent><AttachmentTitle><a download={file.name} href={`data:${file.mimeType || 'text/plain'};base64,${file.data}`}>{file.name}</a></AttachmentTitle></AttachmentContent></Attachment>)}{message.error && <p className="message-error">{message.error}</p>}{message.artifacts?.map(artifact => snapshot.chat.capabilities?.artifacts === false ? <span key={artifact.id} className="artifact-link">{artifact.name} · Download unavailable</span> : <a key={artifact.id} className="artifact-link" href={`${route(selected!)}/artifacts/${encodeURIComponent(artifact.id)}`}>Download {artifact.name}</a>)}</BubbleContent></Bubble></MessageContent></Message><ToolTrace calls={(snapshot.toolCalls ?? []).filter(call=>call.afterMessageId===message.id && call.name!=='request_status')}/></MessageScrollerItem>)}
          {snapshot && <ToolTrace calls={(snapshot.toolCalls ?? []).filter(call=>call.name!=='request_status' && !snapshot.messages.some(message=>message.id===call.afterMessageId && visibleMessage(message)))}/>}
          {snapshot?.partial && <Message align="start"><MessageContent><span className="message-author"><Avatar identity={snapshot.chat.agent} available={avatars}/>{agentName(snapshot.chat.agent)}</span><MessageResponse>{snapshot.partial}</MessageResponse></MessageContent></Message>}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message"/>
      </Conversation>
      <div className="composer-region">
        {!!snapshot?.toolCalls?.some(call => call.name === 'request_status') && <details className="request-activity"><summary>Request details</summary><ToolTrace calls={snapshot.toolCalls.filter(call => call.name === 'request_status')}/></details>}
        <div className="activity" role="status">{busy && <i className="dot working"/>}{status}</div>
        {failure ? <div className="error-banner" role="alert"><p>{failure}</p>{!ready && <Button variant="outline" size="sm" onClick={() => { setError(''); void refresh(); }}>Reconnect</Button>}{pending && <Button size="sm" disabled={sending} onClick={() => void deliver(pending)}>Retry message</Button>}{error && <Button variant="ghost" size="icon-sm" aria-label="Dismiss error" onClick={() => setError('')}><X/></Button>}</div>
          : pending ? <div className="notice-banner" role="status"><p>Message delivery is uncertain. Your text and files are preserved.</p><Button variant="outline" size="sm" disabled={sending} onClick={() => { setSelected(pending.chatId); void deliver(pending); }}>Retry message</Button></div>
          : linkError ? <div className="error-banner" role="alert"><p>{linkError}</p><Button variant="outline" size="sm" onClick={() => setLink(new URLSearchParams(link!))}>Retry link</Button></div> : null}
        {readOnly && !pending ? <div className="read-only-bar" role="status"><Lock/><p>{readOnly === 'worker' && parent?.addressable === false ? 'Worker conversation run by a task.' : snapshot?.readOnlyReason ?? 'Read-only conversation.'}</p>{parent && <Button variant="outline" size="sm" onClick={() => choose(parent.id)}>Open parent</Button>}</div> : <>
        <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}><InputGroup>
          {!!files.length && <InputGroupAddon align="block-start" className="attachment-list">{files.map((file,index)=><Attachment key={index} size="sm"><AttachmentMedia>{file.mimeType.startsWith('image/') ? <img alt="" src={`data:${file.mimeType};base64,${file.data}`}/> : <FileText/>}</AttachmentMedia><AttachmentContent><AttachmentTitle>{file.name}</AttachmentTitle></AttachmentContent><Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${file.name}`} disabled={sending || !!pending} onClick={()=>setFiles(current=>current.filter((_,i)=>i!==index))}><X/></Button></Attachment>)}</InputGroupAddon>}
          <InputGroupTextarea ref={composer} aria-label="Message" placeholder={busy ? 'Steer active work…' : `Message ${agentName(chatAgent) || 'agent'}…`} rows={2} value={draft} disabled={sending || !!pending || !deliveryReady || linkBlocked || !!selected && !snapshot} onChange={event => {const text=event.target.value;setDraft(text);void saveDelivery({text,attachments:files,pending}).catch(()=>setDeliveryReady(false));}} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && !softKeyboard()) { event.preventDefault(); void send(); } }}/>
          <InputGroupAddon align="block-end"><input hidden ref={fileInput} type="file" multiple aria-label="Select attachments" onChange={event=>void selectFiles(event.target.files)}/><InputGroupButton size="icon-sm" variant="ghost" className="rounded-full" aria-label="Attach files" disabled={sending || !!pending || !deliveryReady || !canAttach || linkBlocked} onClick={()=>fileInput.current?.click()}><Paperclip/></InputGroupButton>
            {/* Separate keys keep keyboard focus from carrying Send onto Stop. */}
            <span className="composer-actions">{showStop
              ? <InputGroupButton key="stop" type="button" size="icon-sm" variant="default" className="rounded-full" aria-label={stopping ? 'Stopping' : 'Stop'} title="Stop" disabled={stopping} onClick={() => void stop()}><Square className="fill-current"/></InputGroupButton>
              : <InputGroupButton key="send" type="submit" size="icon-sm" variant="default" className="send-button rounded-full" aria-label={sending ? 'Sending message' : 'Send message'} disabled={(!draft.trim() && !files.length) || sending || !ready || !!pending || !deliveryReady || readingFiles || linkBlocked || !!selected && !snapshot || !selected && !canCreate}>{sending ? <LoaderCircle className="animate-spin"/> : <ArrowUp/>}</InputGroupButton>}</span></InputGroupAddon>
        </InputGroup></form>
        <p className="composer-hint">Enter to send · Shift+Enter for a new line{busy ? ' · Messages steer at the next tool boundary' : ''}</p></>}
      </div>
    </main>
  </div>;
}
