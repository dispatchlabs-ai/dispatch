import { Virtualizer, type VirtualFileMetrics } from "@pierre/diffs";
import { MultiFileDiff, PatchDiff, VirtualizerContext, WorkerPoolContextProvider, type FileDiffOptions, type WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";

type FileDiffProps = { kind: "write"; path: string; content: string } | { kind: "edit"; path: string; patch: string } | { kind: "read"; path: string; content: string; firstLine: number; lineCount: number };

const options: FileDiffOptions<undefined, undefined> = {
  theme: "github-light", themeType: "light", diffStyle: "unified", diffIndicators: "classic",
  disableBackground: false, disableFileHeader: true, overflow: "wrap", hunkSeparators: "metadata",
  disableErrorHandling: true,
};
const metrics: VirtualFileMetrics = { lineHeight: 21, diffHeaderHeight: 0, hunkLineCount: 100, spacing: 8 };
const poolOptions = { workerFactory: () => new Worker(WorkerUrl, { type: "module" }) };
const highlighterOptions: WorkerInitializationRenderOptions = { theme: "github-light" };
const readOptions: FileDiffOptions<undefined, undefined> = { ...options, diffIndicators: "none", disableBackground: true, hunkSeparators: "simple" };

export default memo(function FileDiff(props: FileDiffProps) {
  const content = props.kind !== "edit" ? props.content : "";
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
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
    <DiffViewport label={`${props.kind === "write" ? "Written content" : props.kind === "read" ? "Read content" : "Recorded changes"} for ${props.path}`}>
      {props.kind === "write" ? <MultiFileDiff oldFile={null} newFile={newFile} options={options} metrics={metrics} /> : <PatchDiff patch={props.kind === "read" ? readPatch : props.patch} options={props.kind === "read" ? readOptions : options} metrics={metrics} />}
    </DiffViewport>
  </WorkerPoolContextProvider>;
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
