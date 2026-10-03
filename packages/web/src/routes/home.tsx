export function meta() {
  return [{ title: "Dispatch · Local development" }];
}

export default function Home() {
  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-5 sm:px-10">
        <span className="text-xl font-semibold tracking-tight">Dispatch</span>
        <span className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted">
          Local development
        </span>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 items-center px-6 py-20 sm:px-10">
        <div className="max-w-2xl">
          <p className="mb-5 flex items-center gap-2 text-sm font-medium text-accent">
            <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
            Environment ready
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">
            A new home for your work.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted">
            Local development is running. Chat is the first feature we’re building,
            with agents and more capabilities to follow.
          </p>
        </div>
      </main>
      <footer className="px-6 py-5 text-xs text-muted sm:px-10">
        Dispatch Web · Development foundation
      </footer>
    </div>
  );
}
