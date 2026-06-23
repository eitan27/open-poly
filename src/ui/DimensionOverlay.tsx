import { useEffect, useRef, type RefObject } from "react";
import { uvToWorld, type PlaneFrameData } from "../document/planes";
import type { Vec2 } from "../document/types";
import type { ViewportApi } from "../viewport/Viewport";

/** One on-canvas dimension, drawn like a technical-drawing annotation next to
 *  the sketch geometry it constrains. `id` is the constraint id — reported on
 *  double-click (reopen its editor) and on click+Delete (remove it). */
export type DimSpec =
  // A line's length: witness (extension) lines off both endpoints, a parallel
  // dimension line with arrowheads, and the value at its midpoint.
  | { id: string; kind: "length"; text: string; a: Vec2; b: Vec2 }
  // A circle's radius: a leader from the centre to just past the rim, an
  // arrowhead touching the rim, and the value beyond it.
  | { id: string; kind: "radius"; text: string; c: Vec2; r: number }
  // The angle between two lines: an arc between them centred on their corner
  // (`p`), swept from `dir1` to `dir2`, with the value at its midpoint — or,
  // when the constraint pins a right angle, a small corner box instead (the
  // conventional technical-drawing mark for 90°, no arc/label needed).
  | { id: string; kind: "angle"; text: string; p: Vec2; dir1: Vec2; dir2: Vec2; isRight: boolean }
  // Fallback when an angle's lines are (nearly) parallel and have no usable
  // corner to anchor an arc on: just the floating value, no witness geometry.
  | { id: string; kind: "free"; text: string; a: Vec2; b: Vec2 };

const OFFSET = 26; // px: gap between a line and its parallel dimension line
const EXT_GAP = 4; // px: gap between the line's endpoint and its witness line
const EXT_OVERSHOOT = 5; // px: how far a witness line continues past the dimension line
const ARROW_LEN = 9;
const ARROW_WIDTH = 5;
const ARC_RADIUS = 34; // px: angle-dimension arc radius
const ARC_SEGMENTS = 20;
const LABEL_GAP = 13; // px: how far beyond the arc/leader the value label sits
const BOX_SIZE = 15; // px: right-angle corner mark side length
const RADIUS_LEADER_REACH = 1.4; // leader extends this many radii out from the circle's centre

type Pt = { x: number; y: number };
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const length = (a: Pt) => Math.hypot(a.x, a.y) || 1;
const unit = (a: Pt): Pt => scale(a, 1 / length(a));
const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });
const ptsToStr = (pts: Pt[]) => pts.map((p) => `${p.x},${p.y}`).join(" ");

/** A small filled triangle, tip at `tip`, pointing along unit vector `dir`. */
function arrowPoints(tip: Pt, dir: Pt): string {
  const back = sub(tip, scale(dir, ARROW_LEN));
  const side = scale(perp(dir), ARROW_WIDTH / 2);
  return ptsToStr([tip, add(back, side), sub(back, side)]);
}

function setLine(g: SVGGElement, role: string, p1: Pt, p2: Pt) {
  const el = g.querySelector(`[data-role="${role}"]`);
  if (!el) return;
  el.setAttribute("x1", String(p1.x));
  el.setAttribute("y1", String(p1.y));
  el.setAttribute("x2", String(p2.x));
  el.setAttribute("y2", String(p2.y));
}
function setPoints(g: SVGGElement, role: string, pts: Pt[]) {
  const el = g.querySelector(`[data-role="${role}"]`);
  if (!el) return;
  el.setAttribute("points", ptsToStr(pts));
}
function setArrow(g: SVGGElement, role: string, tip: Pt, dir: Pt) {
  const el = g.querySelector(`[data-role="${role}"]`);
  if (!el) return;
  el.setAttribute("points", arrowPoints(tip, dir));
}
function placeLabel(el: HTMLButtonElement | undefined, p: Pt) {
  if (!el) return;
  el.style.transform = `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)`;
}

