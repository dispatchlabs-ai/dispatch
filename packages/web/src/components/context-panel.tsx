export function ContextPanel({ kind }: {
  kind: "chat" | "project" | "agents" | "security" | "welcome";
}) {
  return <div className="context-empty">
    <header className="context-header">
      <h2>Details</h2>
    </header>
    <div className="context-body">
      <p>{kind === "chat" ? "Loading chat details…" : kind === "welcome" || kind === "project" ? "Open a chat to see its agent setup and run details." : "No supporting view for this page."}</p>
    </div>
  </div>;
}
