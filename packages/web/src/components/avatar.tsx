import { useState } from 'react';
import { UserRound } from 'lucide-react';
const initials = (name: string) => {
  const words = name.replace(/^.*~/, '').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
};
const hue = (name: string) => [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
export function Avatar({ identity, available, user = false }: { identity: string; available: string[]; user?: boolean }) {
  const [failed, setFailed] = useState('');
  const key = user ? 'user' : `agent:${identity}`;
  if (available.includes(key) && failed !== key)
    return <span className="avatar" aria-hidden="true"><img alt="" src={`/api/avatars/${encodeURIComponent(key)}`} onError={() => setFailed(key)}/></span>;
  if (user) return <span className="avatar" aria-hidden="true"><UserRound/></span>;
  return <span className="avatar initials" aria-hidden="true" style={{ background: `oklch(0.6 0.09 ${hue(identity)})` }}>{initials(identity)}</span>;
}
