// The Thread dialog's diagram: a few teeth in section through the axis,
// magnified to the tooth (the whole rod would leave them a few pixels tall),
// with the pitch, the depth and the flank angle — each lit when its field has
// focus. External threads are drawn as the rod's material under the teeth;
// internal ones as the body's material over the cavity.
import type { ThreadDims } from "../../document/threadFeature";
import { flankAngle, profileBreaks } from "../../geom/thread";
import { threadSection } from "./threadSection";
import { DimGroup, LinearDim, type P } from "./Dims";
import { fmtDim } from "./fmtDim";
import "./Diagram.css";

const W = 260;
const DH = 130;
const H = DH + 14;
const TEETH = 3;

interface Props {
  dims: ThreadDims;
  active: string | null;
  onPick?: (name: string) => void;
}

export function ThreadDiagram({ dims: t, active, onPick }: Props) {
  const span = TEETH * t.pitch;
  // Radii shown: a band around the teeth, with material either side.
  const margin = Math.max(t.depth * 0.9, t.pitch * 0.4);
  const rLo = t.rootRadius - margin;
  const rHi = t.crestRadius + margin;
  const s = Math.min((W - 70) / span, (DH - 40) / (rHi - rLo));
  const x0 = 20 + (W - 70 - span * s) / 2;
  const yMid = DH / 2 + 4;
  const rMid = (rLo + rHi) / 2;
  const pt = (z: number, r: number): P => [x0 + z * s, yMid - (r - rMid) * s];

  const teeth = threadSection(t.crestRadius, t.rootRadius, t.pitch, 0, span, 0, profileBreaks(t.profile));
  const outline = teeth.map(([r, z]) => pt(z, r));
  // External: the rod is under the teeth; internal: the body is over them.
  const edge = t.side === "external" ? rLo : rHi;
  const material = [...outline, pt(span, edge), pt(0, edge)];
  const path = material.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ") + " Z";

  // The second tooth's crest flat and the flank after it, for the dimensions.
  const breaks = profileBreaks(t.profile);
  const z1 = t.pitch; // a crest start
  // The angle goes on the third tooth's flank, clear of the pitch dimension.
  const zFlank = 2 * t.pitch + breaks[1] * t.pitch;
  const zRoot = 2 * t.pitch + breaks[2] * t.pitch;
  // The pitch is measured tip to tip: the crests of a rod, the root flats
  // (which point at the axis) of an internal thread.
  const pitchAt = t.side === "external" ? z1 : z1 + breaks[2] * t.pitch;
  const pitchR = t.side === "external" ? t.crestRadius : t.rootRadius;
  const ang = flankAngle(t.profile);
  const angPos = pt((zFlank + zRoot) / 2, (t.crestRadius + t.rootRadius) / 2);

  return (
    <svg className="dg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Thread profile">
      <path className="dg-material dg-outline" d={path} />
      <DimGroup name="pitch" active={active} onPick={onPick}>
        <LinearDim
          a={pt(pitchAt, pitchR)}
          b={pt(pitchAt + t.pitch, pitchR)}
          offset={t.side === "external" ? -((rHi - t.crestRadius) * s - 6) : (t.rootRadius - rLo) * s - 6}
          label={`P ${fmtDim(t.pitch)}`}
        />
      </DimGroup>
      <DimGroup name="depth" active={active} onPick={onPick}>
        <LinearDim
          a={pt(span, t.crestRadius)}
          b={pt(span, t.rootRadius)}
          offset={-14}
          label={fmtDim(t.depth)}
          labelSide={1}
        />
      </DimGroup>
      <text className="dg-label" x={angPos[0] + 6} y={angPos[1] + 4}>
        {Math.round(ang)}°
      </text>
      <text className="dg-label" x={6} y={H - 4}>
        {t.side === "external" ? "rod" : "nut / hole"} · major Ø{fmtDim(2 * t.crestRadius)} · minor Ø
        {fmtDim(2 * t.rootRadius)}
      </text>
    </svg>
  );
}
