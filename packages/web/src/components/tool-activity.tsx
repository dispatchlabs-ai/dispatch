import { Check, ChevronDown, CircleAlert, FilePenLine, FilePlus2, FileText, SquareTerminal, Wrench } from "lucide-react";
import { Component, lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toolOutput, type ToolActivity } from "../lib/tool-activity";
import { Spinner } from "./ui";

const FileDiff = lazy(() => import("./file-diff"));

export function ToolActivityView({ activity, authorName }: { activity: ToolActivity; authorName?: string }) {
  if (activity.name === "bash") return <BashTerminal activity={activity} />;
  if (activity.name === "write" || activity.name === "edit" || activity.name === "read") return <FileTool activity={activity} />;
  return <DefaultTool activity={activity} authorName={authorName} />;
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

function FileTool({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(true);
  const writing = activity.name === "write";
  const reading = activity.name === "read";
  const operation = writing ? "Write" : reading ? "Read" : "Edit";
  const label = status(activity);
  const output = toolOutput(activity);
  const args = activity.call?.arguments;
  const path = typeof args?.path === "string" ? args.path : "File";
  const content = reading ? label === "Completed" ? output : undefined : typeof args?.content === "string" ? args.content : undefined;
  const details = activity.result?.details;
  const patch = details && typeof details === "object" && "patch" in details && typeof details.patch === "string" ? details.patch : undefined;
  const recordedDiff = details && typeof details === "object" && "diff" in details && typeof details.diff === "string" ? details.diff : undefined;
  const truncation = details && typeof details === "object" && "truncation" in details ? details.truncation : undefined;
  const readTruncation = truncation && typeof truncation === "object" ? truncation : undefined;
  const reportedLines = readTruncation && "outputLines" in readTruncation && typeof readTruncation.outputLines === "number" ? readTruncation.outputLines : undefined;
  const partialLine = readTruncation && (("firstLineExceedsLimit" in readTruncation && readTruncation.firstLineExceedsLimit === true) || ("lastLinePartial" in readTruncation && readTruncation.lastLinePartial === true));
  const firstLine = activity.call ? typeof args?.offset === "number" && Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 1 : undefined;
  const active = label === "Running" || label === "Waiting" || label === "Preparing";
  const diagnostics = activity.diagnostics ?? activity.live?.diagnostics ?? [];
  // Pi 1.0.1 reports a completed requested range through its continuation diagnostic.
  const limitReached = reading && diagnostics.some(item => /^\d+ more lines in file\. Use offset=\d+ to continue\.$/.test(item.message));
  const returnedLines = reportedLines ?? (limitReached ? args?.limit : undefined);
  const lineCount = useMemo(() => {
    const count = content ? content.split("\n").length - Number(content.endsWith("\n")) : 0;
    // A bounded range can end on a blank line without a final newline terminator.
    return reading && (content === "" || content?.endsWith("\n")) && returnedLines === count + 1 ? count + 1 : count;
  }, [content, reading, returnedLines]);
  const source = writing || reading ? content : patch;
  const hasPreview = source !== undefined;
  const fallback = <pre className="file-change-raw" tabIndex={0}>{source}</pre>;
  const lineSummary = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
  const range = reading && content !== undefined && lineCount > 0 && firstLine !== undefined ? ` · ${lineCount === 1 ? `line ${firstLine}` : `lines ${firstLine}–${firstLine + lineCount - 1}`}` : "";

  return <section className="file-change" aria-label={`${operation} ${path}`}>
    <button type="button" className="file-change-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {writing ? <FilePlus2 size={16} /> : reading ? <FileText size={16} /> : <FilePenLine size={16} />}
      <span className="file-change-title"><strong>{path}</strong><span>{operation}{content !== undefined && (writing || reading) ? ` · ${lineSummary}${range}${reading && partialLine ? " · partial line" : ""}` : ""}</span></span>
      <span className={`file-change-status file-change-status-${label.toLowerCase().replaceAll(" ", "-")}`}>
        {active ? <Spinner /> : label === "Completed" ? <Check size={13} /> : <CircleAlert size={13} />}{label}
      </span>
      <ChevronDown size={14} className={open ? "terminal-chevron-open" : ""} />
    </button>
    {open ? <>
      {writing && label !== "Completed" && hasPreview ? <p className="file-change-note">Requested content{active ? " · awaiting completion" : " · completion not confirmed"}</p> : null}
      {reading && hasPreview && firstLine === undefined ? <p className="file-change-note">Original file line numbers are unavailable; numbering the returned lines.</p> : null}
      {hasPreview ? source === "" && (!reading || lineCount === 0) ? <p className="file-change-note">{writing ? "Empty file." : reading ? "No text was returned." : "No recorded changes."}</p> :
        <DiffBoundary key={activity.result ? "recorded" : "preparing"} fallback={<><p className="file-change-note">The formatted view is unavailable. Recorded source is shown below.</p>{fallback}</>}>
          <Suspense fallback={<p className="file-change-note"><Spinner /> Loading {reading ? "file content" : "changes"}…</p>}>
            {reading ? <FileDiff kind="read" path={path} content={content!} firstLine={firstLine ?? 1} lineCount={lineCount} /> : writing ? <FileDiff kind="write" path={path} content={content!} /> : <FileDiff kind="edit" path={path} patch={patch!} />}
          </Suspense>
        </DiffBoundary> : active ? <p className="file-change-note">{writing ? "Preparing file content…" : reading ? "Reading file…" : "Waiting for the recorded changes…"}</p> : !activity.result ? <p className="file-change-note">No recorded content is available.</p> : null}
      {(!hasPreview || label !== "Completed") && output ? <pre className="file-change-raw" tabIndex={0}>{output}</pre> : null}
      {activity.result?.content.map((part, index) => part.type === "image" ? <img className="message-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="Image returned by the file tool" /> : null)}
      {!writing && !reading && !patch && recordedDiff ? <pre className="file-change-raw" tabIndex={0}>{recordedDiff}</pre> : null}
      {diagnostics.map((item, index) => <p className="file-change-note" key={index}><CircleAlert size={14} /><span>{item.message}</span></p>)}
    </> : null}
  </section>;
}

class DiffBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function toolSummary(activity: ToolActivity, completed: boolean) {
  // MCP names include the connection ID and a hash; match the registered wiki operation.
  if (/^mcp_.+_wiki_search_[a-f0-9]{10}$/.test(activity.name)) return completed ? "searched the wiki" : "Wiki search";
  if (/^mcp_.+_wiki_read_[a-f0-9]{10}$/.test(activity.name)) return completed ? "read the wiki" : "Wiki read";
  if (/^mcp_.+_wiki_save_[a-f0-9]{10}$/.test(activity.name)) return "Wiki save";
  if (activity.name === "conversation_history") return completed ? "read chat history" : "Conversation history";
  if (activity.name === "conversation_post") return "Conversation post";
  if (activity.name === "conversation_invite_agent") return "Agent invitation tools";
  return "Tool activity";
}

function DefaultTool({ activity, authorName }: { activity: ToolActivity; authorName?: string }) {
  const [open, setOpen] = useState(false);
  const label = status(activity);
  const diagnostics = activity.diagnostics ?? activity.live?.diagnostics ?? [];
  return <details className={`tool-entry ${label === "Failed" ? "tool-error" : ""}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><ChevronDown size={14} className={open ? "tool-chevron-open" : ""} /><Wrench size={15} /><span className="tool-summary-label">{authorName ? `${authorName} · ` : ""}{toolSummary(activity, label === "Completed")}</span><span className="tool-summary-status">{label}</span></summary>
    {open ? <div className="tool-technical-details">
      <p><strong>Tool</strong> <code>{activity.name}</code></p>
      {activity.call ? <details><summary>Arguments</summary><pre>{JSON.stringify(activity.call.arguments, null, 2)}</pre></details> : null}
      {activity.result ? activity.result.content.map((part, index) => part.type === "text" ? <pre key={index}>{part.text}</pre> : <img className="message-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="Image returned by the tool" />) : activity.live?.output ? <pre>{activity.live.output}</pre> : null}
      {activity.result?.details !== undefined ? <details><summary>Result details</summary><pre>{JSON.stringify(activity.result.details, null, 2)}</pre></details> : null}
      {diagnostics.map((item, index) => <p className="tool-diagnostic" key={index}><CircleAlert size={14} /><span>{item.message}</span></p>)}
    </div> : null}
  </details>;
}
