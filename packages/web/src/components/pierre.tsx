import { WorkerPoolContextProvider, type WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import WorkerUrl from "@pierre/diffs/worker/worker.js?worker&url";
import type { ReactNode } from "react";

const poolOptions = { workerFactory: () => new Worker(WorkerUrl, { type: "module" }) };
const highlighterOptions: WorkerInitializationRenderOptions = { theme: "github-light" };

export function PierreProvider({ children }: { children: ReactNode }) {
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>{children}</WorkerPoolContextProvider>;
}
