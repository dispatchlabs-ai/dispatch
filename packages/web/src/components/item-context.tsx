/**
 * Shows a keyed item's context as readable content: its title, summary and source.
 * Attention writes `Title:`, then `Summary:` (possibly multi-line), then `Source:`
 * and `Source URL:` last, so the source is read from the end and summary text
 * cannot supply it. Any other shape is shown as plain text.
 */
export function ItemContext({title, context}: {title: string; context: string}) {
  const lines = context.split('\n');
  const field = (index: number, label: string) => lines[index]?.startsWith(`${label}: `) ? lines[index].slice(label.length + 2).trim() : undefined;
  const shown = (text?: string) => text && text !== 'None' ? text : undefined;
  const last = lines.length - 1;
  const structured = lines.length >= 4 && field(0, 'Title') !== undefined && field(1, 'Summary') !== undefined
    && field(last - 1, 'Source') !== undefined && field(last, 'Source URL') !== undefined;
  if (!structured) return <section className="item-context" aria-label="About this item"><h2>{title}</h2><p>{context}</p></section>;
  const summary = [field(1, 'Summary'), ...lines.slice(2, last - 1)].join('\n').trim();
  const source = shown(field(last - 1, 'Source'));
  const href = shown(field(last, 'Source URL'));
  return <section className="item-context" aria-label="About this item">
    <h2>{shown(field(0, 'Title')) ?? title}</h2>
    {summary && <p>{summary}</p>}
    {(source || href) && <p className="item-source">{href?.startsWith('https://') ? <a href={href} target="_blank" rel="noreferrer">{source ?? href}</a> : source ?? href}</p>}
  </section>;
}
