import {
  ArrowUpRight,
  Bot,
  Folder,
  Menu,
  MessageSquare,
  PanelRight,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Brand } from "../components/brand";
import { UI } from "../components/ui";

export const templateUrl =
  "https://github.com/shadcn-ui/chatbot-template/tree/4106041b1bc9bab44e81ffd2764aa2b6f100e2b0";

export function StoryLink({
  id,
  children,
  className = "",
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a href={`/?path=/story/${id}`} target="_top" className={className}>
      {children}
    </a>
  );
}

export function WorkshopPage({
  title,
  description,
  origin = "Dispatch",
  children,
}: {
  title: string;
  description: string;
  origin?: "Dispatch" | "shadcn template" | "Mixed";
  children: ReactNode;
}) {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-6xl px-5 py-7 sm:px-10 sm:py-10">
        <div className="mb-10 flex flex-wrap items-center justify-between gap-3">
          <Brand />
          <StoryLink
            id="start-here--overview"
            className="text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Component workshop
          </StoryLink>
        </div>
        <header className="mb-8 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <UI.Badge>Ready to review</UI.Badge>
            <span className="text-xs text-muted-foreground">{origin}</span>
            {origin !== "Dispatch" ? (
              <a
                href={templateUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-4"
              >
                View source <ArrowUpRight className="size-3" />
              </a>
            ) : null}
          </div>
          <h1 className="text-3xl leading-tight font-semibold tracking-tight">
            {title}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </header>
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
      </div>
    </main>
  );
}

export function Example({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-7">
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      {description ? (
        <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : (
        <div className="mb-5" />
      )}
      {children}
    </section>
  );
}

function Navigation({
  active,
  onNavigate,
}: {
  active: "chat" | "agent";
  onNavigate?: () => void;
}) {
  return (
    <nav
      aria-label="Example screens"
      className="flex h-full flex-col gap-2 bg-navy p-3 text-white"
    >
      <div className="mb-6 flex justify-center pt-2">
        <Brand compact />
      </div>
      {(
        [
          { id: "start-here--coverage", label: "Projects", Icon: Folder },
          { id: "screens-agent-editor--editable", label: "Agents", Icon: Bot },
          {
            id: "screens-chat--conversation",
            label: "Chats",
            Icon: MessageSquare,
          },
        ] as const
      ).map(({ id, label, Icon }) => (
        <a
          key={id}
          href={`/?path=/story/${id}`}
          target="_top"
          onClick={onNavigate}
          aria-current={
            (active === "chat" && label === "Chats") ||
            (active === "agent" && label === "Agents")
              ? "page"
              : undefined
          }
          className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-white/80 hover:bg-white/10 hover:text-white aria-[current=page]:bg-white/15 aria-[current=page]:text-white"
        >
          <Icon className="size-5" />
          <span className="text-[11px]">{label}</span>
        </a>
      ))}
      <span className="mt-auto py-3 text-center text-[10px] tracking-wider text-white/65 uppercase">
        Preview
      </span>
    </nav>
  );
}

export function ScreenShell({
  active,
  children,
  context,
}: {
  active: "chat" | "agent";
  children: ReactNode;
  context?: ReactNode;
}) {
  const [menu, setMenu] = useState(false);
  const [details, setDetails] = useState(false);
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-aqua-soft px-4 text-xs text-navy">
        <span>
          Component workshop · {active === "chat" ? "Chat" : "Agent editor"}
        </span>
        <StoryLink
          id="start-here--overview"
          className="inline-flex items-center gap-1 font-medium"
        >
          Back to library <X className="size-3" />
        </StoryLink>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-20 shrink-0 md:block">
          <Navigation active={active} />
        </aside>
        <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-card px-4 py-6 xl:flex">
          <p className="mb-5 px-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {active === "chat" ? "Conversations" : "Agents"}
          </p>
          {active === "chat" ? (
            <>
              <StoryLink
                id="screens-chat--conversation"
                className="rounded-lg bg-secondary px-3 py-3 text-sm font-medium text-primary"
              >
                Design review
              </StoryLink>
              <StoryLink
                id="screens-chat--empty"
                className="mt-1 rounded-lg px-3 py-3 text-sm text-muted-foreground hover:bg-muted"
              >
                New conversation
              </StoryLink>
            </>
          ) : (
            <div className="rounded-lg bg-secondary px-3 py-3 text-sm font-medium text-primary">
              Research assistant
            </div>
          )}
          <p className="mt-auto px-2 pt-8 text-xs leading-relaxed text-muted-foreground">
            Synthetic examples.
            <br />
            No live work is started.
          </p>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3 min-[1440px]:hidden">
            <UI.Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <Menu />
            </UI.Button>
            <span className="text-sm font-medium">Example workspace</span>
            {context ? (
              <UI.Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="Open details"
                onClick={() => setDetails(true)}
              >
                <PanelRight />
              </UI.Button>
            ) : null}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
        </div>
        {context ? (
          <aside className="hidden w-60 shrink-0 overflow-auto border-l border-border bg-card p-6 min-[1440px]:block">
            {context}
          </aside>
        ) : null}
      </div>
      <UI.Dialog
        title="Navigation"
        open={menu}
        onOpenChange={setMenu}
        side="left"
      >
        <Navigation active={active} onNavigate={() => setMenu(false)} />
      </UI.Dialog>
      {context ? (
        <UI.Dialog
          title="Conversation details"
          open={details}
          onOpenChange={setDetails}
          side="right"
        >
          {context}
        </UI.Dialog>
      ) : null}
    </div>
  );
}