/** Renders dimension constraints as technical-drawing-style annotations (witness
 *  lines + a parallel dimension line for lengths, a leader for radii, an arc for
 *  angles — or a corner box for right angles) plus the editable value. Graphics
 *  are plain SVG, repositioned imperatively each frame (via a rAF loop reading
 *  the live camera through `worldToScreen`) so the React tree never re-renders
 *  on camera movement; only the value/box stays a real, focusable `<button>` so
 *  double-click still reopens the editor and click + Delete still removes it. */
export function DimensionOverlay({
  frame,
  specs,
  centroid,
  viewApiRef,
  onEdit,
  onDelete,
}: {
  frame: PlaneFrameData;
  specs: DimSpec[];
  /** Rough centre of the sketch (uv) — picks which side of a line a length
   *  dimension's offset lands on, so it reads outside the profile. */
  centroid: Vec2;
  viewApiRef: RefObject<ViewportApi | null>;
  /** Called with the constraint id of the double-clicked dimension. */
  onEdit: (constraintId: string) => void;
  /** Called with the constraint id of a dimension that's focused (single-
   *  clicked) when Delete/Backspace is pressed. */
  onDelete: (constraintId: string) => void;
}) {
  const groupNodes = useRef(new Map<string, SVGGElement>());
  const labelNodes = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const api = viewApiRef.current;
      if (api) {
        const toScreen = (p: Vec2): Pt => api.worldToScreen(uvToWorld(frame, p[0], p[1]));
        const sCentroid = toScreen(centroid);

        for (const spec of specs) {
          const label = labelNodes.current.get(spec.id);

          if (spec.kind === "free") {
            const sa = toScreen(spec.a);
            const sb = toScreen(spec.b);
            const mid = scale(add(sa, sb), 0.5);
            const n = unit(perp(sub(sb, sa)));
            placeLabel(label, add(mid, scale(n, 16)));
            continue;
          }

          const g = groupNodes.current.get(spec.id);
          if (!g) continue;

          if (spec.kind === "length") {
            const sa = toScreen(spec.a);
            const sb = toScreen(spec.b);
            const u = unit(sub(sb, sa));
            const n = unit(perp(u));
            const mid = scale(add(sa, sb), 0.5);
            const sign = n.x * (mid.x - sCentroid.x) + n.y * (mid.y - sCentroid.y) >= 0 ? 1 : -1;
            const d1 = add(sa, scale(n, OFFSET * sign));
            const d2 = add(sb, scale(n, OFFSET * sign));
            setLine(g, "ext1", add(sa, scale(n, EXT_GAP * sign)), add(sa, scale(n, (OFFSET + EXT_OVERSHOOT) * sign)));
            setLine(g, "ext2", add(sb, scale(n, EXT_GAP * sign)), add(sb, scale(n, (OFFSET + EXT_OVERSHOOT) * sign)));
            setLine(g, "dim", d1, d2);
            setArrow(g, "arrow1", d1, scale(u, -1));
            setArrow(g, "arrow2", d2, u);
            placeLabel(label, scale(add(d1, d2), 0.5));
          } else if (spec.kind === "radius") {
            const dir: Vec2 = [Math.SQRT1_2, Math.SQRT1_2];
            const rim: Vec2 = [spec.c[0] + spec.r * dir[0], spec.c[1] + spec.r * dir[1]];
            const far: Vec2 = [
              spec.c[0] + spec.r * RADIUS_LEADER_REACH * dir[0],
              spec.c[1] + spec.r * RADIUS_LEADER_REACH * dir[1],
            ];
            const sc = toScreen(spec.c);
            const sRim = toScreen(rim);
            const sFar = toScreen(far);
            setLine(g, "leader", sc, sFar);
            setArrow(g, "arrow1", sRim, unit(sub(sc, sRim)));
            placeLabel(label, sFar);
          } else if (spec.kind === "angle") {
            const sp = toScreen(spec.p);
            const sd1 = unit(sub(toScreen([spec.p[0] + spec.dir1[0], spec.p[1] + spec.dir1[1]]), sp));
            const sd2 = unit(sub(toScreen([spec.p[0] + spec.dir2[0], spec.p[1] + spec.dir2[1]]), sp));

            if (spec.isRight) {
              const c1 = add(sp, scale(sd1, BOX_SIZE));
              const c2 = add(c1, scale(sd2, BOX_SIZE));
              const c3 = add(sp, scale(sd2, BOX_SIZE));
              setPoints(g, "box", [c1, c2, c3]);
              placeLabel(label, c2);
            } else {
              const a1 = Math.atan2(sd1.y, sd1.x);
              const a2 = Math.atan2(sd2.y, sd2.x);
              let delta = a2 - a1;
              while (delta <= -Math.PI) delta += 2 * Math.PI;
              while (delta > Math.PI) delta -= 2 * Math.PI;
              const dirSign = delta >= 0 ? 1 : -1;
              const arcPts: Pt[] = [];
              for (let i = 0; i <= ARC_SEGMENTS; i++) {
                const t = a1 + (delta * i) / ARC_SEGMENTS;
                arcPts.push(add(sp, { x: Math.cos(t) * ARC_RADIUS, y: Math.sin(t) * ARC_RADIUS }));
              }
              setPoints(g, "arc", arcPts);
              const tangentAt = (t: number): Pt => ({ x: -Math.sin(t) * dirSign, y: Math.cos(t) * dirSign });
              setArrow(g, "arrow1", arcPts[0], scale(tangentAt(a1), -1));
              setArrow(g, "arrow2", arcPts[ARC_SEGMENTS], tangentAt(a2));
              const midT = a1 + delta / 2;
              placeLabel(
                label,
                add(sp, { x: Math.cos(midT) * (ARC_RADIUS + LABEL_GAP), y: Math.sin(midT) * (ARC_RADIUS + LABEL_GAP) }),
              );
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [frame, specs, centroid, viewApiRef]);

  return (
    <>
      <svg className="dim-overlay">
        {specs.map((s) => {
          if (s.kind === "free") return null;
          return (
            <g
              key={s.id}
              ref={(el) => {
                if (el) groupNodes.current.set(s.id, el);
                else groupNodes.current.delete(s.id);
              }}
            >
              {s.kind === "length" && (
                <>
                  <line data-role="ext1" className="dim-ext" />
                  <line data-role="ext2" className="dim-ext" />
                  <line data-role="dim" className="dim-line" />
                  <polygon data-role="arrow1" className="dim-arrow" />
                  <polygon data-role="arrow2" className="dim-arrow" />
                </>
              )}
              {s.kind === "radius" && (
                <>
                  <line data-role="leader" className="dim-line" />
                  <polygon data-role="arrow1" className="dim-arrow" />
                </>
              )}
              {s.kind === "angle" && !s.isRight && (
                <>
                  <polyline data-role="arc" className="dim-arc" />
                  <polygon data-role="arrow1" className="dim-arrow" />
                  <polygon data-role="arrow2" className="dim-arrow" />
                </>
              )}
              {s.kind === "angle" && s.isRight && <polyline data-role="box" className="dim-box" />}
            </g>
          );
        })}
      </svg>
      {specs.map((s) => {
        const isRightAngle = s.kind === "angle" && s.isRight;
        return (
          <button
            key={s.id}
            ref={(el) => {
              if (el) labelNodes.current.set(s.id, el);
              else labelNodes.current.delete(s.id);
            }}
            className={isRightAngle ? "dim-right-angle" : "dim-label"}
            title={isRightAngle ? "Right angle (90°) — double-click to edit · click + Delete to remove" : "Double-click to edit · click + Delete to remove"}
            onDoubleClick={() => onEdit(s.id)}
            onKeyDown={(e) => {
              if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                e.stopPropagation();
                onDelete(s.id);
              }
            }}
          >
            {isRightAngle ? null : s.text}
          </button>
        );
      })}
    </>
  );
}
