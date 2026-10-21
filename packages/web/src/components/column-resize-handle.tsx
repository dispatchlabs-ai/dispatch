import { useRef } from "react";

type ColumnResizeHandleProps = {
  side: "left" | "right";
  controls: string;
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
};

export function ColumnResizeHandle({ side, controls, width, min, max, onResize }: ColumnResizeHandleProps) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const direction = side === "left" ? 1 : -1;
  const resize = (next: number) => onResize(Math.round(Math.max(min, Math.min(max, next))));
  return <div className={`column-resize-handle resize-${side}`} role="separator" tabIndex={0}
    aria-label={side === "left" ? "Resize sidebar" : "Resize details column"}
    aria-orientation="vertical" aria-controls={controls}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={width} aria-valuetext={`${width} pixels`}
    title="Drag to resize, or use the left and right arrow keys"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, width };
    }}
    onPointerMove={event => {
      if (drag.current?.pointerId === event.pointerId) resize(drag.current.width + direction * (event.clientX - drag.current.x));
    }}
    onPointerUp={event => {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        resize(width + (event.key === "ArrowRight" ? 1 : -1) * direction * (event.shiftKey ? 48 : 16));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        resize(event.key === "Home" ? min : max);
      }
    }} />;
}
