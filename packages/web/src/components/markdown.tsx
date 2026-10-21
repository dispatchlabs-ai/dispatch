import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { mentionId, type MentionParticipant } from "../lib/mentions";

export function Markdown({ children, mentions = [], className = "markdown" }: { children: string; mentions?: MentionParticipant[]; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => key === "href" && mentionId(url) ? url : defaultUrlTransform(url)}
        components={{
          a: ({ children, href }) => {
            const id = href ? mentionId(href) : null;
            if (id) {
              const person = mentions.find(person => person.id === id);
              return <span className={person ? "inline-mention" : undefined} title={person ? `${person.name} · ${person.kind === "agent" ? "Agent" : "Person"}` : undefined}>{person ? `@${person.name}` : children}</span>;
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
          img: ({ src, alt }) => <a href={src} target="_blank" rel="noreferrer">{alt || "View image"}</a>,
          pre: ({ children }) => <pre tabIndex={0} aria-label="Code block">{children}</pre>,
          table: ({ children }) => <div className="table-scroll" tabIndex={0} role="region" aria-label="Table"><table>{children}</table></div>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
