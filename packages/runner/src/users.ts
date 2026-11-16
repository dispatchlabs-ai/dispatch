import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ContentError } from "./chat-content.js";
import { defineExtension, GenerationTask, hook, LiveDoc, type Cursor } from "@earendil-works/pi-durable";

const text = Type.String({ pattern: "\\S" });
const identity = Type.Object({ channel: text, handle: text, scope: Type.Optional(text) }, { additionalProperties: false });
const person = Type.Object({
  name: text, agents: Type.Array(text), contextFile: Type.Optional(text), identities: Type.Array(identity),
}, { additionalProperties: false });
const roster = Type.Object({ users: Type.Record(Type.String(), person) }, { additionalProperties: false });

export type UserIdentity = Static<typeof identity>;
type Person = Static<typeof person> & { id: string };

function identityKey({ channel, scope, handle }: UserIdentity) {
  return JSON.stringify([channel, scope ?? "", channel === "imsg" ? handle.trim().toLowerCase() : handle]);
}

/** Application-owned people. Only the host and its authenticated adapters supply identities. */
export class Users {
  private readonly people = new Map<string, Person>();
  private readonly identities = new Map<string, Person>();

  static async load(file: string, agents: readonly string[]) {
    const config: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Check(roster, config)) throw new Error("Invalid users file. Each user needs a name, agents and channel identities.");
    const directory = new Users();
    for (const [id, record] of Object.entries(config.users)) {
      if (!id.trim() || record.agents.some(agent => !agents.includes(agent))) throw new Error(`Invalid user ID or unknown agent for ${id}.`);
      const user: Person = { ...record, id };
      if (user.contextFile) {
        user.contextFile = resolve(dirname(file), user.contextFile);
        await readFile(user.contextFile, "utf8");
      }
      directory.add(user);
    }
    return directory;
  }

  private add(user: Person) {
    this.people.set(user.id, user);
    for (const subject of user.identities) {
      if ((subject.channel === "slack" || subject.channel === "web") && !subject.scope)
        throw new Error(`A ${subject.channel} identity requires its scope for user ${user.id}.`);
      const key = identityKey(subject);
      if (this.identities.has(key)) throw new Error(`Duplicate ${subject.channel} identity for user ${user.id}.`);
      this.identities.set(key, user);
    }
  }

  forAgent(agent: string) {
    return [...this.people.values()].filter(user => user.agents.includes(agent));
  }

  static preview(person: Pick<Person, "id" | "name" | "contextFile">, agent: string, identity: UserIdentity) {
    const users = new Users();
    users.add({ ...person, agents: [agent], identities: [identity] });
    return users;
  }

  find(identity: UserIdentity, agent: string) {
    const user = this.identities.get(identityKey(identity));
    return user?.agents.includes(agent) ? user : undefined;
  }

  attribution(agent: string, source: string, identity?: UserIdentity, audience?: UserIdentity[]) {
    if (!identity && !["web", "cli", "terminal", "slack", "imsg"].includes(source)) return;
    const user = identity && this.find(identity, agent);
    if (!user) throw new ContentError("This person is not enrolled for this agent.");
    const members = audience?.map(subject => {
      const member = this.find(subject, agent);
      if (!member) throw new ContentError("A conversation member is not enrolled for this agent.");
      return member;
    });
    return {
      label: `${user.name} (${user.id})${members?.length ? " in a group with " + members.map(member => member.name).join(", ") : ""}`,
      data: { userId: user.id, author: user.name, ...(members?.length ? { audience: [...new Set(members.map(member => member.id))] } : {}) },
    };
  }

  /** Private Markdown is assembled for inference only. Native public entries retain attribution across compaction. */
  extension(namespace: string) {
    return defineExtension({ name: `${namespace}.users`, hooks: [hook(GenerationTask, {
      beforeRequest: async ({ messages }, api, ctx) => {
        const first = (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run?.first;
        if (first === undefined) return;
        const ids = new Set<string>();
        const speakers = new Set<string>();
        let cursor: Cursor | undefined;
        do {
          const page = await api.entries({ minEntryId: first, order: "ascending" }, 100, cursor, ctx);
          for (const entry of page.items) {
            if (entry.kind !== `${namespace}.message`) continue;
            const data = entry.data as { actor?: string; userId?: string; audience?: string[] } | undefined;
            if (data?.actor !== "user" || !data.userId) continue;
            speakers.add(data.userId);
            ids.add(data.userId);
            for (const id of data.audience ?? []) ids.add(id);
          }
          cursor = page.next;
        } while (cursor);
        if (!ids.size) return;
        const notes = await Promise.all([...ids].map(async id => {
          const user = this.people.get(id);
          if (!user) throw new Error(`User ${id} is no longer enrolled.`);
          return [`${user.name} (${id})`, user.contextFile && (await readFile(user.contextFile, "utf8")).trim()].filter(Boolean).join("\n");
        }));
        const guidance = [`Verified sender(s) in this turn: ${[...speakers].join(", ")}. Use the following private, application-authored notes for the named people. Consider who can see the reply. Keep the notes private.`, ...notes].join("\n\n");
        const leading = messages[0];
        if (leading?.role === "system") return { messages: [{ ...leading, sections: { ...leading.sections, dispatch_people: guidance } }, ...messages.slice(1)] };
        return { messages: [{ role: "system", content: guidance, timestamp: 0 }, ...messages] };
      },
    })] });
  }
}
