import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Slack, SquareTerminal } from 'lucide-react';
import { Avatar } from '@/components/avatar';
import { Button } from '@/components/ui/button';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { agentName } from '@/lib/names';
import type { Chat } from '@/lib/contracts';

type Tab = 'chats' | 'runs';
const humanTransports = new Set(['cli', 'web', 'slack', 'google-chat', 'phone', 'email']);
const page = 100;
const isActive = (chat: Chat) => chat.activity === 'working' || chat.activity === 'waiting';
const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
const known = (chat: Chat) => Date.parse(chat.createdAt) > 0;
const newest = (a: Chat, b: Chat) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
const searchText = (chat: Chat) => `${chat.title} ${chat.nativeTitle ?? ''} ${chat.agent} ${chat.source} ${chat.sourceLabel ?? ''} ${chat.transport ?? ''} ${chat.session ?? ''} ${chat.id} ${chat.conversationId}`.toLowerCase();

/** Workers are nested under their parent; a missing transport is a run, never a chat. */
export function chatTab(chat: Chat, byId: Map<string, Chat>): Tab {
  const seen = new Set<string>();
  let root = chat;
  while (root.parentId && byId.has(root.parentId) && !seen.has(root.id)) { seen.add(root.id); root = byId.get(root.parentId)!; }
  return !root.parentId && humanTransports.has(root.transport ?? '') ? 'chats' : 'runs';
}

