import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import { EditProvider, File, type FileOptions } from "@pierre/diffs/react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { PierreProvider } from "./pierre";

interface CodeEditorProps {
  /** Full document/revision/session identity; remount with a new React key to reset. */
  documentId: string;
  path: string;
  initialValue: string;
  readOnly?: boolean;
  /** Focus only after an explicitly requested edit attachment becomes usable. */
  autoFocus?: boolean;
  label: string;
  onChange?: (text: string) => void;
}

const options: FileOptions<undefined, undefined> = {
  theme: "github-light", themeType: "light", disableFileHeader: true,
  overflow: "wrap", disableErrorHandling: true,
};

const createEditor: EditorFactory<undefined, undefined> = (type, editorOptions) => new Editor(type, editorOptions);

export default memo(function CodeEditor({ documentId, ...props }: CodeEditorProps) {
  return <EditorSession key={documentId} {...props} />;
});

// This is initialized source, not a controlled input. Never feed keystrokes back
// into Pierre's file prop. The caller owns draft persistence and preview state.
function EditorSession({ path, initialValue, readOnly = false, autoFocus = false, label, onChange }: Omit<CodeEditorProps, "documentId">) {
  const [file] = useState(() => ({ name: path, contents: initialValue }));
  const shouldFocus = useRef(false);
  shouldFocus.current = autoFocus && !readOnly;
  const onAttach = useCallback((editor: Editor<"file", undefined, undefined>) => {
    if (shouldFocus.current) editor.focus({ preventScroll: true });
  }, []);
  const editorOptions = useMemo(() => ({
    onAttach, ariaLabel: label, spellcheck: /\.(?:md|markdown|mdx|txt|rst)$/i.test(path),
    tabBehavior: "focus" as const, autoSurround: "never" as const,
  }), [label, path, onAttach]);
  return <PierreProvider><EditProvider createEditor={createEditor}>
    <div className="code-editor-viewport" role="region" aria-label={label} tabIndex={readOnly ? 0 : undefined}>
      <File file={file} options={options} editorOptions={editorOptions} edit={!readOnly}
        onEditChange={event => onChange?.(event.file.contents)}
        onEditComplete={() => "accept"} />
    </div>
  </EditProvider></PierreProvider>;
}
