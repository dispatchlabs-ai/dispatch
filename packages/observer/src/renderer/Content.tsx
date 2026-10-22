import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { UI } from "./controls";
import type { Activity } from "../shared/contracts";

export function CodeBlock({
  text,
  label = "Saved output",
}: {
  text: string;
  label?: string;
}) {
  return (
    <pre tabIndex={0} aria-label={label}>
      <code>{text}</code>
    </pre>
  );
}

function RecordedLink({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  try {
    const url = new URL(href ?? "");
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return (
        <UI.Button
          variant="link"
          className="content-link"
          title={url.href}
          onClick={() => void window.observer.external(url.href)}
        >
          {children}
        </UI.Button>
      );
  } catch {
    /* Relative paths and unsupported links remain text. */
  }
  return <span>{children}</span>;
}

export function MessageContent({ text }: { text: string }) {
  return (
    <div className="message-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <RecordedLink href={href}>{children}</RecordedLink>
          ),
          img: ({ src, alt }) => (
            <RecordedLink href={typeof src === "string" ? src : undefined}>
              {alt || "Recorded image"}
            </RecordedLink>
          ),
          pre: ({ children }) => (
            <pre tabIndex={0} aria-label="Code block">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Table"
            >
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Decode only valid JSON objects/arrays. Literal backslashes in ordinary output
// (including source code) must not be replaced as if they were JSON escapes.
function structured(text: string): unknown {
  if (!/^\s*[\[{]/.test(text)) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function textEnvelope(
  value: unknown,
): value is Record<string, unknown> & { text: string } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "text" in value &&
    typeof value.text === "string"
  );
}

export function outputPreview(text: string): string {
  const value = structured(text);
  return (textEnvelope(value) ? value.text : text)
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

export function ToolText({ text }: { text: string }) {
  const value = structured(text);
  if (textEnvelope(value)) {
    const { text: body, ...metadata } = value;
    return (
      <>
        <CodeBlock text={body} />
        {Object.keys(metadata).length > 0 && (
          <details className="output-metadata">
            <summary>Additional result fields</summary>
            <CodeBlock
              text={JSON.stringify(metadata, null, 2)}
              label="Additional result fields"
            />
          </details>
        )}
      </>
    );
  }
  return (
    <CodeBlock
      text={value === undefined ? text : JSON.stringify(value, null, 2)}
    />
  );
}

export function ToolResult({ activity }: { activity: Activity }) {
  const result = activity.tool?.result;
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    return (
      <>
        {result.content.map((part: unknown, index: number) =>
          part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string" ? (
            <ToolText key={index} text={part.text} />
          ) : (
            <CodeBlock
              key={index}
              text={JSON.stringify(part, null, 2)}
              label="Retained content block"
            />
          ),
        )}
        {result.content.length === 0 && (
          <p className="hint">No text in the saved result.</p>
        )}
      </>
    );
  }
  return activity.text ? (
    <ToolText text={activity.text} />
  ) : (
    <p className="hint">No text in the saved result.</p>
  );
}