function when(chat: Chat) {
  if (!known(chat)) return '';
  const date = new Date(chat.createdAt), today = day(new Date());
  return day(date) >= today - 86400000 ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function dated(chats: Chat[]) {
  const today = day(new Date()), groups: { title: string; chats: Chat[] }[] = [];
  for (const chat of chats) {
    const at = known(chat) ? day(new Date(chat.createdAt)) : 0;
    const title = at >= today ? 'Today' : at >= today - 86400000 ? 'Yesterday' : 'Earlier';
    if (groups.at(-1)?.title !== title) groups.push({ title, chats: [] });
    groups.at(-1)!.chats.push(chat);
  }
  return groups;
}

export function ConversationSidebar({ chats, selected, avatars, ready, stale, disabled, onChoose }: {
  chats: Chat[]; selected: string | null; avatars: string[]; ready: boolean; stale: boolean; disabled: boolean;
  onChoose(id: string): void;
}) {
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<Tab>(() => localStorage.getItem('dispatch-web:tab') === 'runs' ? 'runs' : 'chats');
  const [limit, setLimit] = useState(page);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const choose = (value: Tab) => { setTab(value); setLimit(page); localStorage.setItem('dispatch-web:tab', value); };
  const { byId, children, tops } = useMemo(() => {
    const byId = new Map(chats.map(chat => [chat.id, chat]));
    const children = new Map<string, Chat[]>();
    const tops: Record<Tab, Chat[]> = { chats: [], runs: [] };
    for (const chat of [...chats].sort(newest)) {
      if (chat.parentId && byId.has(chat.parentId)) children.set(chat.parentId, [...children.get(chat.parentId) ?? [], chat]);
      else tops[chatTab(chat, byId)].push(chat);
    }
    return { byId, children, tops };
  }, [chats]);
  // Reveal a selection made elsewhere (link, restored state, Open parent).
  const selectedChat = selected ? byId.get(selected) : undefined;
  const selectedTab = selectedChat && chatTab(selectedChat, byId);
  let selectedRoot = selectedChat;
  for (const seen = new Set<string>(); selectedRoot?.parentId && byId.has(selectedRoot.parentId) && !seen.has(selectedRoot.id);) { seen.add(selectedRoot.id); selectedRoot = byId.get(selectedRoot.parentId); }
  useEffect(() => {
    if (!selectedChat) return;
    if (selectedTab !== tab) choose(selectedTab!);
    const ancestors: string[] = [];
    for (let at = selectedChat.parentId; at && byId.has(at) && !ancestors.includes(at); at = byId.get(at)!.parentId) ancestors.push(at);
    if (ancestors.some(id => !expanded.has(id))) setExpanded(current => new Set([...current, ...ancestors]));
  }, [selected, selectedTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = filter.trim().toLowerCase();
  const results = useMemo(() => query ? chats.filter(chat => searchText(chat).includes(query)).sort(newest) : [], [chats, query]);
  // Active chats are ones Chris can type into; a busy unexposed service chat stays in history.
  const current = (value: Tab) => (chat: Chat) => isActive(chat) && (value === 'runs' || chat.addressable !== false);
  const rows = tops[tab], active = rows.filter(current(tab)), history = rows.filter(chat => !current(tab)(chat));
  const badge = (value: Tab) => tops[value].filter(current(value)).length;
  // "Show older" limits rendering only; an older selection stays visible.
  const shown = Math.max(limit, history.indexOf(selectedRoot!) + 1);
  const toggle = (id: string) => setExpanded(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });

  const row = (chat: Chat, nested = false, context?: string): React.ReactNode => {
    const workers = children.get(chat.id) ?? [];
    const open = expanded.has(chat.id);
    const status = chat.activity === 'working' ? 'Working' : chat.activity === 'waiting' ? 'Waiting' : chat.activity === 'unanswered' ? 'Unanswered' : when(chat);
    return <SidebarMenuItem key={chat.id}>
      <div className="chat-row">
        <SidebarMenuButton isActive={selected === chat.id} tooltip={`${chat.title}\n${chat.agent} · ${chat.sourceLabel ?? chat.source} · ${chat.session ?? ''} · ${chat.id}`}
          className="chat-item" aria-current={selected === chat.id ? 'page' : undefined} disabled={disabled} onClick={() => onChoose(chat.id)}>
          <Avatar identity={chat.agent} available={avatars}/>
          <span className="chat-copy">
            <span className="chat-title">{chat.title === 'New chat' ? 'New conversation' : chat.title}</span>
            {!nested && <span className="chat-meta">
              {(isActive(chat) || chat.activity === 'unavailable') && <i className={`dot ${chat.activity}`}/>}
              {chat.transport === 'slack' && <Slack aria-label="Slack"/>}
              {chat.transport === 'cli' && <SquareTerminal aria-label="CLI"/>}
              <span>{[agentName(chat.agent), context ?? status].filter(Boolean).join(' · ')}</span>
            </span>}
          </span>
        </SidebarMenuButton>
        {!!workers.length && !context && <button type="button" className="expand" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${workers.length} worker${workers.length === 1 ? '' : 's'}`} onClick={() => toggle(chat.id)}>{workers.length}<ChevronRight/></button>}
      </div>
      {open && !context && !!workers.length && <SidebarMenu className="workers" aria-label={`Workers of ${chat.title}`}>{workers.map(worker => row(worker, true))}</SidebarMenu>}
    </SidebarMenuItem>;
  };
  const section = (title: string, items: Chat[]) => !!items.length && <section key={title} aria-label={title}>
    <h2 className="history-group">{title}</h2><SidebarMenu>{items.map(chat => row(chat))}</SidebarMenu></section>;

  return <>
    <label className="history-search"><span className="sr-only">Search conversations</span>
      <input aria-label="Search conversations" placeholder="Search…" value={filter} onChange={event => { setFilter(event.target.value); setLimit(page); }}/></label>
    {!query && <div className="kind-tabs" role="tablist" aria-label="Conversation kinds">
      {(['chats', 'runs'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => choose(value)}>
        {value === 'chats' ? 'Chats' : 'Runs'}{!!badge(value) && <span className="badge" aria-label={`${badge(value)} active`}>{badge(value)}</span>}</button>)}
    </div>}
    <nav aria-label="Conversations" className={stale ? 'stale' : undefined}>
      {!ready && <p className="nav-note">Loading conversations…</p>}
      {ready && !chats.length && <p className="nav-note">Your conversations will appear here.</p>}
      {query ? <>
        {!!results.length && <section aria-label="Results"><h2 className="history-group">Results</h2><SidebarMenu>{results.slice(0, limit).map(chat => {
          const parent = chat.parentId ? byId.get(chat.parentId) : undefined;
          return row(chat, false, parent ? `worker of ${parent.title}` : undefined);
        })}</SidebarMenu></section>}
        {ready && !results.length && <p className="nav-note">No matching conversations.</p>}
        {results.length > limit && <Button variant="ghost" size="sm" className="show-older" onClick={() => setLimit(value => value + page)}>Show older</Button>}
      </> : <>
        {section('Active', active)}
        {dated(history.slice(0, shown)).map(group => <Fragment key={group.title}>{section(group.title, group.chats)}</Fragment>)}
        {history.length > shown && <Button variant="ghost" size="sm" className="show-older" onClick={() => setLimit(value => value + page)}>Show older</Button>}
        {ready && !!chats.length && !rows.length && <p className="nav-note">No {tab === 'chats' ? 'chats' : 'runs'} yet.</p>}
      </>}
    </nav>
  </>;
}
