import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { BookOpen, Bot, FileText, Plus, X } from "lucide-react";
import { UI } from "../components/ui";
import { ScreenShell } from "./frame";

const startingDescription =
  "Find reliable sources, compare options, and turn the evidence into a clear recommendation.";
const startingInstructions =
  "You are a research assistant.\n\n- Start with the question we need to answer.\n- Use primary sources when possible.\n- Explain uncertainty and cite the evidence.\n- Keep the recommendation practical and concise.";

function AgentEditor({
  state = "editable",
}: {
  state?: "editable" | "empty" | "error" | "readonly";
}) {
  const [description, setDescription] = useState(startingDescription);
  const [instructions, setInstructions] = useState(startingInstructions);
  const [model, setModel] = useState<string | null>("balanced");
  const [thinking, setThinking] = useState<string | null>("standard");
  const [skills, setSkills] = useState(
    state === "empty" ? [] : ["Source review"],
  );
  const [files, setFiles] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(state === "error");
  const [discard, setDiscard] = useState(false);
  const [picker, setPicker] = useState(false);
  const [validation, setValidation] = useState(false);
  const readonly = state === "readonly";
  function reset() {
    setDescription(startingDescription);
    setInstructions(startingInstructions);
    setModel("balanced");
    setThinking("standard");
    setSkills(state === "empty" ? [] : ["Source review"]);
    setFiles(true);
    setValidation(false);
    setError(false);
    setSaved(false);
    setDiscard(false);
  }
  return (
    <ScreenShell active="agent">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
        <UI.PageHeader
          eyebrow="Agent settings"
          title="Research assistant"
          description="A reusable agent for careful, evidence-based work."
          actions={
            <UI.Badge>{readonly ? "Read only" : "Preview revision"}</UI.Badge>
          }
        />
        <form
          id="agent-preview"
          onSubmit={(event) => {
            event.preventDefault();
            setValidation(true);
            if (!description.trim() || !instructions.trim()) return;
            setError(false);
            setSaved(true);
          }}
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="mx-auto max-w-3xl px-5 pb-8 sm:px-8">
            {error ? (
              <div className="pt-6">
                <UI.Alert variant="destructive">
                  <UI.AlertTitle>Couldn’t save changes</UI.AlertTitle>
                  <UI.AlertDescription>
                    Your draft is preserved. Try saving again.
                  </UI.AlertDescription>
                </UI.Alert>
              </div>
            ) : null}
            <UI.SettingsSection
              title="Identity"
              description="Help people recognize when to use this agent."
            >
              <UI.Field
                label="Name"
                hint="An agent’s name is fixed after creation."
              >
                {(props) => (
                  <UI.Input {...props} value="Research assistant" disabled />
                )}
              </UI.Field>
              <UI.Field
                label="Description"
                error={
                  validation && !description.trim()
                    ? "Add a short description."
                    : undefined
                }
              >
                {(props) => (
                  <UI.Textarea
                    {...props}
                    value={description}
                    rows={2}
                    disabled={readonly}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      setSaved(false);
                    }}
                  />
                )}
              </UI.Field>
            </UI.SettingsSection>
            <UI.SettingsSection
              title="Instructions"
              description="Describe the agent’s purpose and how it should approach the work."
            >
              <UI.Field
                label="Instructions"
                error={
                  validation && !instructions.trim()
                    ? "Add instructions for this agent."
                    : undefined
                }
              >
                {(props) => (
                  <UI.Textarea
                    {...props}
                    rows={7}
                    className="min-h-52 font-mono text-sm leading-relaxed"
                    value={instructions}
                    disabled={readonly}
                    onChange={(event) => {
                      setInstructions(event.target.value);
                      setSaved(false);
                    }}
                  />
                )}
              </UI.Field>
              <UI.Collapsible>
                <UI.CollapsibleTrigger className="min-h-10 text-sm font-medium text-primary underline underline-offset-4">
                  Preview formatted instructions
                </UI.CollapsibleTrigger>
                <UI.CollapsibleContent>
                  <div className="mt-3 rounded-lg border border-border bg-background p-5">
                    <UI.MarkdownBody format="document">
                      {instructions}
                    </UI.MarkdownBody>
                  </div>
                </UI.CollapsibleContent>
              </UI.Collapsible>
            </UI.SettingsSection>
            <UI.SettingsSection
              title="Model"
              description="Choose the balance of speed and depth."
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <UI.Field label="Model profile">
                  {(props) => (
                    <UI.Select
                      value={model}
                      onValueChange={(value) => {
                        setModel(value);
                        setSaved(false);
                      }}
                      disabled={readonly}
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
                <UI.Field label="Thinking">
                  {(props) => (
                    <UI.Select
                      value={thinking}
                      onValueChange={(value) => {
                        setThinking(value);
                        setSaved(false);
                      }}
                      disabled={readonly}
                      items={{ standard: "Standard", extended: "Extended" }}
                    >
                      <UI.SelectTrigger {...props} className="w-full">
                        <UI.SelectValue />
                      </UI.SelectTrigger>
                      <UI.SelectContent>
                        <UI.SelectItem value="standard">Standard</UI.SelectItem>
                        <UI.SelectItem value="extended">Extended</UI.SelectItem>
                      </UI.SelectContent>
                    </UI.Select>
                  )}
                </UI.Field>
              </div>
            </UI.SettingsSection>
            <UI.SettingsSection
              title="Skills"
              description="Reusable instructions assigned to this agent."
              actions={
                <UI.Button
                  variant="outline"
                  size="sm"
                  disabled={readonly}
                  onClick={() => setPicker(true)}
                >
                  <Plus />
                  Add skill
                </UI.Button>
              }
            >
              {skills.length ? (
                <div className="flex flex-col gap-3">
                  {skills.map((skill) => (
                    <UI.ResourceRow
                      key={skill}
                      icon={<BookOpen />}
                      title={skill}
                      description="Review sources and summarize the supporting evidence."
                      meta={<UI.Badge>Assigned</UI.Badge>}
                      actions={
                        <UI.Button
                          size="icon-sm"
                          variant="ghost"
                          disabled={readonly}
                          aria-label={`Remove ${skill}`}
                          onClick={() => {
                            setSkills((current) =>
                              current.filter((item) => item !== skill),
                            );
                            setSaved(false);
                          }}
                        >
                          <X />
                        </UI.Button>
                      }
                    />
                  ))}
                </div>
              ) : (
                <UI.Empty className="border border-border p-6">
                  <UI.EmptyHeader>
                    <UI.EmptyMedia variant="icon">
                      <BookOpen />
                    </UI.EmptyMedia>
                    <UI.EmptyTitle>No skills assigned</UI.EmptyTitle>
                    <UI.EmptyDescription>
                      Add a skill when this agent needs a reusable workflow.
                    </UI.EmptyDescription>
                  </UI.EmptyHeader>
                </UI.Empty>
              )}
            </UI.SettingsSection>
            <UI.SettingsSection
              title="Capabilities"
              description="The tools this example agent can use."
            >
              <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 rounded-lg border border-border p-4">
                <span className="flex items-center gap-3">
                  <FileText className="size-5 text-primary" />
                  <span>
                    <span className="block text-sm font-medium">
                      Files and commands
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      Work with files in the project workspace.
                    </span>
                  </span>
                </span>
                <UI.Switch
                  checked={files}
                  onCheckedChange={(value) => {
                    setFiles(value);
                    setSaved(false);
                  }}
                  disabled={readonly}
                />
              </label>
            </UI.SettingsSection>
          </div>
        </form>
        <UI.ActionBar
          status={
            saved
              ? "Saved in this preview."
              : "Synthetic data · No live agent is changed."
          }
        >
          <UI.Button
            variant="outline"
            disabled={readonly}
            onClick={() => setDiscard(true)}
          >
            Reset
          </UI.Button>
          <UI.Button type="submit" form="agent-preview" disabled={readonly}>
            Save changes
          </UI.Button>
        </UI.ActionBar>
        <UI.Dialog
          title="Reset this example?"
          description="Your preview edits will be replaced with the sample content."
          open={discard}
          onOpenChange={setDiscard}
        >
          <div className="flex justify-end gap-2">
            <UI.Button variant="outline" onClick={() => setDiscard(false)}>
              Keep editing
            </UI.Button>
            <UI.Button variant="destructive" onClick={reset}>
              Reset example
            </UI.Button>
          </div>
        </UI.Dialog>
        <UI.Dialog
          title="Add a skill"
          description="Choose a sample skill for this preview."
          open={picker}
          onOpenChange={setPicker}
        >
          <UI.ResourceRow
            icon={<Bot />}
            title="Compare options"
            description="Summarize tradeoffs and recommend a direction."
            actions={
              <UI.Button
                size="sm"
                disabled={skills.includes("Compare options")}
                onClick={() => {
                  setSkills((current) => [...current, "Compare options"]);
                  setSaved(false);
                  setPicker(false);
                }}
              >
                {skills.includes("Compare options") ? "Assigned" : "Add"}
              </UI.Button>
            }
          />
        </UI.Dialog>
      </section>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent editor",
  component: AgentEditor,
  argTypes: {
    state: {
      control: "select",
      options: ["editable", "empty", "error", "readonly"],
    },
  },
} satisfies Meta<typeof AgentEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Editable: Story = {
  args: { state: "editable" },
  render: (args) => <AgentEditor key={args.state} {...args} />,
};
export const EmptyResources: Story = { ...Editable, args: { state: "empty" } };
export const SaveError: Story = { ...Editable, args: { state: "error" } };
export const ReadOnly: Story = { ...Editable, args: { state: "readonly" } };
