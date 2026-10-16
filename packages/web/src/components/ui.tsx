import { Button as BaseButton } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Input as BaseInput } from "@base-ui/react/input";
import { ChevronDown, LoaderCircle, X } from "lucide-react";
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

export function Select(props: ComponentProps<"select">) {
  return <span className="select-control"><select {...props} /><ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" /></span>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status"><LoaderCircle aria-hidden="true" /><span className="sr-only">{label}</span></span>;
}

export function Notice({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "info" | "success" }) {
  return <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}

export function Field({ label, children, hint, error, hintPosition = "after" }: {
  label: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
  hint?: string;
  hintPosition?: "before" | "after";
  error?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && !error && hintPosition === "before" ? <p id={`${id}-description`} className="field-hint">{hint}</p> : null}
      {children({ id, "aria-describedby": error || hint ? `${id}-description` : undefined, "aria-invalid": error ? true : undefined })}
      {error || (hint && hintPosition === "after") ? <p id={`${id}-description`} className={error ? "field-error" : "field-hint"}>{error || hint}</p> : null}
    </div>
  );
}

export function Modal({ title, description, children, trigger, open, onOpenChange, side, initialFocus, finalFocus, keepMounted = false }: {
  title: string;
  description?: string;
  children: ReactNode;
  trigger?: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  keepMounted?: boolean;
  initialFocus?: ComponentProps<typeof Dialog.Popup>["initialFocus"];
  finalFocus?: ComponentProps<typeof Dialog.Popup>["finalFocus"];
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger render={trigger} /> : null}
      <Dialog.Portal keepMounted={keepMounted}>
        <Dialog.Backdrop className="dialog-overlay" />
        <Dialog.Popup initialFocus={initialFocus} finalFocus={finalFocus} className={`dialog ${side ? `dialog-drawer dialog-${side}` : "dialog-modal"}`}>
          <header className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              {description ? <Dialog.Description>{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close render={<IconButton label="Close"><X size={20} /></IconButton>} />
          </header>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Candidate shadcn components share this entry point; existing exports remain during review.
export * as UI from "./ui/index";
