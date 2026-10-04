import { Check, ChevronDown, CircleAlert, FilePenLine, FilePlus2, SquareTerminal, Wrench } from "lucide-react";
import { Component, lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toolOutput, type ToolActivity } from "../lib/tool-activity";
import { Spinner } from "./ui";

const FileDiff = lazy(() => import("./file-diff"));

export function ToolActivityView({ activity }: { activity: ToolActivity }) {
  if (activity.name === "bash") return <BashTerminal activity={activity} />;
  if (activity.name === "write" || activity.name === "edit") return <FileChange activity={activity} />;
  return <DefaultTool activity={activity} />;
}

function status(activity: ToolActivity) {
  const diagnostics = activity.diagnostics ?? activity.live?.diagnostics ?? [];
  if (diagnostics.some(item => item.code === "aborted")) return "Stopped";
  if (diagnostics.some(item => item.code === "interrupted")) return "Interrupted";
  if (activity.result) return activity.result.isError ? "Failed" : "Completed";
  if (activity.preparing) return "Preparing";
  if (activity.live?.status === "running") return "Running";
  if (activity.live?.status === "pending") return "Waiting";
  return "Result unavailable";
}

function BashTerminal({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(true);
  const outputRef = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const command = activity.call?.arguments.command;
  const label = status(activity);
  const active = label === "Running" || label === "Waiting" || label === "Preparing";
  const diagnostics = activity.diagnostics ?? activity.live?.diagnostics ?? [];
  const content = activity.result?.content ?? [];
  const output = toolOutput(activity);
  useLayoutEffect(() => {
    if (open && following.current && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output, open]);

  return <section className="bash-terminal" aria-label="Bash terminal">
    <button type="button" className="terminal-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <SquareTerminal size={15} /><span>Terminal</span>
      <span className="terminal-status">{active ? <Spinner /> : label === "Completed" ? <Check size={13} /> : <CircleAlert size={13} />}{label}</span>
      <ChevronDown size={14} className={open ? "terminal-chevron-open" : ""} />
    </button>
    {open ? <>
      <div className="terminal-command"><span aria-hidden="true">$</span><pre aria-label="Command">{typeof command === "string" ? command : activity.preparing ? "Preparing command…" : "Command unavailable"}</pre></div>
      {output ? <pre className="terminal-output" ref={outputRef} tabIndex={0} aria-label="Command output" onScroll={() => {
        const element = outputRef.current;
        if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}>{output}</pre> : <p className="terminal-empty">{active ? "Waiting for output…" : activity.result ? "No output." : "No recorded output."}</p>}
      {content.map((part, index) => part.type === "image" ? <img className="message-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="Image returned by the command" /> : null)}
      {activity.live?.droppedBytes || activity.live?.droppedLines ? <p className="terminal-diagnostic">Earlier live output was trimmed. Showing the latest output.</p> : null}
      {diagnostics.map((item, index) => <p className="terminal-diagnostic" key={index}><CircleAlert size={14} /><span>{item.message}</span></p>)}
    </> : null}
  </section>;
}

function FileChange({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(true);
  const writing = activity.name === "write";
  const args = activity.call?.arguments;
  const path = typeof args?.path === "string" ? args.path : "File";
  const content = typeof args?.content === "string" ? args.content : undefined;
  const details = activity.result?.details;
  const patch = details && typeof details === "object" && "patch" in details && typeof details.patch === "string" ? details.patch : undefined;
  const recordedDiff = details && typeof details === "object" && "diff" in details && typeof details.diff === "string" ? details.diff : undefined;
  const label = status(activity);
  const active = label === "Running" || label === "Waiting" || label === "Preparing";
  const diagnostics = activity.diagnostics ?? activity.live?.diagnostics ?? [];
  const lineCount = useMemo(() => content ? content.split("\n").length - Number(content.endsWith("\n")) : 0, [content]);
  const source = writing ? content : patch;
  const hasPreview = source !== undefined;
  const output = toolOutput(activity);
  const fallback = <pre className="file-change-raw" tabIndex={0}>{source}</pre>;

  return <section className="file-change" aria-label={`${writing ? "Write" : "Edit"} ${path}`}>
    <button type="button" className="file-change-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {writing ? <FilePlus2 size={16} /> : <FilePenLine size={16} />}
      <span className="file-change-title"><strong>{path}</strong><span>{writing ? content === undefined ? "Write" : `Write · ${lineCount} ${lineCount === 1 ? "line" : "lines"}` : "Edit"}</span></span>
      <span className={`file-change-status file-change-status-${label.toLowerCase().replaceAll(" ", "-")}`}>
        {active ? <Spinner /> : label === "Completed" ? <Check size={13} /> : <CircleAlert size={13} />}{label}
      </span>
      <ChevronDown size={14} className={open ? "terminal-chevron-open" : ""} />
    </button>
    {open ? <>
      {writing && label !== "Completed" && hasPreview ? <p className="file-change-note">Requested content{active ? " · awaiting completion" : " · completion not confirmed"}</p> : null}
      {hasPreview ? source === "" ? <p className="file-change-note">{writing ? "Empty file." : "No recorded changes."}</p> :
        <DiffBoundary key={activity.result ? "recorded" : "preparing"} fallback={<><p className="file-change-note">The formatted view is unavailable. Recorded source is shown below.</p>{fallback}</>}>
          <Suspense fallback={<p className="file-change-note"><Spinner /> Loading changes…</p>}>
            {writing ? <FileDiff kind="write" path={path} content={content!} /> : <FileDiff kind="edit" path={path} patch={patch!} />}
          </Suspense>
        </DiffBoundary> : active ? <p className="file-change-note">{writing ? "Preparing file content…" : "Waiting for the recorded changes…"}</p> : !activity.result ? <p className="file-change-note">No recorded content is available.</p> : null}
      {(!hasPreview || label !== "Completed") && output ? <pre className="file-change-raw" tabIndex={0}>{output}</pre> : null}
      {activity.result?.content.map((part, index) => part.type === "image" ? <img className="message-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="Image returned by the file tool" /> : null)}
      {!writing && !patch && recordedDiff ? <pre className="file-change-raw" tabIndex={0}>{recordedDiff}</pre> : null}
      {diagnostics.map((item, index) => <p className="file-change-note" key={index}><CircleAlert size={14} /><span>{item.message}</span></p>)}
    </> : null}
  </section>;
}

class DiffBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// Keep other tools generic until their individual presentations are designed.
function DefaultTool({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  return <details className={`tool-entry ${activity.result?.isError ? "tool-error" : ""}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Wrench size={15} />{activity.name}<span>{status(activity)}</span></summary>
    {open && (activity.result ? activity.result.content.map((part, index) => part.type === "text" ? <pre key={index}>{part.text}</pre> : <img className="message-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="Image returned by the tool" />) : activity.live?.output ? <pre>{activity.live.output}</pre> : null)}
  </details>;
}
