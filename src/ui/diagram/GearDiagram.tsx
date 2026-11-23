// The Gear dialog's diagram: the whole gear as built (left), its pitch
// diameter dimensioned — the number a pair is sized by — and one tooth zoomed
// in (right) with its four circles — tip, pitch, base, root — and the
// pressure angle at the pitch point. The ghost shows the gear in place; this
// shows which number moves which part of the tooth. Same highlight contract
// as the Hole diagram: the focused field's dimension lights up, and clicking a
// dimension focuses its field.
import { useId } from "react";
import type { GearReadout } from "../../document/gear";
import { AngleDim, DimGroup, LinearDim, type P } from "./Dims";
import { fmtDim } from "./fmtDim";
import "./Diagram.css";

const W = 260;
const H = 176;
// Whole-gear view.
const GX = 64;
const GY = 84;
const GR = 54;
// Tooth inset.
const IX0 = 134;
const IX1 = W - 4;
const IY0 = 6;
const IY1 = H - 22;

interface Props {
  readout: GearReadout;
  /** Bore type, so the bore's dimension says what it is. */
  bore: "none" | "round" | "dflat";
  active: string | null;
  onPick?: (name: string) => void;
}

const pathOf = (rings: P[][]) =>
  rings.map((r) => r.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ") + " Z").join(" ");

export function GearDiagram({ readout, bore, active, onPick }: Props) {
  const clipId = useId();
  const { spec, internal, shape } = readout;
  const dims = readout.dims!; // a gear's (a rack draws RackDiagram)
  const rp = dims.pitchDiameter / 2;
  const rt = dims.tipDiameter / 2;
  const rr = dims.rootDiameter / 2;
  const rb = dims.baseDiameter / 2;
  const m = spec.module;

  // ---- whole gear, to scale ----
  let outer = 0;
  for (const [x, y] of shape.outline) outer = Math.max(outer, Math.hypot(x, y));
  const s = GR / outer;
  const g = (x: number, y: number): P => [GX + x * s, GY - y * s];
  const body = pathOf([shape.outline.map(([x, y]) => g(x, y)), ...shape.holes.map((h) => h.map(([x, y]) => g(x, y)))]);
  const boreR = !internal && shape.holes[0] ? Math.max(...shape.holes[0].map(([x, y]) => Math.hypot(x, y))) : 0;

  // ---- one tooth, zoomed: turn the gear so a tooth tip points straight up ----
  // A ring gear's teeth are on its INNER boundary (a hole of the outline).
  const allPts = [shape.outline, ...shape.holes].flat();
  let tipAngle = Math.PI / 2;
  let best = internal ? Infinity : -Infinity;
  for (const [x, y] of allPts) {
    const r = Math.hypot(x, y);
    // A tooth tip is the outline's extreme radius on the toothed side.
    if (Math.abs(r - rt) < m * 0.6 && (internal ? r < best : r > best)) {
      best = r;
      tipAngle = Math.atan2(y, x);
    }
  }
  // Snap to the middle of that tip's flat: average the tip points near it.
  const near = allPts.filter(([x, y]) => {
    const r = Math.hypot(x, y);
    let da = Math.atan2(y, x) - tipAngle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    return Math.abs(r - best) < m * 0.02 && Math.abs(da) < Math.PI / spec.teeth;
  });
  if (near.length) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of near) {
      sx += x;
      sy += y;
    }
    tipAngle = Math.atan2(sy, sx);
  }
  const turn = Math.PI / 2 - tipAngle;
  const c = Math.cos(turn);
  const sn = Math.sin(turn);
  const zs = Math.min((IX1 - IX0) / (1.9 * Math.PI * m), (IY1 - IY0 - 20) / (2.6 * m));
  const PX = (IX0 + IX1) / 2;
  const PY = (IY0 + IY1) / 2 + (internal ? -6 : 6);
  const z = (x: number, y: number): P => {
    const xr = x * c - y * sn;
    const yr = x * sn + y * c;
    return [PX + xr * zs, PY - (yr - rp) * zs];
  };
  const tooth = pathOf([shape.outline, ...shape.holes].map((ring) => ring.map(([x, y]) => z(x, y))));
  const center = z(0, 0);
  const circle = (r: number, cls: string) => <circle className={cls} cx={center[0]} cy={center[1]} r={r * zs} />;
  /** Where a circle crosses the inset's left edge, for its label. */
  const labelY = (r: number) => {
    const dx = (IX0 + 3 - center[0]) / zs;
    const dy = Math.sqrt(Math.max(r * r - dx * dx, 0));
    return center[1] - dy * zs;
  };
  // The circles' labels down the inset's left edge, each just above or below
  // its circle — then nudged apart, since circles a module apart sit close
  // enough for their labels to overlap (a ring gear's base and inner).
  const LABEL_GAP = 10;
  const labelYs = (() => {
    const want = [
      { key: "tip", y: labelY(rt) + (internal ? 9 : -2.5) },
      { key: "base", y: labelY(rb) + 9 },
      { key: "root", y: labelY(rr) + (internal ? -2.5 : 9) },
    ].sort((p, q) => p.y - q.y);
    for (let i = 1; i < want.length; i++) want[i].y = Math.max(want[i].y, want[i - 1].y + LABEL_GAP);
    return new Map(want.map((w) => [w.key, w.y]));
  })();
  const circleLabel = (key: string, text: string) => (
    <text className="dg-label" x={IX0 + 3} y={labelYs.get(key)}>
      {text}
    </text>
  );
  // The pressure angle at the pitch point: the line of action, tangent to the
  // base circle, against the pitch circle's tangent.
  const a = (spec.pressureAngle * Math.PI) / 180;
  const L = 27;
  const lineOfAction: [P, P] = [
    [PX - Math.cos(a) * L, PY - Math.sin(a) * L],
    [PX + Math.cos(a) * L, PY + Math.sin(a) * L],
  ];

  return (
    <svg className="dg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gear diagram">
      <defs>
        <clipPath id={clipId}>
          <rect x={IX0} y={IY0} width={IX1 - IX0} height={IY1 - IY0} rx="3" />
        </clipPath>
      </defs>

      {/* Whole gear. */}
      <DimGroup name="teeth" active={active} onPick={onPick}>
        <path className="dg-material dg-outline" d={body} fillRule="evenodd" />
      </DimGroup>
      <DimGroup name="module pitchDiameter teeth" active={active} onPick={onPick}>
        <circle className="dg-pitch" cx={GX} cy={GY} r={rp * s} />
        <LinearDim a={g(-rp, 0)} b={g(rp, 0)} offset={-(GR + 6)} label={`pitch Ø${fmtDim(rp * 2)}`} />
      </DimGroup>
      <line className="dg-axis" x1={GX - GR - 4} y1={GY} x2={GX + GR + 4} y2={GY} />
      <line className="dg-axis" x1={GX} y1={GY - GR - 4} x2={GX} y2={GY + GR + 4} />
      {boreR > 0 && (
        <DimGroup name="boreDiameter boreFlat" active={active} onPick={onPick}>
          <LinearDim a={g(-boreR, 0)} b={g(boreR, 0)} label={`${bore === "dflat" ? "D " : ""}Ø${fmtDim(boreR * 2)}`} />
        </DimGroup>
      )}
      {internal && (
        <DimGroup name="rimWidth" active={active} onPick={onPick}>
          <LinearDim
            a={g(-outer, -outer)}
            b={g(outer, -outer)}
            offset={-8}
            label={`Ø${fmtDim(outer * 2)}`}
            labelSide={1}
          />
        </DimGroup>
      )}
      <text className="dg-label" x={GX} y={H - 6} textAnchor="middle">
        {spec.teeth} teeth · m{fmtDim(m)}
      </text>

      {/* One tooth. */}
      <rect className="dg-inset" x={IX0} y={IY0} width={IX1 - IX0} height={IY1 - IY0} rx="3" />
      <g clipPath={`url(#${clipId})`}>
        <DimGroup name="teeth backlash profileShift rootFillet" active={active} onPick={onPick}>
          <path className="dg-material dg-outline" d={tooth} fillRule="evenodd" />
        </DimGroup>
        <DimGroup name="profileShift" active={active} onPick={onPick}>
          {circle(rt, "dg-circle")}
          {circleLabel("tip", `${internal ? "inner" : "tip"} Ø${fmtDim(rt * 2)}`)}
        </DimGroup>
        <DimGroup name="module pitchDiameter teeth" active={active} onPick={onPick}>
          {circle(rp, "dg-pitch")}
        </DimGroup>
        <DimGroup name="pressureAngle" active={active} onPick={onPick}>
          {circle(rb, "dg-base")}
          {circleLabel("base", `base Ø${fmtDim(rb * 2)}`)}
        </DimGroup>
        <DimGroup name="rootFillet profileShift" active={active} onPick={onPick}>
          {circle(rr, "dg-circle")}
          {circleLabel("root", `root Ø${fmtDim(rr * 2)}`)}
        </DimGroup>
        <DimGroup name="pressureAngle" active={active} onPick={onPick}>
          <line
            className="dg-line"
            x1={lineOfAction[0][0]}
            y1={lineOfAction[0][1]}
            x2={lineOfAction[1][0]}
            y2={lineOfAction[1][1]}
          />
          <line className="dg-ext" x1={PX} y1={PY} x2={PX + L} y2={PY} />
          <AngleDim
            c={[PX, PY]}
            r={22}
            a1={0}
            a2={a}
            label={`${fmtDim(spec.pressureAngle)}°`}
            labelAt={[PX + 30, PY + 9]}
            anchor="start"
          />
        </DimGroup>
      </g>
      <DimGroup name="backlash" active={active} onPick={onPick}>
        <text className="dg-label" x={(IX0 + IX1) / 2} y={H - 6} textAnchor="middle">
          {spec.backlash > 0 ? `backlash ${fmtDim(spec.backlash)}` : "no backlash"}
          {spec.profileShift !== 0 ? ` · shift ${fmtDim(spec.profileShift)}m` : ""}
        </text>
      </DimGroup>
    </svg>
  );
}
