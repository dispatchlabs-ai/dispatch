import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { $isCodeNode } from "@lexical/code";
import { $isLinkNode } from "@lexical/link";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, MenuOption, type MenuRenderFn, type TriggerFn } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createTextNode, $findMatchingParent, $getRoot, $getSelection, $isRangeSelection, $isTextNode, BLUR_COMMAND, COMMAND_PRIORITY_CRITICAL, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND } from "lexical";
import { AtSign, CornerDownLeft } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { mentionLabel, type MentionParticipant } from "../lib/mentions";
import { $createMentionNode } from "./mention-node";
import { ParticipantAvatar } from "./conversation-people";
import { IconButton } from "./ui";

class MentionOption extends MenuOption {
  constructor(readonly person: MentionParticipant, readonly label: string) { super(person.id); }
}

const matchMention: TriggerFn = (text, editor) => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || editor.isComposing() || editor.getRootElement() !== document.activeElement) return null;
  const node = selection.anchor.getNode();
  if ($findMatchingParent(node, parent => $isCodeNode(parent) || $isLinkNode(parent)) || ($isTextNode(node) && node.hasFormat("code"))) return null;
  const match = /(?:^|[\s(])@([^@\n\r\t]{0,100})$/.exec(text);
  if (!match) return null;
  const query = match[1];
  return { leadOffset: text.length - query.length - 1, matchingString: query, replaceableString: `@${query}` };
};

export function MentionButton({ disabled }: { disabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  return <IconButton label="Mention someone" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => {
    editor.focus(() => editor.update(() => {
      const selection = $getSelection();
      const target = $isRangeSelection(selection) ? selection : $getRoot().selectEnd();
      const start = target.isBackward() ? target.focus : target.anchor;
      const node = start.getNode();
      const preceding = $isTextNode(node) ? node.getTextContent().slice(0, start.offset) : "";
      target.insertText(preceding && !/[\s(]$/.test(preceding) ? " @" : "@");
    }));
  }}><AtSign size={18} /></IconButton>;
}

type MenuProps = Parameters<MenuRenderFn<MentionOption>>[1];

export function MentionMenu({ options, selectedIndex, selectOptionAndCleanUp, setHighlightedIndex, query, menuRef }: MenuProps & { query: string; menuRef?: Ref<HTMLDivElement> }) {
  return <div className="mention-menu" ref={menuRef}>
    <div className="mention-menu-heading">Mention someone</div>
    <ul className="mention-options">
      {options.map((option, index) => <li key={option.key} id={`typeahead-item-${index}`} role="option" aria-selected={selectedIndex === index}
        className={`mention-option ${selectedIndex === index ? "selected" : ""}`} ref={option.setRefElement}
        onPointerDown={event => event.preventDefault()}
        onMouseEnter={() => setHighlightedIndex(index)} onClick={() => selectOptionAndCleanUp(option)}>
        <ParticipantAvatar kind={option.person.kind} name={option.person.name} />
        <span className="mention-option-name">{option.label}</span>
        <span className="mention-option-kind">{option.person.kind === "agent" ? "Agent" : "Person"}</span>
        {selectedIndex === index ? <CornerDownLeft size={14} className="mention-option-selected" aria-hidden="true" /> : null}
      </li>)}
      {!options.length ? <li className="mention-no-results" role="status">No one matches {query ? `“${query}”` : "your search"}.</li> : null}
    </ul>
    <div className="mention-menu-hint"><span>↑ ↓ to navigate</span><span>↵ to select</span><span>esc to close</span></div>
  </div>;
}

function PositionedMentionMenu(props: MenuProps & { query: string }) {
  const [editor] = useLexicalComposerContext();
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    const root = editor.getRootElement();
    if (!element || !root) return;
    let active = true;
    const reference = { contextElement: root, getBoundingClientRect: () => {
      const selection = window.getSelection();
      return selection?.rangeCount && root.contains(selection.anchorNode)
        ? selection.getRangeAt(0).getBoundingClientRect() : root.getBoundingClientRect();
    } };
    const update = () => { void computePosition(reference, element, {
      placement: "top-start", strategy: "fixed",
      middleware: [offset(8), flip(), shift({ padding: 12 }), size({ padding: 12, apply: ({ availableHeight, elements }) => {
        elements.floating.style.maxHeight = `${Math.max(0, Math.min(320, availableHeight))}px`;
      } })],
    }).then(({ x, y }) => { if (active) Object.assign(element.style, { left: `${x}px`, top: `${y}px`, visibility: "visible" }); }); };
    const stopPositioning = autoUpdate(reference, element, update);
    const stopEditing = editor.registerUpdateListener(update);
    return () => { active = false; stopPositioning(); stopEditing(); };
  }, [editor]);
  return <div className="mention-menu-positioner"><MentionMenu {...props} menuRef={menu} /></div>;
}

export function MentionsPlugin({ people }: { people: MentionParticipant[] }) {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [parent, setParent] = useState<HTMLElement>();
  useEffect(() => editor.registerRootListener(root => setParent(root?.parentElement ?? undefined)), [editor]);
  const options = useMemo(() => {
    const search = (query ?? "").trim().toLocaleLowerCase();
    return people.filter(person => person.name.toLocaleLowerCase().includes(search)).map(person => new MentionOption(person, mentionLabel(person, people)));
  }, [people, query]);
  const opened = useCallback(() => setOpen(true), []);
  const closed = useCallback(() => setOpen(false), []);

  useEffect(() => editor.registerCommand(BLUR_COMMAND, () => {
    // Use the typeahead's native dismissal handler while retaining the saved caret.
    editor.dispatchCommand(KEY_ESCAPE_COMMAND, new KeyboardEvent("keydown", { key: "Escape" }));
    return false;
  }, COMMAND_PRIORITY_HIGH), [editor]);

  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, event => {
    if (event?.isComposing || editor.isComposing()) return true;
    if (open && !options.length && event && !event.shiftKey) { event.preventDefault(); return true; }
    return false;
  }, COMMAND_PRIORITY_CRITICAL), [editor, open, options.length]);

  return <LexicalTypeaheadMenuPlugin<MentionOption> options={options} triggerFn={matchMention} onQueryChange={setQuery}
    commandPriority={COMMAND_PRIORITY_HIGH} onOpen={opened} onClose={closed} anchorClassName="mention-menu-anchor" parent={parent}
    onSelectOption={(option, node, close) => {
      if (!node) return;
      const mention = $createMentionNode(option.person.id, `@${option.label}`);
      node.replace(mention);
      mention.insertAfter($createTextNode(" ")).selectEnd();
      close();
    }}
    menuRenderFn={(anchor, props, query) => anchor.current ? createPortal(<PositionedMentionMenu {...props} query={query} />, anchor.current) : null}
  />;
}
