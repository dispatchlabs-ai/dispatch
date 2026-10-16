import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { X } from "lucide-react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./utils";

// Uses the existing Dispatch dialog's focus contract with the new component styling.
export function Dialog({
  title,
  description,
  trigger,
  children,
  open,
  onOpenChange,
  side,
}: {
  title: string;
  description?: string;
  trigger?: ReactElement;
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger render={trigger} /> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-navy/30 backdrop-blur-xs" />
        <DialogPrimitive.Popup
          className={cn(
            "fixed z-50 flex flex-col gap-6 overflow-y-auto border border-border bg-card p-6 text-foreground shadow-lg outline-none",
            side
              ? "inset-y-0 w-[min(90vw,24rem)]"
              : "top-1/2 left-1/2 max-h-[calc(100dvh-2rem)] w-[min(calc(100%-2rem),28rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl",
            side === "left" && "left-0",
            side === "right" && "right-0",
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <DialogPrimitive.Title className="text-lg font-semibold">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-sm leading-relaxed text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close
              render={
                <Button variant="ghost" size="icon" aria-label="Close dialog" />
              }
            >
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

export function MenuContent({ children }: { children: ReactNode }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner sideOffset={6} align="end" className="z-50">
        <MenuPrimitive.Popup className="min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function MenuItem({
  className,
  destructive,
  ...props
}: MenuPrimitive.Item.Props & { destructive?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        "flex min-h-10 cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
        destructive && "text-destructive data-highlighted:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn(
        "flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg bg-muted p-1",
        className,
      )}
      {...props}
    />
  );
}

export function Tab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "min-h-9 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40 data-active:bg-card data-active:text-foreground data-active:shadow-sm [@media(pointer:coarse)]:min-h-11",
        className,
      )}
      {...props}
    />
  );
}

export function TabPanel({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Panel>) {
  return (
    <TabsPrimitive.Panel
      className={cn("pt-5 outline-none", className)}
      {...props}
    />
  );
}
