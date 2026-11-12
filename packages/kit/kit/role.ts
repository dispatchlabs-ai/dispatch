import type { AgentDefinition } from "@dispatch/runner";

type Extension = NonNullable<AgentDefinition["extensions"]>[number];
type Names = string[] | { add?: string[]; remove?: string[] };

/** A company's `roles` entry in kit.json. A list is the whole list; `add` and `remove` change the kit's. */
export type RoleChanges = {
  messages?: Names;
  delegates?: Names;
  /** In a whole list, a string keeps the kit role's extension of that name. */
  extensions?: (string | Extension)[] | { add?: Extension[]; remove?: string[] };
};

// The composer writes this call into agents/ROLE/agent.ts when kit.json changes a kit role, so the
// role keeps the kit's definition for everything the company did not change.
export function changeRole(role: string, kit: AgentDefinition, changes: RoleChanges): AgentDefinition {
  const missing = (field: string, name: string, present: string[]) =>
    new Error(`kit.json roles.${role}.${field} names ${name}, which the kit's ${role} does not have. It has: ${present.join(", ") || "none"}.`);
  const names = (field: "messages" | "delegates"): string[] => {
    const current = kit[field] ?? [], change = changes[field];
    if (change === undefined || Array.isArray(change)) return change ?? current;
    for (const name of change.remove ?? []) if (!current.includes(name)) throw missing(field, name, current);
    for (const name of change.add ?? []) if (current.includes(name)) throw new Error(`kit.json roles.${role}.${field} adds ${name}, which the kit's ${role} already lists.`);
    return [...current.filter(name => !change.remove?.includes(name)), ...(change.add ?? [])];
  };
  const current = kit.extensions ?? [], change = changes.extensions;
  const own = (name: string) => {
    const found = current.find(extension => extension.name === name);
    if (!found) throw missing("extensions", name, current.map(extension => extension.name));
    return found;
  };
  const extensions = change === undefined ? current
    : Array.isArray(change) ? change.map(entry => typeof entry === "string" ? own(entry) : entry)
    : [...current.filter(extension => !(change.remove ?? []).map(name => own(name)).includes(extension)), ...(change.add ?? [])];
  const { messages: _messages, delegates: _delegates, extensions: _extensions, ...rest } = kit;
  const changed = { messages: names("messages"), delegates: names("delegates"), extensions };
  return { ...rest, ...Object.fromEntries(Object.entries(changed).filter(([, value]) => value.length)) };
}
