import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Check, Copy, Ellipsis, Plus, Search, Trash2 } from "lucide-react";
import { UI } from "../components/ui";
import { Example, WorkshopPage } from "./frame";

const meta = {
  title: "Controls",
  parameters: { controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
  render: () => (
    <WorkshopPage
      title="Actions, with a clear hierarchy."
      description="One primary action per area. Quiet alternatives, explicit destructive actions and accessible icon labels."
      origin="shadcn template"
    >
      <Example title="Variants">
        <div className="flex flex-wrap gap-3">
          <UI.Button>
            <Plus />
            Create agent
          </UI.Button>
          <UI.Button variant="outline">Cancel</UI.Button>
          <UI.Button variant="secondary">View details</UI.Button>
          <UI.Button variant="ghost">More options</UI.Button>
          <UI.Button variant="destructive">
            <Trash2 />
            Archive
          </UI.Button>
          <UI.Button
            variant="link"
            render={
              <a
                href="https://ui.shadcn.com"
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            Documentation
          </UI.Button>
        </div>
      </Example>
      <Example title="Sizes & states">
        <div className="flex flex-wrap items-center gap-3">
          <UI.Button size="sm">Compact</UI.Button>
          <UI.Button>Default</UI.Button>
          <UI.Button size="lg">Prominent</UI.Button>
          <UI.Button disabled>Unavailable</UI.Button>
          <UI.Button disabled>
            <UI.Spinner label="Saving" />
            Saving…
          </UI.Button>
          <UI.Tooltip>
            <UI.TooltipTrigger
              render={
                <UI.Button
                  size="icon"
                  variant="outline"
                  aria-label="Add item"
                />
              }
            >
              <Plus />
            </UI.TooltipTrigger>
            <UI.TooltipContent>Add item</UI.TooltipContent>
          </UI.Tooltip>
        </div>
        <p className="mt-5 text-sm text-muted-foreground">
          Controls grow to at least 44 px on touch pointers. Tab through these
          controls to inspect focus.
        </p>
      </Example>
    </WorkshopPage>
  ),
};

function FormExamples() {
  const [name, setName] = useState("Research assistant");
  const [model, setModel] = useState<string | null>("balanced");
  const [selected, setSelected] = useState(true);
  const [enabled, setEnabled] = useState(false);
  return (
    <WorkshopPage
      title="Forms that explain themselves."
      description="Labels remain visible. Hints, validation, disabled states and choices share one structure."
      origin="Mixed"
    >
      <Example title="Fields">
        <div className="grid gap-6 md:grid-cols-2">
          <UI.Field
            label="Agent name"
            hint="Choose a name people will recognize."
          >
            {(props) => (
              <UI.Input
                {...props}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </UI.Field>
          <UI.Field label="Description" error="Add a short description.">
            {(props) => (
              <UI.Input
                {...props}
                placeholder="What does this agent help with?"
              />
            )}
          </UI.Field>
          <UI.Field label="Saved name" hint="Names are fixed after creation.">
            {(props) => (
              <UI.Input {...props} value="Project researcher" disabled />
            )}
          </UI.Field>
          <UI.Field
            label="Model profile"
            hint="Example choices; no provider connection."
          >
            {(props) => (
              <UI.Select
                value={model}
                onValueChange={setModel}
                items={{
                  balanced: "Balanced",
                  thorough: "Thorough",
                  fast: "Fast",
                }}
              >
                <UI.SelectTrigger {...props} className="w-full">
                  <UI.SelectValue />
                </UI.SelectTrigger>
                <UI.SelectContent>
                  <UI.SelectItem value="balanced">Balanced</UI.SelectItem>
                  <UI.SelectItem value="thorough">Thorough</UI.SelectItem>
                  <UI.SelectItem value="fast">Fast</UI.SelectItem>
                </UI.SelectContent>
              </UI.Select>
            )}
          </UI.Field>
        </div>
      </Example>
      <Example title="Search & longer text">
        <div className="grid gap-6 md:grid-cols-2">
          <UI.InputGroup className="h-10">
            <UI.InputGroupAddon>
              <Search aria-hidden="true" />
            </UI.InputGroupAddon>
            <UI.InputGroupInput
              aria-label="Search agents"
              placeholder="Search agents…"
            />
          </UI.InputGroup>
          <UI.Field label="Instructions">
            {(props) => (
              <UI.Textarea
                {...props}
                defaultValue="Explain your conclusion clearly and cite the supporting sources."
                rows={4}
              />
            )}
          </UI.Field>
        </div>
      </Example>
      <Example title="Choices">
        <div className="flex flex-col gap-4">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
            <UI.Checkbox checked={selected} onCheckedChange={setSelected} />
            Include supporting sources
          </label>
          <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 text-sm">
            <span>Compact view</span>
            <UI.Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>
        </div>
      </Example>
    </WorkshopPage>
  );
}

export const Forms: Story = { render: () => <FormExamples /> };

function OverlayExamples() {
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [message, setMessage] = useState(
    "Choose an action to preview its feedback.",
  );
  return (
    <WorkshopPage
      title="Menus, dialogs & navigation."
      description="Open and close with the keyboard, check focus returns to the trigger, and inspect narrow layouts."
      origin="Mixed"
    >
      <Example title="Dialogs & drawers">
        <div className="flex flex-wrap gap-3">
          <UI.Dialog
            title="Discard changes?"
            description="The edits in this preview have not been saved."
            open={open}
            onOpenChange={setOpen}
            trigger={<UI.Button variant="outline">Open confirmation</UI.Button>}
          >
            <div className="flex flex-wrap justify-end gap-2">
              <UI.Button variant="outline" onClick={() => setOpen(false)}>
                Keep editing
              </UI.Button>
              <UI.Button
                variant="destructive"
                onClick={() => {
                  setOpen(false);
                  setMessage("Preview changes discarded.");
                }}
              >
                Discard changes
              </UI.Button>
            </div>
          </UI.Dialog>
          <UI.Dialog
            title="Conversation details"
            description="Supporting information stays close to the work."
            open={drawer}
            onOpenChange={setDrawer}
            side="right"
            trigger={
              <UI.Button variant="outline">Open details panel</UI.Button>
            }
          >
            <p className="text-sm leading-relaxed text-muted-foreground">
              Participants, files and the Definition of Done share this space.
            </p>
          </UI.Dialog>
        </div>
      </Example>
      <Example title="Action menu">
        <UI.Menu>
          <UI.MenuTrigger render={<UI.Button variant="outline" />}>
            <Ellipsis />
            Actions
          </UI.MenuTrigger>
          <UI.MenuContent>
            <UI.MenuItem
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href);
                  setMessage("Preview link copied.");
                } catch {
                  setMessage(
                    "Copy unavailable. Copy the address from your browser.",
                  );
                }
              }}
            >
              <Copy className="size-4" />
              Copy link
            </UI.MenuItem>
            <UI.MenuItem onClick={() => setMessage("Example marked ready.")}>
              <Check className="size-4" />
              Mark ready
            </UI.MenuItem>
            <UI.MenuItem destructive onClick={() => setOpen(true)}>
              <Trash2 className="size-4" />
              Discard changes
            </UI.MenuItem>
          </UI.MenuContent>
        </UI.Menu>
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          {message}
        </p>
      </Example>
      <Example title="Tabs">
        <UI.Tabs defaultValue="overview">
          <UI.TabsList aria-label="Project detail">
            <UI.Tab value="overview">Overview</UI.Tab>
            <UI.Tab value="resources">Resources</UI.Tab>
            <UI.Tab value="history">History</UI.Tab>
          </UI.TabsList>
          <UI.TabPanel value="overview">
            <p className="text-sm text-muted-foreground">
              A concise overview of the current project.
            </p>
          </UI.TabPanel>
          <UI.TabPanel value="resources">
            <p className="text-sm text-muted-foreground">
              Shared skills, files and connections.
            </p>
          </UI.TabPanel>
          <UI.TabPanel value="history">
            <p className="text-sm text-muted-foreground">
              Saved revisions and their changes.
            </p>
          </UI.TabPanel>
        </UI.Tabs>
      </Example>
    </WorkshopPage>
  );
}

