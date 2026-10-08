import { TRANSFORMERS, type TextMatchTransformer } from "@lexical/markdown";
import { $applyNodeReplacement, $createTextNode, $getRoot, TextNode, type EditorConfig, type LexicalNode, type NodeKey, type SerializedTextNode, type Spread } from "lexical";
import { agentMentionPrefix, mentionId, mentionLabel, mentionUrl, type MentionParticipant } from "../lib/mentions";

type SerializedMention = Spread<{ participantId: string }, SerializedTextNode>;

/** A selected identity stays atomic through editing and native undo/redo. */
export class MentionNode extends TextNode {
  __participantId: string;

  constructor(participantId: string, text: string, key?: NodeKey) {
    super(text, key);
    this.__participantId = participantId;
  }

  static getType() { return "mention"; }
  static clone(node: MentionNode) { return new MentionNode(node.__participantId, node.__text, node.__key); }
  static importJSON(node: SerializedMention) { return $createMentionNode(node.participantId, node.text).updateFromJSON(node); }
  exportJSON(): SerializedMention { return { ...super.exportJSON(), participantId: this.getParticipantId(), type: "mention", version: 1 }; }
  getParticipantId() { return this.getLatest().__participantId; }
  isTextEntity() { return true; }
  canInsertTextBefore() { return false; }
  canInsertTextAfter() { return false; }

  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    element.classList.add("inline-mention");
    element.setAttribute("data-mention-id", this.getParticipantId());
    return element;
  }
}

export function $createMentionNode(id: string, text: string) {
  return $applyNodeReplacement(new MentionNode(id, text)).setMode("token");
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode { return node instanceof MentionNode; }

export function $getMentionIds() {
  return [...new Set($getRoot().getAllTextNodes().filter($isMentionNode).map(node => node.getParticipantId()))];
}

export function mentionTransformers(people: MentionParticipant[]) {
  const mention: TextMatchTransformer = {
    type: "text-match",
    dependencies: [MentionNode],
    importRegExp: /\[(@(?:\\.|[^\]\\])*)\]\((mention:[^\s)]+)\)/,
    regExp: /\[(@(?:\\.|[^\]\\])*)\]\((mention:[^\s)]+)\)$/,
    export: node => $isMentionNode(node)
      ? `[${node.getTextContent().replace(/[\\[\]]/g, "\\$&")}](${mentionUrl(node.getParticipantId())})` : null,
    replace: (node, match) => {
      const id = mentionId(match[2]);
      const person = people.find(person => person.id === id);
      const label = match[1].replace(/\\(.)/g, "$1");
      // Keep invite intent through catalog changes; admission validates availability.
      node.replace(person ? $createMentionNode(person.id, `@${mentionLabel(person, people)}`)
        : id?.startsWith(agentMentionPrefix) ? $createMentionNode(id, label) : $createTextNode(label));
    },
  };
  return [mention, ...TRANSFORMERS];
}
