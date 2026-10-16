import type { Meta, StoryObj } from "@storybook/react-vite";
import { UI } from "../components/ui";
import { Example, WorkshopPage } from "./frame";

const meta = {
  title: "Foundations",
  parameters: { controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const palette = [
  ["Navy", "#1d3d6a", "Actions & navigation"],
  ["Aqua", "#4dd5cf", "Brand accent"],
  ["Ink", "#10243f", "Primary text"],
  ["Muted", "#53647b", "Supporting text"],
  ["Canvas", "#f9fafc", "Page background"],
  ["Surface", "#ffffff", "Cards & controls"],
  ["Success", "#15694f", "Completed work"],
  ["Warning", "#805715", "Needs attention"],
  ["Danger", "#a32b35", "Errors & destructive actions"],
];

export const Tokens: Story = {
  render: () => (
    <WorkshopPage
      title="One visual language."
      description="The existing Dispatch palette, Inter typeface and spacing scale, carried into the shadcn components."
    >
      <Example
        title="Color"
        description="Status always includes a label. Aqua is an accent; primary actions and small text use the darker palette."
      >
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
          {palette.map(([name, color, use]) => (
            <div key={name}>
              <div
                className="mb-3 h-20 rounded-lg border border-border"
                style={{ backgroundColor: color }}
              />
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="text-sm font-medium">{name}</span>
                <code className="text-xs text-muted-foreground">{color}</code>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{use}</p>
            </div>
          ))}
        </div>
      </Example>
      <Example
        title="Typography"
        description="Clear hierarchy in application chrome; a separate reading rhythm for longer content."
      >
        <div className="flex flex-col gap-5">
          <p className="text-3xl font-semibold tracking-tight">
            Make room for what’s next.
          </p>
          <p className="text-xl font-semibold">A clear page title</p>
          <p className="text-base font-semibold">A useful section heading</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Supporting copy explains the next decision without competing with
            the work.
          </p>
          <code className="text-xs">npm run build</code>
        </div>
      </Example>
      <div className="grid gap-6 md:grid-cols-2">
        <Example
          title="Spacing"
          description="A 4 px rhythm, with room between sections."
        >
          <div className="flex flex-wrap items-end gap-6">
            {[4, 8, 12, 16, 24, 32, 48].map((size) => (
              <div key={size} className="flex flex-col items-center gap-2">
                <div
                  className="w-5 rounded bg-primary"
                  style={{ height: size }}
                />
                <span className="text-xs text-muted-foreground">{size}</span>
              </div>
            ))}
          </div>
        </Example>
        <Example
          title="Surfaces"
          description="Quiet borders, restrained shadows and consistent corners."
        >
          <div className="rounded-xl border border-border bg-background p-5">
            <div className="rounded-lg border border-border bg-card p-5 shadow-sm">
              <UI.Badge tone="success">Ready for review</UI.Badge>
              <p className="mt-3 text-sm">Depth helps explain structure.</p>
            </div>
          </div>
        </Example>
      </div>
    </WorkshopPage>
  ),
};

const document = `## A useful answer, clearly presented

Keep the **decision** close to its evidence. Supporting details can follow without obscuring the next step.

- Use consistent controls.
- Preserve the reader’s place as content streams.
- Keep long tables and code inside their own scroll area.

> A shared component should make the next screen easier to build.

| Component | Purpose | State |
| --- | --- | --- |
| Message | Attributed conversation | Ready to review |
| Trace | Expandable activity | Ready to review |

\`\`\`typescript
const outcome = { state: "ready", component: "Message", source: "shadcn/chatbot-template" };
\`\`\`

Read the [template source](https://github.com/shadcn-ui/chatbot-template) for the starting point.`;

export const Reading: Story = {
  render: () => (
    <WorkshopPage
      title="A shared reading rhythm."
      description="Typeset styles the same Markdown renderer used by Dispatch, including its link handling, mentions and scrollable tables."
      origin="shadcn template"
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <Example title="Conversation">
          <UI.MarkdownBody>{document}</UI.MarkdownBody>
        </Example>
        <Example title="Instructions & specifications">
          <UI.MarkdownBody format="document">{document}</UI.MarkdownBody>
        </Example>
      </div>
    </WorkshopPage>
  ),
};
