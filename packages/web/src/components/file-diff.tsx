import { DEFAULT_VIRTUAL_FILE_METRICS, Virtualizer, type VirtualFileMetrics } from "@pierre/diffs";
import { MultiFileDiff, PatchDiff, VirtualizerContext, type FileDiffOptions } from "@pierre/diffs/react";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";

import { PierreProvider } from "./pierre";

type FileDiffProps = { kind: "compare"; path: string; before: string; after: string } | { kind: "write"; path: string; content: string } | { kind: "edit"; path: string; patch: string; showFileHeader?: boolean } | { kind: "read"; path: string; content: string; firstLine: number; lineCount: number };

const options: FileDiffOptions<undefined, undefined> = {
  theme: "github-light", themeType: "light", diffStyle: "unified", diffIndicators: "classic",
  disableBackground: false, disableFileHeader: true, overflow: "wrap", hunkSeparators: "metadata",
  disableErrorHandling: true,
};
const metrics: VirtualFileMetrics = { lineHeight: 21, diffHeaderHeight: 0, hunkLineCount: 100, spacing: 8 };
const headerMetrics: VirtualFileMetrics = { ...metrics, diffHeaderHeight: DEFAULT_VIRTUAL_FILE_METRICS.diffHeaderHeight };
const headerOptions = { ...options, disableFileHeader: false };
const readOptions: FileDiffOptions<undefined, undefined> = { ...options, diffIndicators: "none", disableBackground: true, hunkSeparators: "simple" };

export default memo(function FileDiff(props: FileDiffProps) {
  const content = props.kind === "compare" ? props.after : props.kind === "edit" ? "" : props.content;
  const oldContent = props.kind === "compare" ? props.before : "";
  const oldFile = useMemo(() => ({ name: props.path, contents: oldContent }), [props.path, oldContent]);
  const newFile = useMemo(() => ({ name: props.path, contents: content }), [props.path, content]);
  const firstLine = props.kind === "read" ? props.firstLine : 1;
  const lineCount = props.kind === "read" ? props.lineCount : 0;
  const readPatch = useMemo(() => {
    if (lineCount === 0) return "";
    // A context-only hunk gives a read excerpt its original file line numbers.
    const name = JSON.stringify(props.path);
    const lines = content.split("\n").slice(0, lineCount).map(line => ` ${line}`).join("\n");
    return `--- ${name}\n+++ ${name}\n@@ -${firstLine},${lineCount} +${firstLine},${lineCount} @@\n${lines}\n`;
  }, [props.path, content, firstLine, lineCount]);
  return <PierreProvider>
    <DiffViewport label={`${props.kind === "write" ? "Written content" : props.kind === "read" ? "Read content" : "Recorded changes"} for ${props.path}`}>
      {props.kind === "compare" ? <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} metrics={metrics} /> : props.kind === "write" ? <MultiFileDiff oldFile={null} newFile={newFile} options={options} metrics={metrics} /> : <PatchDiff patch={props.kind === "read" ? readPatch : props.patch} options={props.kind === "read" ? readOptions : props.showFileHeader ? headerOptions : options} metrics={props.kind === "edit" && props.showFileHeader ? headerMetrics : metrics} />}
    </DiffViewport>
  </PierreProvider>;
});

// Own the scroll element so keyboard users can focus the virtualized code region.
function DiffViewport({ children, label }: { children: ReactNode; label: string }) {
  const [virtualizer] = useState(() => typeof window === "undefined" ? undefined : new Virtualizer());
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (node) virtualizer?.setup(node);
    else virtualizer?.cleanUp();
  }, [virtualizer]);
  return <VirtualizerContext.Provider value={virtualizer}>
    <div className="file-diff-viewport" role="region" aria-label={label} tabIndex={0} ref={ref}><div>{children}</div></div>
  </VirtualizerContext.Provider>;
}
