import { useEffect, useRef, type RefObject } from "react";
import { uvToWorld, type PlaneFrameData } from "../document/planes";
import type { Vec2 } from "../document/types";
import type { ViewportApi } from "../viewport/Viewport";

/** One on-canvas dimension label: the value text drawn beside a sketch entity. */
export interface DimLabelSpec {
  /** Stable key — the constraint id. Reported on double-click so the caller can
   *  reopen the right editor (length / radius / angle). */
  id: string;
  /** Display text (already formatted, e.g. "40", "R12", "30°"). */
  text: string;
  /** Two reference points in sketch (u,v) coords: the label is drawn at their
   *  midpoint, offset perpendicular to the segment between them. */
  a: Vec2;
  b: Vec2;
}

/** Renders dimension values as HTML labels that track the geometry as the camera
 *  orbits. Positions are updated imperatively each frame (via a rAF loop reading
 *  the live camera through `worldToScreen`) so the React tree never re-renders on
 *  camera movement. Double-clicking a label edits that dimension. */
export function DimensionLabels({
  frame,
  labels,
  viewApiRef,
  onEdit,
}: {
  frame: PlaneFrameData;
  labels: DimLabelSpec[];
  viewApiRef: RefObject<ViewportApi | null>;
  /** Called with the constraint id of the double-clicked label. */
  onEdit: (constraintId: string) => void;
}) {
  const nodes = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const api = viewApiRef.current;
      if (api) {
        for (const l of labels) {
          const el = nodes.current.get(l.id);
          if (!el) continue;
          const mid = api.worldToScreen(
            uvToWorld(frame, (l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2),
          );
          // Offset the label perpendicular to the line (in screen space) so it
          // sits beside the geometry rather than on top of it.
          const sa = api.worldToScreen(uvToWorld(frame, l.a[0], l.a[1]));
          const sb = api.worldToScreen(uvToWorld(frame, l.b[0], l.b[1]));
          let nx = -(sb.y - sa.y);
          let ny = sb.x - sa.x;
          const len = Math.hypot(nx, ny) || 1;
          nx = (nx / len) * 16;
          ny = (ny / len) * 16;
          el.style.transform = `translate(-50%, -50%) translate(${mid.x + nx}px, ${mid.y + ny}px)`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frame, labels, viewApiRef]);

  return (
    <>
      {labels.map((l) => (
        <button
          key={l.id}
          ref={(el) => {
            if (el) nodes.current.set(l.id, el);
            else nodes.current.delete(l.id);
          }}
          className="dim-label"
          title="Double-click to edit"
          onDoubleClick={() => onEdit(l.id)}
        >
          {l.text}
        </button>
      ))}
    </>
  );
}
