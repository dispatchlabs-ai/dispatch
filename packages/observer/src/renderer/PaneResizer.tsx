import { useRef } from "react";

export function PaneResizer({
  label,
  value,
  onChange,
  reverse = false,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  reverse?: boolean;
}) {
  const start = useRef<{ x: number; width: number } | undefined>(undefined);
  const min = reverse ? 280 : 180,
    max = reverse ? 560 : 360;
  const change = (width: number) =>
    onChange(Math.max(min, Math.min(max, width)));
  return (
    <div
      className={`pane-resizer ${reverse ? "detail-resizer" : "rail-resizer"}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={(event) => {
        start.current = { x: event.clientX, width: value };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (start.current)
          change(
            start.current.width +
              (event.clientX - start.current.x) * (reverse ? -1 : 1),
          );
      }}
      onPointerUp={(event) => {
        start.current = undefined;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        start.current = undefined;
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          change(
            value +
              (event.key === "ArrowRight" ? 16 : -16) * (reverse ? -1 : 1),
          );
        }
      }}
    />
  );
}
