import { Check, ChevronDown, CircleAlert, SquareTerminal, Wrench } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ToolActivity } from "../lib/tool-activity";
import { Spinner } from "./ui";

export function ToolActivityView({ activity }: { activity: ToolActivity }) {
  return activity.name === "bash" ? <BashTerminal activity={activity} /> : <DefaultTool activity={activity} />;
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
  // Pi appends this exact diagnostic block to model context. Show it once, as diagnostics.
  const diagnosticText = `<harness>\n${diagnostics.map(item => `[${item.severity}] ${item.message}`).join("\n")}\n</harness>`;
  const output = activity.result ? content.filter((part, index) => !(diagnostics.length && index === content.length - 1 && part.type === "text" && part.text === diagnosticText)).filter(part => part.type === "text").map(part => part.text).join("\n") : activity.live?.output ?? "";
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
      <DebugData value={{ arguments: activity.call?.arguments, result: activity.result, live: activity.live, diagnostics }} />
    </> : null}
  </section>;
}

// Keep other tools generic until their individual presentations are designed.
function DefaultTool({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  return <details className={`tool-entry ${activity.result?.isError ? "tool-error" : ""}`} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Wrench size={15} />{activity.name}<span>{status(activity)}</span></summary>
    {open ? <>
      {activity.call ? <DebugData label="Call arguments" value={activity.call.arguments} /> : null}
      {activity.result ? activity.result.content.map((part, index) => part.type === "text" ? <pre key={index}>{part.text}</pre> : <img className="message-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="Image returned by the tool" />) : activity.live?.output ? <pre>{activity.live.output}</pre> : null}
      <DebugData value={{ result: activity.result, live: activity.live, diagnostics: activity.diagnostics }} />
    </> : null}
  </details>;
}

function DebugData({ value, label = "Debug data" }: { value: unknown; label?: string }) {
  const [open, setOpen] = useState(false);
  return <details className="tool-debug" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>{open ? <pre>{JSON.stringify(value, null, 2)}</pre> : null}
  </details>;
}
