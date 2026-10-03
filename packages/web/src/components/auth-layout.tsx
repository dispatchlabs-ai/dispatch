import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Brand } from "./brand";

export function AuthLayout({ title, description, children, footer }: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="auth-page">
      <aside className="auth-brand-panel" aria-label="Dispatch">
        <Brand inverse />
        <div className="auth-brand-message">
          <span className="eyebrow">Your workspace</span>
          <h2>Make room for<br />what’s next.</h2>
          <p>A place to think through problems, work with your agents, and move things forward.</p>
        </div>
        <p className="auth-brand-footer"><ShieldCheck size={17} aria-hidden="true" /> Private work. Protected access.</p>
      </aside>
      <main className="auth-main">
        <div className="auth-form-wrap">
          <div className="auth-mobile-logo"><Brand /></div>
          <header className="auth-heading">
            <h1>{title}</h1>
            <p>{description}</p>
          </header>
          {children}
          {footer ? <footer className="auth-form-footer">{footer}</footer> : null}
        </div>
      </main>
    </div>
  );
}
