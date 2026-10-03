import { Button as BaseButton } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Input as BaseInput } from "@base-ui/react/input";
import { LoaderCircle, X } from "lucide-react";
import { useId, type ComponentProps, type ReactElement, type ReactNode } from "react";

export function Button({ variant = "primary", className = "", children, ...props }: ComponentProps<typeof BaseButton> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return <BaseButton type="button" className={`button button-${variant} ${className}`} {...props}>{children}</BaseButton>;
}

export function IconButton({ label, children, className = "", ...props }: ComponentProps<typeof BaseButton> & {
  label: string;
}) {
  return <BaseButton type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</BaseButton>;
}

export const Input = BaseInput;

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status"><LoaderCircle aria-hidden="true" /><span className="sr-only">{label}</span></span>;
}

export function Notice({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "info" | "success" }) {
  return <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

export function Field({ label, children, hint, error }: {
  label: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
  hint?: string;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": error || hint ? `${id}-description` : undefined, "aria-invalid": error ? true : undefined })}
      {error || hint ? <p id={`${id}-description`} className={error ? "field-error" : "field-hint"}>{error || hint}</p> : null}
    </div>
  );
}

export function Modal({ title, description, children, trigger, open, onOpenChange, side }: {
  title: string;
  description: string;
  children: ReactNode;
  trigger?: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger render={trigger} /> : null}
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-overlay" />
        <Dialog.Popup className={`dialog ${side ? `dialog-drawer dialog-${side}` : "dialog-modal"}`}>
          <header className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close render={<IconButton label="Close"><X size={20} /></IconButton>} />
          </header>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
