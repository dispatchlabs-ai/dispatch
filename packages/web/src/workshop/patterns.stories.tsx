import type { Meta, StoryObj } from "@storybook/react-vite";
import { BookOpen, FileText, Plus, X } from "lucide-react";
import { useState } from "react";
import { UI } from "../components/ui";
import { Example, WorkshopPage } from "./frame";

const meta = {
  title: "Patterns",
  parameters: { controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function SettingsPatterns() {
  const [assigned, setAssigned] = useState(true);
  return (
    <WorkshopPage
      title="The pieces between controls and screens."
      description="Page headings, consistent settings sections and resource rows keep each feature from inventing its own layout."
    >
      <div className="overflow-hidden rounded-xl border border-border">
        <UI.PageHeader
          eyebrow="Project"
          title="A shared research workspace"
          description="Keep the project’s purpose, resources and working context together."
          actions={
            <UI.Button variant="outline" onClick={() => setAssigned(true)}>
              <Plus />
              Add sample skill
            </UI.Button>
          }
        />
        <div className="bg-card px-5 sm:px-8">
          <UI.SettingsSection
            title="Skills"
            description="Reusable workflows available to the project."
          >
            {assigned ? (
              <UI.ResourceRow
                icon={<BookOpen />}
                title="Review primary sources and compare evidence across competing explanations"
                description="A deliberately long name to inspect wrapping and action placement."
                meta={<UI.Badge tone="success">Available</UI.Badge>}
                actions={
                  <UI.Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove sample skill"
                    onClick={() => setAssigned(false)}
                  >
                    <X />
                  </UI.Button>
                }
              />
            ) : (
              <UI.Empty className="p-6">
                <UI.EmptyHeader>
                  <UI.EmptyMedia variant="icon">
                    <BookOpen />
                  </UI.EmptyMedia>
                  <UI.EmptyTitle>No skills assigned</UI.EmptyTitle>
                  <UI.EmptyDescription>
                    Add a workflow when the project needs it.
                  </UI.EmptyDescription>
                </UI.EmptyHeader>
                <UI.EmptyContent>
                  <UI.Button
                    variant="outline"
                    onClick={() => setAssigned(true)}
                  >
                    <Plus />
                    Add sample skill
                  </UI.Button>
                </UI.EmptyContent>
              </UI.Empty>
            )}
          </UI.SettingsSection>
          <UI.SettingsSection
            title="Files"
            description="Supporting material for the current work."
          >
            <UI.ResourceRow
              icon={<FileText />}
              title="component-inventory.md"
              description="Markdown document · 8 KB"
            />
          </UI.SettingsSection>
        </div>
      </div>
    </WorkshopPage>
  );
}
export const Settings: Story = { render: () => <SettingsPatterns /> };

export const ConversationParts: Story = {
  render: () => (
    <WorkshopPage
      title="A conversation made from shared parts."
      description="Attributed messages, readable content, compact activity and attachment feedback come from the same library as the complete chat example."
      origin="shadcn template"
    >
      <Example title="Messages">
        <div className="flex flex-col gap-7">
          <UI.ChatMessage author="Morgan" kind="person" time="10:24">
            <UI.MarkdownBody>Can we make this easier to scan?</UI.MarkdownBody>
          </UI.ChatMessage>
          <UI.ChatMessage author="Research assistant" kind="agent" time="10:24">
            <UI.MarkdownBody>
              {
                "Yes. Put the **decision first**, then the supporting evidence.\n\n- Keep the layout quiet.\n- Give each action a clear label.\n- Use the same pattern in every section."
              }
            </UI.MarkdownBody>
          </UI.ChatMessage>
        </div>
      </Example>
      <Example title="Activity">
        <div className="flex flex-col gap-3">
          <UI.ToolActivity title="Waiting for a result" status="pending">
            <p>The preview is waiting for another participant.</p>
          </UI.ToolActivity>
          <UI.ToolActivity title="Reading the source files" status="running">
            <p>Source inspection is in progress.</p>
          </UI.ToolActivity>
          <UI.ToolActivity title="Build completed" status="success">
            <pre className="overflow-auto rounded bg-muted p-3 font-mono text-xs">
              Application build completed successfully.
            </pre>
          </UI.ToolActivity>
          <UI.ToolActivity title="Couldn’t load the source" status="error">
            <p>The source was unavailable. The current draft is preserved.</p>
          </UI.ToolActivity>
        </div>
      </Example>
      <Example title="Attachments">
        <div className="flex flex-wrap gap-3">
          <UI.AttachmentChip
            attachment={{
              id: "1",
              name: "design-brief.md",
              detail: "Markdown · 4 KB",
            }}
          />
          <UI.AttachmentChip
            attachment={{
              id: "2",
              name: "a-very-long-filename-for-the-component-review-and-migration-notes.txt",
              detail: "Uploading…",
              state: "uploading",
            }}
          />
          <UI.AttachmentChip
            attachment={{
              id: "3",
              name: "review-notes.pdf",
              detail: "PDF · 280 KB",
              state: "error",
            }}
          />
        </div>
      </Example>
    </WorkshopPage>
  ),
};
