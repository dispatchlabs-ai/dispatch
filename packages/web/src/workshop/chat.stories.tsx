import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Bot,
  Check,
  Copy,
  Ellipsis,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { UI } from "../components/ui";
import { ScreenShell } from "./frame";

type Scenario = "conversation" | "empty" | "streaming" | "error" | "reader";
type PreviewMessage = {
  id: string;
  kind: "person" | "agent";
  author: string;
  text: string;
  activity?: boolean;
};
const answer = `I’d start with the pieces we use every day: **messages, the composer, forms and settings sections**.

The chatbot template gives us a useful starting point. We can carry the Dispatch colors and type into those components, then review them in real layouts.

| First | Then |
| --- | --- |
| Review the shared controls | Apply them to one screen |
| Check empty and error states | Remove the old styling |

Once those feel right, the rest of the interface can follow the same patterns.`;
const initialMessages: PreviewMessage[] = [
  {
    id: "person-1",
    kind: "person",
    author: "Morgan",
    text: "Let’s make the interface feel more consistent. Where should we start?",
  },
  {
    id: "agent-1",
    kind: "agent",
    author: "Research assistant",
    text: answer,
    activity: true,
  },
];

function ChatContext() {
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Participants
        </h2>
        <div className="mt-4 flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-sm font-medium text-primary">
            M
          </span>
          <div>
            <p className="text-sm font-medium">Morgan</p>
            <p className="text-xs text-muted-foreground">Person</p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-full bg-aqua-soft text-primary">
            <Bot className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">Research assistant</p>
            <p className="text-xs text-muted-foreground">Agent</p>
          </div>
        </div>
      </section>
      <section>
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Definition of Done
        </h2>
        <ul className="mt-4 flex flex-col gap-3 text-sm leading-relaxed">
          <li className="flex gap-2">
            <Check className="mt-0.5 size-4 shrink-0 text-success" />
            Identify reusable components
          </li>
          <li className="flex gap-2">
            <span className="mt-1 size-3.5 shrink-0 rounded border border-input" />
            Review the chat layout
          </li>
          <li className="flex gap-2">
            <span className="mt-1 size-3.5 shrink-0 rounded border border-input" />
            Agree on the next screen
          </li>
        </ul>
      </section>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Example content for reviewing the component system.
      </p>
    </div>
  );
}

