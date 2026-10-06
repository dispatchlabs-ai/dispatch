import { $isCodeNode, CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { $convertFromMarkdownString, $convertSelectionToMarkdownString, $convertToMarkdownString, $generateNodesFromMarkdownString } from "@lexical/markdown";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $findMatchingParent, $getSelection, $isRangeSelection, $isTextNode, CLEAR_HISTORY_COMMAND, COMMAND_PRIORITY_HIGH, COMMAND_PRIORITY_NORMAL, COPY_COMMAND, CUT_COMMAND, INSERT_PARAGRAPH_COMMAND, KEY_ENTER_COMMAND, PASTE_COMMAND, SKIP_DOM_SELECTION_TAG } from "lexical";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { MentionParticipant } from "../lib/mentions";
import { $getMentionIds, MentionNode, mentionTransformers } from "./mention-node";
import { MentionsPlugin } from "./mentions";

interface MarkdownComposerProps {
  id: string;
  placeholder?: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  participants: MentionParticipant[];
  mentions: string[];
  onMentionsChange: (ids: string[]) => void;
  toolbar: ReactNode;
}

export function MarkdownComposer(props: MarkdownComposerProps) {
  const transformers = useMemo(() => mentionTransformers(props.participants), [props.participants]);
  return <LexicalComposer initialConfig={{
    namespace: props.id,
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode, MentionNode],
    editorState: () => $convertFromMarkdownString(props.value, transformers, undefined, true),
    editable: !props.disabled && !props.readOnly,
    theme: {
      code: "composer-code",
      list: { nested: { listitem: "composer-nested-list-item" } },
      text: { bold: "composer-bold", italic: "composer-italic", strikethrough: "composer-strike", code: "composer-inline-code", highlight: "composer-highlight" },
    },
    onError: error => { throw error; },
  }}>
    <div className="composer-editor">
      <RichTextPlugin ErrorBoundary={LexicalErrorBoundary} contentEditable={<ContentEditable
        id={props.id}
        className="composer-input"
        role="textbox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-label={props.placeholder || "Message everyone"}
        aria-multiline="true"
        aria-disabled={props.disabled}
        aria-readonly={props.readOnly}
        aria-placeholder={props.placeholder || "Message everyone…"}
        placeholder={<div className="composer-placeholder">{props.placeholder || "Message everyone…"}</div>}
      />} />
    </div>
    <div className="composer-toolbar">{props.toolbar}</div>
    <HistoryPlugin />
    <ListPlugin />
    <LinkPlugin />
    <MarkdownShortcutPlugin transformers={transformers} />
    <MentionsPlugin people={props.participants} />
    <ComposerSync {...props} transformers={transformers} />
  </LexicalComposer>;
}

function ComposerSync({ value, disabled, readOnly, onChange, onSend, mentions, onMentionsChange, transformers }: MarkdownComposerProps & { transformers: ReturnType<typeof mentionTransformers> }) {
  const [editor] = useLexicalComposerContext();
  const lastValue = useRef(value);
  const lastMentions = useRef(mentions);

  useEffect(() => { editor.setEditable(!disabled && !readOnly); }, [editor, disabled, readOnly]);

  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    lastMentions.current = mentions;
    editor.update(() => $convertFromMarkdownString(value, transformers, undefined, true), {
      tag: ["external-draft", SKIP_DOM_SELECTION_TAG],
      onUpdate: () => editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined),
    });
  }, [editor, value, mentions, transformers]);

  useEffect(() => {
    const ids = editor.read("latest", $getMentionIds);
    if (ids.join("\n") !== lastMentions.current.join("\n")) {
      lastMentions.current = ids;
      onMentionsChange(ids);
    }
  }, [editor, value, mentions, onMentionsChange]);

  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, event => {
    if (!event || event.isComposing || editor.isComposing()) return false;
    if (event.shiftKey) {
      event.preventDefault();
      // Use normal rich-text Enter so lists continue and new lines accept Markdown blocks.
      return editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
    }
    if (!window.matchMedia("(pointer: fine)").matches) return false;
    event.preventDefault();
    if (!disabled && !readOnly) onSend();
    return true;
  }, COMMAND_PRIORITY_NORMAL), [editor, disabled, readOnly, onSend]);

  useEffect(() => editor.registerCommand(PASTE_COMMAND, event => {
    if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
    const text = event.clipboardData.getData("text/plain");
    const selection = $getSelection();
    event.preventDefault();
    if (!text || !$isRangeSelection(selection)) return true;
    const anchor = selection.anchor.getNode();
    if ($findMatchingParent(anchor, $isCodeNode) || ($isTextNode(anchor) && anchor.hasFormat("code"))) selection.insertRawText(text);
    else selection.insertNodes($generateNodesFromMarkdownString(text, transformers, true));
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor, transformers]);

  useEffect(() => {
    const unregister = [COPY_COMMAND, CUT_COMMAND].map(command => editor.registerCommand(command, event => {
      if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
      event.preventDefault();
      event.clipboardData.setData("text/plain", $convertSelectionToMarkdownString(transformers, selection, true));
      if (command === CUT_COMMAND && editor.isEditable()) selection.removeText();
      return true;
    }, COMMAND_PRIORITY_HIGH));
    return () => unregister.forEach(remove => remove());
  }, [editor, transformers]);

  return <OnChangePlugin ignoreSelectionChange ignoreHistoryMergeTagChange={false} onChange={(state, _editor, tags) => {
    if (tags.has("external-draft")) return;
    const { markdown, ids } = state.read(() => ({ markdown: $convertToMarkdownString(transformers, undefined, true), ids: $getMentionIds() }));
    if (markdown !== lastValue.current) {
      lastValue.current = markdown;
      onChange(markdown);
    }
    if (ids.join("\n") !== lastMentions.current.join("\n")) {
      lastMentions.current = ids;
      onMentionsChange(ids);
    }
  }} />;
}
