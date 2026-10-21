import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ArrowRight,
  Blocks,
  Bot,
  Layers,
  MessageSquare,
  Search,
} from "lucide-react";
import { useState } from "react";
import { UI } from "../components/ui";
import { coverage } from "./coverage";
import { Example, StoryLink, templateUrl, WorkshopPage } from "./frame";

const meta = {
  title: "Start here",
  parameters: { controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: () => (
    <WorkshopPage
      title="Make it feel like Dispatch."
      description="A shared place to review the building blocks, try their different states, and agree on the patterns before they reach every screen."
      origin="Mixed"
    >
      <div className="grid gap-5 lg:grid-cols-2">
        {[
          {
            id: "screens-chat--conversation",
            title: "The conversation",
            body: "Messages, tool activity, attachments and a composer built from the chatbot template.",
            Icon: MessageSquare,
          },
          {
            id: "screens-agent-editor--editable",
            title: "The agent editor",
            body: "A consistent rhythm for fields, settings sections, resources and actions.",
            Icon: Bot,
          },
        ].map(({ id, title, body, Icon }) => (
          <StoryLink
            key={id}
            id={id}
            className="group flex flex-col rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/40 sm:p-8"
          >
            <span className="mb-6 flex size-12 items-center justify-center rounded-xl bg-secondary text-primary">
              <Icon className="size-6" />
            </span>
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
              {body}
            </p>
            <span className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary">
              Explore the example{" "}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </span>
          </StoryLink>
        ))}
      </div>
      <div className="grid gap-5 sm:grid-cols-3">
        {[
          {
            id: "foundations--tokens",
            title: "Foundations",
            body: "Color, type, spacing and surfaces.",
            Icon: Layers,
          },
          {
            id: "controls--buttons",
            title: "Shared controls",
            body: "Forms, actions, menus and feedback.",
            Icon: Blocks,
          },
          {
            id: "patterns--settings",
            title: "Product patterns",
            body: "The reusable pieces between controls and screens.",
            Icon: Bot,
          },
        ].map(({ id, title, body, Icon }) => (
          <StoryLink
            key={id}
            id={id}
            className="rounded-xl border border-border bg-card p-6 hover:border-primary/40"
          >
            <Icon className="mb-4 size-5 text-primary" />
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {body}
            </p>
          </StoryLink>
        ))}
      </div>
      <Example
        title="A starting point we can make our own"
        description="The shadcn chatbot template supplies real source, not just visual inspiration."
      >
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <p className="mb-3 text-sm font-medium">
              Already adapted into this workshop
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Buttons, inputs, select, input groups, empty states, alerts,
              tooltips, messages, bubbles, traces and Typeset. Message Scroller
              and Questionnaire have dedicated experiments.
            </p>
            <a
              href={templateUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block text-sm font-medium text-primary underline underline-offset-4"
            >
              Inspect the pinned template
            </a>
          </div>
          <div>
            <p className="mb-3 text-sm font-medium">
              The review comes before the rollout
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Every example uses synthetic data. Candidate components are ready
              to discuss; existing screens retain their current controls until
              reviewed migration.
            </p>
            <StoryLink
              id="start-here--coverage"
              className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-primary"
            >
              See the coverage map <ArrowRight className="size-4" />
            </StoryLink>
          </div>
        </div>
      </Example>
      <div className="rounded-xl bg-secondary p-6">
        <h2 className="text-base font-semibold text-primary">
          How we review together
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Start with the chat and agent editor. Try their empty, error and
          read-only examples from the sidebar. Then review the shared controls,
          keyboard behavior and phone layouts. Missing components stay visible
          in the coverage map.
        </p>
      </div>
    </WorkshopPage>
  ),
};

function CoverageMap() {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All areas");
  const groups = [...new Set(coverage.map((row) => row.group))];
  const filtered = coverage.filter(
    (row) =>
      (group === "All areas" || row.group === group) &&
      `${row.id} ${row.screen} ${row.components.join(" ")} ${row.remaining}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <WorkshopPage
      title="Know what’s covered."
      description="A refreshed map of the existing screen inventory, including the newer GitHub access screens. A component mapping is a starting point; every production screen still needs its own review."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-2xl font-semibold">{coverage.length}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Screen areas mapped
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-2xl font-semibold">2</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Complete example screens
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-2xl font-semibold">0</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Production screens accepted
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <UI.InputGroup className="h-10 flex-1">
          <UI.InputGroupAddon>
            <Search aria-hidden="true" />
          </UI.InputGroupAddon>
          <UI.InputGroupInput
            aria-label="Search coverage"
            placeholder="Find a screen or component…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </UI.InputGroup>
        <UI.Select
          value={group}
          onValueChange={(value) => setGroup(value ?? "All areas")}
        >
          <UI.SelectTrigger aria-label="Filter by area">
            <UI.SelectValue />
          </UI.SelectTrigger>
          <UI.SelectContent>
            {["All areas", ...groups].map((value) => (
              <UI.SelectItem key={value} value={value}>
                {value}
              </UI.SelectItem>
            ))}
          </UI.SelectContent>
        </UI.Select>
      </div>
      <div className="flex flex-col gap-3">
        {filtered.map((row) => (
          <section
            key={row.id}
            className="rounded-xl border border-border bg-card p-5"
          >
            <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
              <div className="min-w-0 flex-1">
                <p className="mb-1 text-xs text-muted-foreground">
                  {row.id} · {row.group}
                </p>
                <h2 className="text-sm font-semibold leading-relaxed">
                  {row.screen}
                </h2>
              </div>
              <UI.Badge tone={row.example ? "success" : "warning"}>
                {row.example ? "Example available" : "Mapped · needs example"}
              </UI.Badge>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {row.components.map((name) => (
                <span
                  key={name}
                  className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
                >
                  {name}
                </span>
              ))}
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">
                Still to qualify:
              </span>{" "}
              {row.remaining}.
            </p>
            {row.example ? (
              <StoryLink
                id={row.example}
                className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary"
              >
                Open example <ArrowRight className="size-4" />
              </StoryLink>
            ) : null}
          </section>
        ))}
      </div>
      {!filtered.length ? (
        <UI.Empty>
          <UI.EmptyHeader>
            <UI.EmptyTitle>No matching screens</UI.EmptyTitle>
            <UI.EmptyDescription>
              Try a different component name or area.
            </UI.EmptyDescription>
          </UI.EmptyHeader>
          <UI.EmptyContent>
            <UI.Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setGroup("All areas");
              }}
            >
              Clear filters
            </UI.Button>
          </UI.EmptyContent>
        </UI.Empty>
      ) : null}
      <Example title="Library gaps to review next">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Combobox and repository picker, data tables and comparison views, OTP
          inputs, rich-editor toolbars, resizable panels, image previews,
          code/diff viewing, permission matrices and revision-conflict recovery.
          Existing implementations remain in place while these patterns are
          designed.
        </p>
      </Example>
    </WorkshopPage>
  );
}
export const Coverage: Story = { render: () => <CoverageMap /> };
