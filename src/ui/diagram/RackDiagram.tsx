// The Gear dialog's diagram for a rack: the whole rack as built (top), its
// length and height dimensioned, and two teeth zoomed in (below) with the tip,
// pitch and root lines, the tooth pitch and the pressure angle on a flank.
// Same highlight contract as GearDiagram: the focused field's dimension lights
// up, and clicking a dimension focuses its field.
import { useId } from "react";
import type { GearReadout } from "../../document/gear";
import { AngleDim, DimGroup, LinearDim, type P } from "./Dims";
import { fmtDim } from "./fmtDim";
import "./Diagram.css";

const W = 260;
const H = 176;
// Whole-rack view.
const RX0 = 10;
const RX1 = W - 34;
const RY0 = 22;
const RY1 = 62;
// Tooth inset.
const IX0 = 4;
const IX1 = W - 4;
const IY0 = 72;
const IY1 = H - 20;

interface Props {
  readout: GearReadout;
  active: string | null;
  onPick?: (name: string) => void;
}

const pathOf = (ring: P[]) =>
  ring.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ") + " Z";

export function RackDiagram({ readout, active, onPick }: Props) {
  const clipId = useId();
  const rack = readout.rack!;
  const { spec, shape } = readout;
  const m = spec.module;
  const yTip = m;
  const yRoot = -1.25 * m;

  // ---- whole rack, to scale, centred ----
  const s = Math.min((RX1 - RX0) / rack.length, (RY1 - RY0) / rack.totalHeight);
  const cx = (RX0 + RX1) / 2;
  const top = (RY0 + RY1) / 2 - (rack.totalHeight * s) / 2;
  // y = yTip at the top of the band.
  const g = (x: number, y: number): P => [cx + x * s, top + (yTip - y) * s];
  const body = pathOf(shape.outline.map(([x, y]) => g(x, y)));
  const L2 = rack.length / 2;

  // ---- two teeth, zoomed, a space in the middle ----
  const p = rack.pitch;
  const below = yRoot - 0.6 * m;
  const above = yTip + 1.5 * m; // room for the pitch dimension
  const zs = Math.min((IX1 - IX0) / (2.4 * p), (IY1 - IY0) / (above - below));
  // A space sits on x = 0 when the teeth count is even, a tooth when odd.
  const shiftX = spec.teeth % 2 === 0 ? 0 : p / 2;
  const PX = (IX0 + IX1) / 2;
  const z = (x: number, y: number): P => [PX + (x - shiftX) * zs, IY0 + (above - y) * zs];
  const tooth = pathOf(shape.outline.map(([x, y]) => z(x, y)));
  const hline = (y: number, cls: string) => {
    const [, yy] = z(0, y);
    return <line className={cls} x1={IX0} y1={yy} x2={IX1} y2={yy} />;
  };
  const label = (y: number, text: string, dy: number) => (
    <text className="dg-label" x={IX0 + 3} y={z(0, y)[1] + dy}>
      {text}
    </text>
  );
  // The pressure angle on the LEFT flank of the tooth left of the middle
  // space (clear of the pitch dimension), where it crosses the pitch line:
  // against the vertical.
  const a = (spec.pressureAngle * Math.PI) / 180;
  const halfTooth = (p / 2 - spec.backlash / 2) / 2;
  const flankX = shiftX - p / 2 - halfTooth; // that flank's pitch-line crossing
  const fp = z(flankX, 0);
  // The two tooth centres either side of the middle space, for the pitch dim.
  const c0 = z(shiftX - p / 2, yTip);
  const c1 = z(shiftX + p / 2, yTip);

  return (
    <svg className="dg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Rack diagram">
      <defs>
        <clipPath id={clipId}>
          <rect x={IX0} y={IY0} width={IX1 - IX0} height={IY1 - IY0} rx="3" />
        </clipPath>
      </defs>

      {/* Whole rack. */}
      <DimGroup name="teeth endMargin" active={active} onPick={onPick}>
        <path className="dg-material dg-outline" d={body} />
      </DimGroup>
      <DimGroup name="module teeth" active={active} onPick={onPick}>
        <line className="dg-pitch" x1={g(-L2, 0)[0]} y1={g(0, 0)[1]} x2={g(L2, 0)[0]} y2={g(0, 0)[1]} />
      </DimGroup>
      <DimGroup name="teeth endMargin module" active={active} onPick={onPick}>
        <LinearDim a={g(-L2, yTip)} b={g(L2, yTip)} offset={-7} label={`length ${fmtDim(rack.length)}`} />
      </DimGroup>
      <DimGroup name="rackHeight" active={active} onPick={onPick}>
        <LinearDim a={g(L2, -rack.height)} b={g(L2, 0)} offset={-6} label={`h ${fmtDim(rack.height)}`} labelSide={1} />
      </DimGroup>

      {/* Two teeth. */}
      <rect className="dg-inset" x={IX0} y={IY0} width={IX1 - IX0} height={IY1 - IY0} rx="3" />
      <g clipPath={`url(#${clipId})`}>
        <DimGroup name="teeth backlash rootFillet" active={active} onPick={onPick}>
          <path className="dg-material dg-outline" d={tooth} />
        </DimGroup>
        <DimGroup name="module" active={active} onPick={onPick}>
          {hline(yTip, "dg-circle")}
          {label(yTip, "tip", -2.5)}
        </DimGroup>
        <DimGroup name="module teeth" active={active} onPick={onPick}>
          {hline(0, "dg-pitch")}
          {label(0, "pitch line", -2.5)}
        </DimGroup>
        <DimGroup name="module rootFillet" active={active} onPick={onPick}>
          {hline(yRoot, "dg-circle")}
          {label(yRoot, "root", 9)}
        </DimGroup>
        <DimGroup name="module" active={active} onPick={onPick}>
          <LinearDim a={c0} b={c1} offset={-7} label={`pitch ${fmtDim(p)}`} />
        </DimGroup>
        <DimGroup name="pressureAngle" active={active} onPick={onPick}>
          <line className="dg-ext" x1={fp[0]} y1={fp[1]} x2={fp[0]} y2={fp[1] - 26} />
          <AngleDim
            c={fp}
            r={20}
            a1={-Math.PI / 2}
            a2={-Math.PI / 2 + a}
            label={`${fmtDim(spec.pressureAngle)}°`}
            labelAt={[fp[0] - 4, fp[1] - 22]}
            anchor="end"
          />
        </DimGroup>
      </g>
      <DimGroup name="backlash" active={active} onPick={onPick}>
        <text className="dg-label" x={W / 2} y={H - 6} textAnchor="middle">
          {spec.teeth} teeth · m{fmtDim(m)} · {spec.backlash > 0 ? `backlash ${fmtDim(spec.backlash)}` : "no backlash"}
        </text>
      </DimGroup>
    </svg>
  );
}
