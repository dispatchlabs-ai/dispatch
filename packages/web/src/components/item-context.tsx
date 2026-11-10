const labels = ['Title', 'Summary', 'Source', 'Source URL'] as const;
type Label = typeof labels[number];

/** Shows a keyed item's context as readable content: its title, summary and source. */
export function ItemContext({title, context}: {title: string; context: string}) {
  const fields = new Map<Label, string>();
  const other: string[] = [];
  let current: Label | undefined;
  for (const line of context.split('\n')) {
    const match = /^(Title|Summary|Source|Source URL):\s?(.*)$/.exec(line);
    if (match && !fields.has(match[1] as Label)) { current = match[1] as Label; fields.set(current, match[2]); }
    else if (current) fields.set(current, `${fields.get(current)}\n${line}`);
    else other.push(line);
  }
  const value = (label: Label) => { const text = fields.get(label)?.trim(); return text && text !== 'None' ? text : undefined; };
  const href = value('Source URL');
  const source = value('Source');
  const body = [value('Summary'), other.join('\n').trim()].filter(Boolean);
  return <section className="item-context" aria-label="About this item">
    <h2>{value('Title') ?? title}</h2>
    {body.map((text, index) => <p key={index}>{text}</p>)}
    {(source || href) && <p className="item-source">{href?.startsWith('https://') ? <a href={href} target="_blank" rel="noreferrer">{source ?? href}</a> : source ?? href}</p>}
  </section>;
}
