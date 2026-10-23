import { useLayoutEffect, useRef, useState, type HTMLAttributes, type PointerEvent } from "react";
import { shiftIntoView } from "./dialogFit";

/** A dialog box the user can drag by its title bar. Drag is applied as an extra
 *  `translate(dx, dy)` composed on top of the dialog's own CSS positioning (and
 *  any `baseTransform`, e.g. `translateX(-50%)` for centred dialogs), so callers
 *  keep using `left/top` as before. The drag handle is any descendant marked
 *  `data-drag-handle` (typically the title). State resets when the dialog
 *  unmounts, so each time it opens it starts at its anchor.
 *
 *  The dialog is kept inside the window: one that would open (or be dragged, or
 *  grow) past an edge is nudged back by the same translate. On a phone a dialog
 *  anchored at a tap near the edge otherwise hung off screen, and iOS let the
 *  whole page be panned to reach it. One that already fits is left alone, so
 *  desktop placement is unchanged. */
export function DraggableDialog({
  baseTransform,
  style,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { baseTransform?: string }) {
  const [delta, setDelta] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);

  // Re-run whenever the dialog moves (drag, or the caller re-anchoring it).
  // Converges in one step: once shifted, shiftIntoView returns {0, 0}.
  const left = style?.left;
  const top = style?.top;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const s = shiftIntoView(el.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      if (s.x || s.y) setDelta((d) => ({ x: d.x + s.x, y: d.y + s.y }));
    };
    fit();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    ro?.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [delta, left, top, baseTransform]);

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).closest("[data-drag-handle]")) return;
    e.preventDefault();
    const sx = e.clientX,
      sy = e.clientY,
      ox = delta.x,
      oy = delta.y;
    const move = (ev: globalThis.PointerEvent) => setDelta({ x: ox + ev.clientX - sx, y: oy + ev.clientY - sy });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const transform = [baseTransform, `translate(${delta.x}px, ${delta.y}px)`].filter(Boolean).join(" ");

  return (
    <div {...rest} ref={ref} style={{ ...style, transform }} onPointerDown={startDrag}>
      {children}
    </div>
  );
}
