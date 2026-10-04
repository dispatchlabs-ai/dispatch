import { $isCodeNode, CodeNode } from "@lexical/code";
import { LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { $convertFromMarkdownString, $convertSelectionToMarkdownString, $convertToMarkdownString, $generateNodesFromMarkdownString, TRANSFORMERS } from "@lexical/markdown";
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
import { $findMatchingParent, $getSelection, $isRangeSelection, CLEAR_HISTORY_COMMAND, COMMAND_PRIORITY_HIGH, COPY_COMMAND, CUT_COMMAND, KEY_ENTER_COMMAND, PASTE_COMMAND, SKIP_DOM_SELECTION_TAG } from "lexical";
import { useEffect, useRef } from "react";

interface MarkdownComposerProps {
  id: string;
  value: string;
  disabled: boolean;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}

export function MarkdownComposer(props: MarkdownComposerProps) {
  return <LexicalComposer initialConfig={{
    namespace: props.id,
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode],
    editorState: () => $convertFromMarkdownString(props.value, TRANSFORMERS, undefined, true),
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
        aria-label="Message your agent"
        aria-multiline="true"
        aria-disabled={props.disabled}
        aria-readonly={props.readOnly}
        aria-placeholder="Message your agent…"
        placeholder={<div className="composer-placeholder">Message your agent…</div>}
      />} />
    </div>
    <HistoryPlugin />
    <ListPlugin />
    <LinkPlugin />
    <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
    <ComposerSync {...props} />
  </LexicalComposer>;
}

function ComposerSync({ value, disabled, readOnly, onChange, onSend }: MarkdownComposerProps) {
  const [editor] = useLexicalComposerContext();
  const lastValue = useRef(value);

  useEffect(() => { editor.setEditable(!disabled && !readOnly); }, [editor, disabled, readOnly]);

  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    editor.update(() => $convertFromMarkdownString(value, TRANSFORMERS, undefined, true), {
      tag: ["external-draft", SKIP_DOM_SELECTION_TAG],
      onUpdate: () => editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined),
    });
  }, [editor, value]);

  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, event => {
    if (!event || event.isComposing || editor.isComposing()) return false;
    if (event.shiftKey) {
      event.preventDefault();
      // Use normal rich-text Enter so lists continue and new lines accept Markdown blocks.
      return editor.dispatchCommand(KEY_ENTER_COMMAND, null);
    }
    if (!window.matchMedia("(pointer: fine)").matches) return false;
    event.preventDefault();
    if (!disabled && !readOnly) onSend();
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor, disabled, readOnly, onSend]);

  useEffect(() => editor.registerCommand(PASTE_COMMAND, event => {
    if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
    const text = event.clipboardData.getData("text/plain");
    const selection = $getSelection();
    event.preventDefault();
    if (!text || !$isRangeSelection(selection)) return true;
    if ($findMatchingParent(selection.anchor.getNode(), $isCodeNode)) selection.insertRawText(text);
    else selection.insertNodes($generateNodesFromMarkdownString(text, TRANSFORMERS, true));
    return true;
  }, COMMAND_PRIORITY_HIGH), [editor]);

  useEffect(() => {
    const unregister = [COPY_COMMAND, CUT_COMMAND].map(command => editor.registerCommand(command, event => {
      if (!(event instanceof ClipboardEvent) || !event.clipboardData) return false;
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
      event.preventDefault();
      event.clipboardData.setData("text/plain", $convertSelectionToMarkdownString(TRANSFORMERS, selection, true));
      if (command === CUT_COMMAND && editor.isEditable()) selection.removeText();
      return true;
    }, COMMAND_PRIORITY_HIGH));
    return () => unregister.forEach(remove => remove());
  }, [editor]);

  return <OnChangePlugin ignoreSelectionChange ignoreHistoryMergeTagChange={false} onChange={(state, _editor, tags) => {
    if (tags.has("external-draft")) return;
    const markdown = state.read(() => $convertToMarkdownString(TRANSFORMERS, undefined, true));
    if (markdown !== lastValue.current) {
      lastValue.current = markdown;
      onChange(markdown);
    }
  }} />;
}
