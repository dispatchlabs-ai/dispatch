import { useEffect, useRef, useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import type { Activity, Conversation } from "../shared/contracts";
import { TranscriptEntry, toolTitle } from "./TranscriptEntry";

export function Transcript({
  events,
  conversations,
  activeId,
  inspect,
  onRead,
}: {
  events: Activity[];
  conversations: Conversation[];
  activeId?: string;
  inspect(item: Activity): void;
  onRead(): void;
}) {
  const groups: Activity[][] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (
      event.tool &&
      previous?.[0].tool &&
      previous[0].conversationId === event.conversationId
    )
      previous.push(event);
    else groups.push([event]);
  }
  return groups.map((group) => {
    const author = conversations
      .find((c) => c.id === group[0].conversationId)
      ?.agent?.replace(/[-_]/g, " ");
    const entries = group.map((item) => (
      <TranscriptEntry
        key={item.id}
        item={item}
        author={author}
        active={activeId === item.id}
        inspect={() => inspect(item)}
        onRead={onRead}
      />
    ));
    return group[0].tool ? (
      <ToolGroup
        key={group[0].id}
        events={group}
        activeId={activeId}
        onRead={onRead}
      >
        {entries}
      </ToolGroup>
    ) : (
      entries
    );
  });
}

function ToolGroup({
  events,
  activeId,
  onRead,
  children,
}: {
  events: Activity[];
  activeId?: string;
  onRead(): void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  const active = events.some((item) => item.id === activeId);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active, activeId]);
  useEffect(() => {
    if (active && open)
      ref.current
        ?.querySelector<HTMLElement>(`[data-event-id="${activeId}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, activeId, open]);
  const calls = new Set(events.map((item) => item.tool!.callId));
  const failures = events.filter(
    (item) => item.tool?.phase === "result" && item.tool.error,
  ).length;
  const names = [...new Set(events.map(toolTitle))];
  return (
    <details
      className="tool-group"
      ref={ref}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary onClick={onRead}>
        <ChevronRight size={15} className="tool-group-chevron" />
        <Terminal size={16} />
        <span>
          <strong>
            {calls.size} tool {calls.size === 1 ? "call" : "calls"}
          </strong>
          <small>{names.join(" · ")}</small>
        </span>
        {failures > 0 && (
          <span className="tool-error">
            {failures} saved {failures === 1 ? "error" : "errors"}
          </span>
        )}
      </summary>
      <div className="tool-group-content">{children}</div>
    </details>
  );
}
