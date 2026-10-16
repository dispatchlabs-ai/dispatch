import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { UI } from "../components/ui";
import { Example, WorkshopPage } from "./frame";

const meta = {
  title: "Experiments",
  parameters: { controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ScrollerExperiment() {
  const [items, setItems] = useState(
    Array.from({ length: 16 }, (_, id) => ({
      id,
      text: `Example message ${id + 1}. Read this line, then load earlier messages or append another response. Your place should stay stable while reading.`,
    })),
  );
  return (
    <WorkshopPage
      title="Keep the reader’s place."
      description="Try the template’s Message Scroller with appended and prepended history. This experiment does not yet qualify replacement of Dispatch’s virtualized transcript."
      origin="shadcn template"
    >
      <Example
        title="History and new messages"
        description="Scroll up before appending a message. Then load earlier history and use the jump-to-latest button."
      >
        <div className="mb-4 flex flex-wrap gap-2">
          <UI.Button
            variant="outline"
            onClick={() =>
              setItems((current) => [
                ...Array.from({ length: 8 }, (_, i) => ({
                  id: current[0]!.id - 8 + i,
                  text: "An earlier message from the same example conversation.",
                })),
                ...current,
              ])
            }
          >
            Load earlier messages
          </UI.Button>
          <UI.Button
            onClick={() =>
              setItems((current) => [
                ...current,
                {
                  id: current.at(-1)!.id + 1,
                  text: "A new response arrived while you were reading.",
                },
              ])
            }
          >
            Append message
          </UI.Button>
        </div>
        <div className="h-[480px] overflow-hidden rounded-lg border border-border">
          <UI.MessageScrollerProvider>
            <UI.MessageScroller>
              <UI.MessageScrollerViewport>
                <UI.MessageScrollerContent className="gap-5 p-5">
                  {items.map((item) => (
                    <UI.MessageScrollerItem
                      key={item.id}
                      messageId={String(item.id)}
                    >
                      <div
                        data-message-id={item.id}
                        className="rounded-lg bg-muted p-4"
                      >
                        <p className="mb-2 text-xs font-medium text-muted-foreground">
                          Message {item.id + 1}
                        </p>
                        <p className="text-sm leading-relaxed">{item.text}</p>
                      </div>
                    </UI.MessageScrollerItem>
                  ))}
                </UI.MessageScrollerContent>
              </UI.MessageScrollerViewport>
              <UI.MessageScrollerButton />
            </UI.MessageScroller>
          </UI.MessageScrollerProvider>
        </div>
      </Example>
      <UI.Alert role="status">
        <UI.AlertTitle>Production integration still needs review</UI.AlertTitle>
        <UI.AlertDescription>
          Virtualization, thread switching, reconnects, expanding images and
          long real histories remain part of the later chat migration.
        </UI.AlertDescription>
      </UI.Alert>
    </WorkshopPage>
  );
}
export const MessageScroller: Story = { render: () => <ScrollerExperiment /> };

function QuestionnaireExperiment() {
  const [answer, setAnswer] = useState<string | null>(null);
  return (
    <WorkshopPage
      title="A clear question at the right moment."
      description="The template’s Questionnaire component can collect choices or a free-text answer. This is a local interaction experiment, with no agent tool or approval workflow attached."
      origin="shadcn template"
    >
      <Example title="Choose a review focus">
        {answer ? (
          <div className="flex flex-col items-start gap-4">
            <UI.Alert role="status">
              <UI.AlertTitle>Answer recorded in this preview</UI.AlertTitle>
              <UI.AlertDescription>{answer}</UI.AlertDescription>
            </UI.Alert>
            <UI.Button variant="outline" onClick={() => setAnswer(null)}>
              Try again
            </UI.Button>
          </div>
        ) : (
          <UI.Questionnaire
            items={[
              {
                name: "focus",
                required: true,
                choices: [
                  { value: "The conversation" },
                  { value: "The agent editor" },
                  { value: "Shared controls" },
                ],
              },
            ]}
            defaultItem="focus"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setAnswer(String(data.get("focus") ?? ""));
            }}
          >
            <UI.QuestionnaireItem name="focus" required>
              <UI.QuestionnaireTitle>
                What should we review first?
              </UI.QuestionnaireTitle>
              <UI.QuestionnaireDescription>
                Pick the area that will make the biggest difference to your
                daily work.
              </UI.QuestionnaireDescription>
              <UI.QuestionnaireChoices>
                <UI.QuestionnaireChoice value="The conversation">
                  The conversation
                  <UI.QuestionnaireChoiceDescription>
                    Messages, activity and the composer.
                  </UI.QuestionnaireChoiceDescription>
                </UI.QuestionnaireChoice>
                <UI.QuestionnaireChoice value="The agent editor">
                  The agent editor
                  <UI.QuestionnaireChoiceDescription>
                    Fields, instructions and resources.
                  </UI.QuestionnaireChoiceDescription>
                </UI.QuestionnaireChoice>
                <UI.QuestionnaireChoice value="Shared controls">
                  Shared controls
                  <UI.QuestionnaireChoiceDescription>
                    Buttons, menus and dialogs.
                  </UI.QuestionnaireChoiceDescription>
                </UI.QuestionnaireChoice>
                <UI.QuestionnaireInput
                  aria-label="Another review focus"
                  placeholder="Something else…"
                />
              </UI.QuestionnaireChoices>
              <UI.QuestionnaireError />
            </UI.QuestionnaireItem>
            <UI.QuestionnaireActions>
              <UI.QuestionnaireSubmit>Use this focus</UI.QuestionnaireSubmit>
            </UI.QuestionnaireActions>
          </UI.Questionnaire>
        )}
      </Example>
    </WorkshopPage>
  );
}
export const Questionnaire: Story = {
  render: () => <QuestionnaireExperiment />,
};
