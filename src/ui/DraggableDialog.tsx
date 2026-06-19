import { useState, type HTMLAttributes, type PointerEvent } from "react";

/** A dialog box the user can drag by its title bar. Drag is applied as an extra
 *  `translate(dx, dy)` composed on top of the dialog's own CSS positioning (and
 *  any `baseTransform`, e.g. `translateX(-50%)` for centred dialogs), so callers
 *  keep using `left/top` as before. The drag handle is any descendant marked
 *  `data-drag-handle` (typically the title). State resets when the dialog
 *  unmounts, so each time it opens it starts at its anchor. */
export function DraggableDialog({
  baseTransform,
  style,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { baseTransform?: string }) {
  const [delta, setDelta] = useState({ x: 0, y: 0 });

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).closest("[data-drag-handle]")) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = delta.x, oy = delta.y;
    const move = (ev: globalThis.PointerEvent) =>
      setDelta({ x: ox + ev.clientX - sx, y: oy + ev.clientY - sy });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const transform = [baseTransform, `translate(${delta.x}px, ${delta.y}px)`]
    .filter(Boolean)
    .join(" ");

  return (
    <div {...rest} style={{ ...style, transform }} onPointerDown={startDrag}>
      {children}
    </div>
  );
}
