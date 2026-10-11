import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { Attachment } from "../shared/contracts";

const PatchPreview = lazy(() => import("./patch-preview"));
const PATCH_PREVIEW_MAX_BYTES = 256 * 1024;

export function PatchAttachment({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ patch: string } | { error: string }>();
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void (async () => {
      try {
        if (attachment.size > PATCH_PREVIEW_MAX_BYTES) throw new Error("Preview limited to 256 KiB. Open the patch to review it.");
        const response = await fetch(attachment.url, { signal: controller.signal });
        if (!response.ok) throw new Error("Could not load the patch. Retry or open it separately.");
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > PATCH_PREVIEW_MAX_BYTES) throw new Error("Preview limited to 256 KiB. Open the patch to review it.");
        const patch = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!controller.signal.aborted) setResult({ patch });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : "Patch preview unavailable." });
      }
    })();
    return () => controller.abort();
  }, [attachment.url, attachment.size, attempt]);

  return <section className="patch-attachment" aria-label={`Diff preview: ${attachment.name}`}>
    <div className="patch-attachment-heading">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "Hide diff" : "Show diff"} · {attachment.name}</button>
      <a href={attachment.url} target="_blank" rel="noopener noreferrer">Open patch<span className="sr-only"> (opens in a new tab)</span></a>
    </div>
    {open ? <>
      {!result ? <p className="patch-attachment-note" role="status">Loading diff…</p> : "error" in result ? <p className="patch-attachment-note" role="status">{result.error} <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button></p> :
        <PatchBoundary key={attempt}>
          <Suspense fallback={<p className="patch-attachment-note" role="status">Loading diff renderer…</p>}>
            <PatchPreview patch={result.patch} path={attachment.name} />
          </Suspense>
        </PatchBoundary>}
    </> : null}
  </section>;
}

class PatchBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p className="patch-attachment-note" role="status">Diff preview unavailable. Open the patch to review the original.</p> : this.props.children;
  }
}
