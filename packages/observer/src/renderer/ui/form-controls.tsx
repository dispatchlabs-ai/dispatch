import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { Check, LoaderCircle } from "lucide-react";
import { useId, type ReactNode, type ComponentProps } from "react";
import { cn } from "./utils";

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: true;
  }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children({
        id,
        "aria-describedby": hint || error ? `${id}-description` : undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {hint || error ? (
        <p
          id={`${id}-description`}
          className={cn(
            "text-sm leading-relaxed",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error || hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded border border-input bg-card text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40 data-checked:border-primary data-checked:bg-primary disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "group inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-input bg-muted p-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/40 data-checked:border-primary data-checked:bg-primary disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-4 rounded-full bg-muted-foreground transition-transform group-data-checked:translate-x-5 group-data-checked:bg-primary-foreground" />
    </SwitchPrimitive.Root>
  );
}

export function Spinner({
  label = "Loading",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      role="status"
      className={cn("inline-flex items-center gap-2", className)}
    >
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "h-4 rounded bg-secondary motion-safe:animate-pulse",
        className,
      )}
      {...props}
    />
  );
}
