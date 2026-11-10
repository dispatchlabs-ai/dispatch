import { useState } from 'react';
import { Bot, UserRound } from 'lucide-react';
export function Avatar({ identity, available, user = false }: { identity: string; available: string[]; user?: boolean }) {
  const [failed, setFailed] = useState('');
  const key = user ? 'user' : `agent:${identity}`;
  return <span className="avatar" aria-hidden="true">{available.includes(key) && failed !== key
    ? <img alt="" src={`/api/avatars/${encodeURIComponent(key)}`} onError={() => setFailed(key)}/>
    : user ? <UserRound/> : <Bot/>}</span>;
}
