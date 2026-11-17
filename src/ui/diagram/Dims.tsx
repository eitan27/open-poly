// Drawing primitives for the dialogs' 2D cross-section diagrams (Hole, Gear):
// a linear dimension with arrowheads and extension lines, and an angle label.
// Every dimension carries the parameter `name` it stands for, so the dialog can
// light up the one whose field has focus — and a click on a dimension focuses
// its field. Colours come from the app's tokens (see Diagram.css), so both
// themes work without a second set.
import type { ReactNode } from "react";

export type P = [number, number];

interface DimProps {
  /** The param this dimension stands for; several, space-separated, when more
   *  than one field moves it (the first is the one a click focuses). */
  name: string;
  /** The param whose field has focus (or is hovered), if any. */
  active: string | null;
  onPick?: (name: string) => void;
  children: ReactNode;
}

/** A dimension group: highlighted when `active === name`, clickable. */
export function DimGroup({ name, active, onPick, children }: DimProps) {
  return (
    <g
      className={`dg-dim${active && name.split(" ").includes(active) ? " dg-active" : ""}${onPick ? " dg-pickable" : ""}`}
      data-dim={name}
      onMouseDown={(e) => {
        if (!onPick) return;
        e.preventDefault(); // keep focus moving to the field, not the svg
        onPick(name.split(" ")[0]);
      }}
    >
      {children}
    </g>
  );
}

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const len = (a: P) => Math.hypot(a[0], a[1]);

/** Arrowhead at `tip`, pointing away from `from`. */
function Arrow({ tip, from }: { tip: P; from: P }) {
  const d = sub(tip, from);
  const l = len(d) || 1;
  const ux = d[0] / l;
  const uy = d[1] / l;
  const s = 5;
  const w = 2.2;
  const bx = tip[0] - ux * s;
  const by = tip[1] - uy * s;
  return (
    <path
      className="dg-arrow"
      d={`M${tip[0]},${tip[1]} L${bx - uy * w},${by + ux * w} L${bx + uy * w},${by - ux * w} Z`}
    />
  );
}

/** A linear dimension from `a` to `b` drawn offset to `at` (the dimension
 *  line passes through `at`, parallel to a→b), with extension lines from the
 *  measured points and the label centred on it. */
export function LinearDim({
  a,
  b,
  offset = 0,
  label,
  labelSide = -1,
  extA,
  extB,
  outside = false,
}: {
  a: P;
  b: P;
  /** Where the extension lines start, when not at `a`/`b` themselves (a depth
   *  measured from an edge that isn't in line with the bottom it reaches). */
  extA?: P;
  extB?: P;
  /** Perpendicular distance of the dimension line from a→b (+ = left of a→b). */
  offset?: number;
  label: string;
  /** Which side of the line the text sits (−1 above/left, 1 below/right). */
  labelSide?: -1 | 1;
  /** Too narrow to hold its label: arrows outside a and b pointing in, and
   *  the label past b on a short leader (drafting's narrow-feature form). */
  outside?: boolean;
}) {
  const d = sub(b, a);
  const l = len(d) || 1;
  const n: P = [-d[1] / l, d[0] / l];
  const A: P = [a[0] + n[0] * offset, a[1] + n[1] * offset];
  const B: P = [b[0] + n[0] * offset, b[1] + n[1] * offset];
  const ext = (p: P, q: P) =>
    offset === 0 && !extA && !extB ? null : (
      <line
        className="dg-ext"
        x1={p[0]}
        y1={p[1]}
        x2={q[0] + n[0] * Math.sign(offset) * 3}
        y2={q[1] + n[1] * Math.sign(offset) * 3}
      />
    );
  if (outside) {
    const u: P = [d[0] / l, d[1] / l];
    const stub = 9;
    const out = (p: P, k: number): P => [p[0] + u[0] * k, p[1] + u[1] * k];
    const lead = out(B, stub + 3);
    return (
      <>
        {ext(extA ?? a, A)}
        {ext(extB ?? b, B)}
        <line className="dg-line" x1={out(A, -stub)[0]} y1={out(A, -stub)[1]} x2={lead[0]} y2={lead[1]} />
        <Arrow tip={A} from={out(A, -stub)} />
        <Arrow tip={B} from={out(B, stub)} />
        <text className="dg-label dg-label-halo" x={lead[0] + 2} y={lead[1] + 3.5} textAnchor="start">
          {label}
        </text>
      </>
    );
  }
  const mid: P = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const vertical = Math.abs(d[0]) < Math.abs(d[1]);
  const tx = mid[0] + (vertical ? labelSide * 4 : 0);
  const ty = mid[1] + (vertical ? 3.5 : labelSide < 0 ? -4 : 11);
  return (
    <>
      {ext(extA ?? a, A)}
      {ext(extB ?? b, B)}
      <line className="dg-line" x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} />
      <Arrow tip={A} from={B} />
      <Arrow tip={B} from={A} />
      <text className="dg-label" x={tx} y={ty} textAnchor={vertical ? (labelSide < 0 ? "end" : "start") : "middle"}>
        {label}
      </text>
    </>
  );
}

/** An angle: an arc of radius `r` about `c` from direction `a1` to `a2`
 *  (radians, SVG y-down), with the label just outside its middle. */
export function AngleDim({
  c,
  r,
  a1,
  a2,
  label,
  labelAt,
  anchor = "middle",
}: {
  c: P;
  r: number;
  a1: number;
  a2: number;
  label: string;
  /** Put the label here instead of just outside the arc's middle (where a
   *  narrow feature would put it between walls or on another label). */
  labelAt?: P;
  anchor?: "start" | "middle" | "end";
}) {
  const p = (a: number): P => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
  const [x1, y1] = p(a1);
  const [x2, y2] = p(a2);
  const large = Math.abs(a2 - a1) > Math.PI ? 1 : 0;
  const sweep = a2 > a1 ? 1 : 0;
  const m = (a1 + a2) / 2;
  const [lx, ly] = labelAt ?? [c[0] + Math.cos(m) * (r + 10), c[1] + Math.sin(m) * (r + 10)];
  return (
    <>
      <path className="dg-line" d={`M${x1},${y1} A${r},${r} 0 ${large} ${sweep} ${x2},${y2}`} fill="none" />
      <text className="dg-label" x={lx} y={ly + 3.5} textAnchor={anchor}>
        {label}
      </text>
    </>
  );
}
