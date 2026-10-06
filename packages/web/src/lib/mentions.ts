export type MentionParticipant = { id: string; name: string; kind: "human" | "agent" };

export function mentionUrl(id: string) { return `mention:${encodeURIComponent(id)}`; }

export function mentionId(url: string) {
  if (!url.startsWith("mention:")) return null;
  try { return decodeURIComponent(url.slice(8)) || null; }
  catch { return null; }
}

export function mentionLabel(person: MentionParticipant, people: MentionParticipant[]) {
  return people.some(other => other.id !== person.id && other.name === person.name)
    ? `${person.name} · ${person.id.slice(-6)}` : person.name;
}