function ChatPreview({ scenario = "conversation" }: { scenario?: Scenario }) {
  const [messages, setMessages] = useState<PreviewMessage[]>(
    scenario === "empty"
      ? []
      : scenario === "streaming"
        ? initialMessages.slice(0, 1)
        : initialMessages,
  );
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(scenario === "streaming");
  const [stream, setStream] = useState("");
  const [error, setError] = useState(scenario === "error");
  const [agent, setAgent] = useState<string | null>("researcher");
  const [attachments, setAttachments] = useState<UI.ComposerAttachment[]>([]);
  const [feedback, setFeedback] = useState("");
  const reader = scenario === "reader";

  useEffect(() => {
    if (!running) return;
    let count = 0;
    const timer = window.setInterval(() => {
      count += 10;
      setStream(answer.slice(0, count));
      if (count >= answer.length) {
        window.clearInterval(timer);
        setMessages((current) => [
          ...current,
          {
            id: `agent-${crypto.randomUUID()}`,
            kind: "agent",
            author: agent === "developer" ? "Developer" : "Research assistant",
            text: answer,
            activity: true,
          },
        ]);
        setStream("");
        setRunning(false);
      }
    }, 75);
    return () => window.clearInterval(timer);
  }, [running, agent]);

  function send() {
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        kind: "person",
        author: "Morgan",
        text:
          draft.trim() ||
          `Shared ${attachments.map((file) => file.name).join(", ")}`,
      },
    ]);
    setDraft("");
    setAttachments([]);
    setError(false);
    if (!running) {
      setStream("");
      setRunning(true);
    }
  }
  function reset() {
    setRunning(false);
    setStream("");
    setMessages(initialMessages);
    setDraft("");
    setAttachments([]);
    setError(false);
    setFeedback("");
  }

  return (
    <ScreenShell active="chat" context={<ChatContext />}>
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-card"
        aria-label="Conversation preview"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-8">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              Component library
            </p>
            <h1 className="text-base font-semibold">Design review</h1>
          </div>
          <div className="flex items-center gap-2">
            <UI.Badge tone={running ? "warning" : "neutral"}>
              {running ? "Working" : reader ? "Read only" : "Preview"}
            </UI.Badge>
            <UI.Menu>
              <UI.MenuTrigger
                render={
                  <UI.Button
                    variant="ghost"
                    size="icon"
                    aria-label="Conversation actions"
                  />
                }
              >
                <Ellipsis />
              </UI.MenuTrigger>
              <UI.MenuContent>
                <UI.MenuItem onClick={reset}>
                  <RotateCcw className="size-4" />
                  Reset example
                </UI.MenuItem>
                <UI.MenuItem
                  disabled={reader || running}
                  onClick={() => {
                    setStream("");
                    setRunning(true);
                  }}
                >
                  <Sparkles className="size-4" />
                  Replay streaming
                </UI.MenuItem>
                <UI.MenuItem
                  disabled={reader}
                  onClick={() =>
                    setAttachments([
                      {
                        id: "brief",
                        name: "design-brief.md",
                        detail: "Markdown · 4 KB",
                      },
                    ])
                  }
                >
                  Add sample attachment
                </UI.MenuItem>
                <UI.MenuItem
                  disabled={reader}
                  onClick={() =>
                    setAttachments([
                      {
                        id: "failed",
                        name: "review-notes.txt",
                        detail: "Text · 2 KB",
                        state: "error",
                      },
                    ])
                  }
                >
                  Show failed attachment
                </UI.MenuItem>
              </UI.MenuContent>
            </UI.Menu>
          </div>
        </header>
        {messages.length === 0 && !running ? (
          <div className="flex min-h-0 flex-1 overflow-auto">
            <UI.Empty className="p-6">
              <UI.EmptyHeader>
                <UI.EmptyMedia variant="icon">
                  <Sparkles />
                </UI.EmptyMedia>
                <UI.EmptyTitle>What would you like to work on?</UI.EmptyTitle>
                <UI.EmptyDescription>
                  Bring a question, a draft, or something you want to make
                  better.
                </UI.EmptyDescription>
              </UI.EmptyHeader>
              <UI.EmptyContent>
                <UI.Button
                  variant="outline"
                  onClick={() =>
                    setDraft("Help me plan the next component review.")
                  }
                >
                  Plan a component review <ArrowRight />
                </UI.Button>
              </UI.EmptyContent>
            </UI.Empty>
          </div>
        ) : (
          <UI.MessageScrollerProvider>
            <UI.MessageScroller className="flex-1">
              <UI.MessageScrollerViewport>
                <UI.MessageScrollerContent className="mx-auto w-full max-w-3xl gap-7 px-5 py-7 sm:px-8">
                  {messages.map((message) => (
                    <UI.MessageScrollerItem
                      key={message.id}
                      messageId={message.id}
                      scrollAnchor={message.kind === "person"}
                    >
                      <UI.ChatMessage
                        author={message.author}
                        kind={message.kind}
                        time="10:24"
                        actions={
                          message.kind === "agent" ? (
                            <UI.Button
                              variant="ghost"
                              size="sm"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(
                                    message.text,
                                  );
                                  setFeedback("Answer copied.");
                                } catch {
                                  setFeedback(
                                    "Copy unavailable. Select the answer to copy it.",
                                  );
                                }
                              }}
                            >
                              <Copy />
                              Copy
                            </UI.Button>
                          ) : undefined
                        }
                      >
                        {message.activity ? (
                          <div className="mb-4">
                            <UI.ToolActivity
                              title="Reviewed the component inventory"
                              status="success"
                            >
                              <p>
                                Compared the example controls with the current
                                screen inventory. This is fixture content.
                              </p>
                            </UI.ToolActivity>
                          </div>
                        ) : null}
                        <UI.MarkdownBody>{message.text}</UI.MarkdownBody>
                      </UI.ChatMessage>
                    </UI.MessageScrollerItem>
                  ))}
                  {running ? (
                    <UI.MessageScrollerItem messageId="streaming">
                      <UI.ChatMessage
                        author={
                          agent === "developer"
                            ? "Developer"
                            : "Research assistant"
                        }
                        kind="agent"
                      >
                        <div className="mb-3">
                          <UI.ToolActivity
                            title="Preparing a response"
                            status="running"
                          >
                            <p>
                              Replaying a local sample response. No model
                              request is made.
                            </p>
                          </UI.ToolActivity>
                        </div>
                        <UI.MarkdownBody>{stream}</UI.MarkdownBody>
                      </UI.ChatMessage>
                    </UI.MessageScrollerItem>
                  ) : null}
                </UI.MessageScrollerContent>
              </UI.MessageScrollerViewport>
              <UI.MessageScrollerButton />
            </UI.MessageScroller>
          </UI.MessageScrollerProvider>
        )}
        <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-3 px-5 pt-2 pb-4 sm:px-8">
          {error ? (
            <UI.Alert variant="destructive">
              <UI.AlertTitle>Connection interrupted</UI.AlertTitle>
              <UI.AlertDescription>
                Your draft is still here.{" "}
                <button
                  type="button"
                  className="font-medium underline underline-offset-4"
                  onClick={() => {
                    setError(false);
                    setFeedback("Reconnected in this preview.");
                  }}
                >
                  Reconnect
                </button>
              </UI.AlertDescription>
            </UI.Alert>
          ) : null}
          {reader ? (
            <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
              You can read this conversation. A project manager can grant
              participation.
            </p>
          ) : (
            <UI.PromptForm
              value={draft}
              onValueChange={setDraft}
              running={running}
              onSend={send}
              onStop={() => {
                setRunning(false);
                setStream("");
                setFeedback("Stopped in this preview.");
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
              leading={
                <UI.Select
                  value={agent}
                  onValueChange={setAgent}
                  disabled={running}
                  items={{
                    researcher: "Research assistant",
                    developer: "Developer",
                  }}
                >
                  <UI.SelectTrigger
                    size="sm"
                    className="max-w-44 border-transparent bg-transparent px-1"
                    aria-label="Example agent"
                  >
                    <UI.SelectValue />
                  </UI.SelectTrigger>
                  <UI.SelectContent>
                    <UI.SelectItem value="researcher">
                      Research assistant
                    </UI.SelectItem>
                    <UI.SelectItem value="developer">Developer</UI.SelectItem>
                  </UI.SelectContent>
                </UI.Select>
              }
            />
          )}
          <p
            role="status"
            className="min-h-4 text-center text-xs text-muted-foreground"
          >
            {feedback ||
              "Interactive preview · Messages and files stay in this browser tab."}
          </p>
        </div>
      </section>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Chat",
  component: ChatPreview,
  argTypes: {
    scenario: {
      control: "select",
      options: ["conversation", "empty", "streaming", "error", "reader"],
    },
  },
} satisfies Meta<typeof ChatPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Conversation: Story = {
  args: { scenario: "conversation" },
  render: (args) => <ChatPreview key={args.scenario} {...args} />,
};
export const Empty: Story = { ...Conversation, args: { scenario: "empty" } };
export const Streaming: Story = {
  ...Conversation,
  args: { scenario: "streaming" },
};
export const Error: Story = { ...Conversation, args: { scenario: "error" } };
export const ReadOnly: Story = {
  ...Conversation,
  args: { scenario: "reader" },
};
