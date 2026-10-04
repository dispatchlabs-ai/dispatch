import { Virtualizer, type VirtualFileMetrics } from "@pierre/diffs";
import { MultiFileDiff, PatchDiff, VirtualizerContext, WorkerPoolContextProvider, type FileDiffOptions, type WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import { memo, useCallback, useMemo, useState, type ReactNode } from "react";

type FileDiffProps = { kind: "write"; path: string; content: string } | { kind: "edit"; path: string; patch: string };

const options: FileDiffOptions<undefined, undefined> = {
  theme: "github-light", themeType: "light", diffStyle: "unified", diffIndicators: "classic",
  disableBackground: false, disableFileHeader: true, overflow: "wrap", hunkSeparators: "metadata",
  disableErrorHandling: true,
};
const metrics: VirtualFileMetrics = { lineHeight: 21, diffHeaderHeight: 0, hunkLineCount: 100, spacing: 8 };
const poolOptions = { workerFactory: () => new Worker(WorkerUrl, { type: "module" }) };
const highlighterOptions: WorkerInitializationRenderOptions = { theme: "github-light" };

export default memo(function FileDiff(props: FileDiffProps) {
  const content = props.kind === "write" ? props.content : "";
  const newFile = useMemo(() => ({ name: props.path, contents: content }), [props.path, content]);
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
    <DiffViewport label={`${props.kind === "write" ? "Written content" : "Recorded changes"} for ${props.path}`}>
      {props.kind === "write" ? <MultiFileDiff oldFile={null} newFile={newFile} options={options} metrics={metrics} /> : <PatchDiff patch={props.patch} options={options} metrics={metrics} />}
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