export const Overlays: Story = { render: () => <OverlayExamples /> };

export const Feedback: Story = {
  render: () => (
    <WorkshopPage
      title="Make every state understandable."
      description="A status is more than a color. Loading, failure and empty content get useful labels and a clear next action."
      origin="Mixed"
    >
      <Example title="Status">
        <div className="flex flex-wrap gap-2">
          <UI.Badge>Draft</UI.Badge>
          <UI.Badge tone="success">Saved</UI.Badge>
          <UI.Badge tone="warning">Needs review</UI.Badge>
          <UI.Badge tone="danger">Failed</UI.Badge>
        </div>
      </Example>
      <Example title="Notices">
        <div className="flex flex-col gap-4">
          <UI.Alert role="status">
            <UI.AlertTitle>Changes saved</UI.AlertTitle>
            <UI.AlertDescription>
              The updated instructions are ready for the next turn.
            </UI.AlertDescription>
          </UI.Alert>
          <UI.Alert variant="destructive">
            <UI.AlertTitle>Couldn’t save changes</UI.AlertTitle>
            <UI.AlertDescription>
              Your draft is still here. Reconnect and try again.
            </UI.AlertDescription>
          </UI.Alert>
        </div>
      </Example>
      <Example title="Loading">
        <div aria-busy="true" className="flex flex-col gap-3">
          <UI.Spinner label="Loading resources" />
          <UI.Skeleton className="w-2/5" />
          <UI.Skeleton className="w-4/5" />
          <UI.Skeleton className="w-3/5" />
        </div>
      </Example>
    </WorkshopPage>
  ),
};
