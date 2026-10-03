import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { ReactNode } from "react";
import iconMark from "./assets/dispatch-icon-mark-primary.svg";
import { Brand } from "./components/brand";
import "./styles.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#1d3d6a" />
        <link rel="icon" type="image/svg+xml" href={iconMark} />
        <link rel="icon" href="data:," />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function HydrateFallback() {
  return (
    <main className="page-loading" aria-busy="true">
      <Brand />
      <p role="status">Opening your workspace…</p>
    </main>
  );
}
