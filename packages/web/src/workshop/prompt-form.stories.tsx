import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { UI } from "../components/ui";
import { Example, StoryLink, WorkshopPage } from "./frame";

function PromptFormPreview({
  initialValue = "",
  initialRunning = false,
  initialAttachments = [],
  disabled = false,
}: {
  initialValue?: string;
  initialRunning?: boolean;
  initialAttachments?: UI.ComposerAttachment[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [running, setRunning] = useState(initialRunning);
  const [attachments, setAttachments] = useState(initialAttachments);
  const [status, setStatus] = useState("");

  return (
    <WorkshopPage
      title="Prompt form"
      description="The chatbot template’s prompt form, with circular Send and Stop controls. This same component appears in the Chat preview."
      origin="shadcn template"
    >
      <Example
        title={
          disabled ? "Unavailable" : running ? "Generating" : "Write a message"
        }
        description="Enter sends. Shift+Enter adds a line. While generating, a new draft makes Send available again."
      >
        <UI.PromptForm
          value={value}
          onValueChange={setValue}
          running={running}
          disabled={disabled}
          onSend={() => {
            setValue("");
            setAttachments([]);
            setRunning(true);
            setStatus("Sent in this preview. Use Stop to finish.");
          }}
          onStop={() => {
            setRunning(false);
            setStatus("Stopped in this preview.");
          }}
          attachments={attachments}
          onFiles={(files) =>
            setAttachments((current) => [
              ...current,
              ...files.map((file) => ({
                id: crypto.randomUUID(),
                name: file.name,
                detail: `Local preview · ${Math.max(1, Math.ceil(file.size / 1024))} KB`,
              })),
            ])
          }
          onRemoveAttachment={(id) =>
            setAttachments((current) =>
              current.filter((file) => file.id !== id),
            )
          }
          onRetryAttachment={(id) =>
            setAttachments((current) =>
              current.map((file) =>
                file.id === id ? { ...file, state: "ready" } : file,
              ),
            )
          }
        />
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          {status || "Local preview · Messages and files stay in this tab."}
        </p>
      </Example>
      <StoryLink
        id="screens-chat--conversation"
        className="text-sm font-medium text-primary underline underline-offset-4"
      >
        See it in Chat
      </StoryLink>
    </WorkshopPage>
  );
}

const meta = {
  title: "Prompt form",
  component: PromptFormPreview,
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof PromptFormPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
  args: { initialValue: "Compare the options and recommend a starting point." },
};
export const Empty: Story = {};
export const Generating: Story = { args: { initialRunning: true } };
export const Attachments: Story = {
  args: {
    initialAttachments: [
      { id: "brief", name: "design-brief.md", detail: "Markdown · 4 KB" },
    ],
  },
};
export const UploadFailure: Story = {
  args: {
    initialAttachments: [
      {
        id: "notes",
        name: "component-review-and-migration-notes.pdf",
        detail: "PDF · 280 KB",
        state: "error",
      },
    ],
  },
};
export const Disabled: Story = {
  args: {
    initialValue: "A draft kept while messaging is unavailable.",
    disabled: true,
  },
};
