// The Screw dialog's side view: the screw to scale, head up, with the head's
// size and height, the shank diameter, the length, and (for socket heads) the
// hex key, each lit when its field has focus. A modelled thread is drawn as
// its real teeth (the far side half a pitch on, as a section shows it); a
// cosmetic one as the conventional thin line at the minor diameter.
import { hasHead, headBottom, screwProfile, socketDepth, type ScrewDims } from "../../document/screw";
import { minorDiameter } from "../../geom/thread";
import { threadSection } from "./threadSection";
import { DimGroup, LinearDim, type P } from "./Dims";
import { fmtDim } from "./fmtDim";
import "./Diagram.css";

const W = 260;
/** The drawing's band; the footer notes get their own strip below it so the
 *  length dimension's label never runs into them. */
const DH = 150;
const H = DH + 14;
/** Room on the left for the head-size label. */
const LEFT = 36;

interface Props {
  dims: ScrewDims;
  /** Modelled thread's clearance; undefined for a cosmetic thread. */
  clearance?: number;
  active: string | null;
  onPick?: (name: string) => void;
}

export function ScrewDiagram({ dims: d, clearance, active, onPick }: Props) {
  // Lay the screw on its side: depth runs left → right, radius up/down.
  const head = d.head === "flat" ? 0 : d.headHeight;
  const total = head + d.length;
  const R = d.headDiameter / 2;
  const s = Math.min((W - LEFT - 20) / total, (DH - 56) / (2 * Math.max(R, d.d / 2)));
  const x0 = LEFT + (W - LEFT - 20 - total * s) / 2 + head * s; // the seat
  const cy = DH / 2 - 4;
  const pt = (z: number, r: number): P => [x0 + z * s, cy - r * s];
  // A hex head's shank starts inside the prism so the two fuse; drawn, it starts at the seat.
  const modelled = clearance !== undefined;
  let outline: P[];
  if (modelled) {
    const c = clearance;
    const start = headBottom(d);
    const rootR = minorDiameter(d.d, d.pitch) / 2 - c;
    // The lead-in chamfer at the tip, as in geom/thread.ts.
    const teeth = (phase: number) =>
      threadSection(d.d / 2 - c, rootR, d.pitch, start, d.length, phase).map(([r, z]): [number, number] => [
        Math.min(r, rootR + (d.length - z)),
        z,
      ]);
    const headTop =
      d.head === "hex" || !hasHead(d.head) ? [[0, 0] as [number, number]] : screwProfile(d, true).slice(0, -1);
    const topSide: [number, number][] = [...headTop, ...teeth(0), [0, d.length]];
    const bottomSide = [...headTop.slice(1), ...teeth(d.pitch / 2)].reverse();
    outline = [...topSide.map(([r, z]) => pt(z, r)), ...bottomSide.map(([r, z]) => pt(z, -r))];
  } else {
    const prof = screwProfile(d).map(([r, z]): [number, number] => [r, Math.max(z, d.head === "hex" ? 0 : z)]);
    outline = [
      ...prof.map(([r, z]) => pt(z, r)),
      ...prof
        .slice(1, -1)
        .reverse()
        .map(([r, z]) => pt(z, -r)),
    ];
  }
  const path = outline.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ") + " Z";
  const hexHalf = d.headDiameter / 2; // a hex head seen across its flats, as dimensioned
  const minor = d.d / 2 - d.pitch * 0.6;
  const top = d.head === "flat" ? 0 : -d.headHeight;

  return (
    <svg className="dg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Screw side view">
      {d.head === "hex" && (
        <rect
          className="dg-material dg-outline"
          x={pt(-d.headHeight, 0)[0]}
          y={cy - hexHalf * s}
          width={d.headHeight * s}
          height={2 * hexHalf * s}
        />
      )}
      <DimGroup name="head" active={active} onPick={onPick}>
        <path className="dg-material dg-outline" d={path} />
      </DimGroup>
      {d.key > 0 && (
        <rect
          className="dg-cut"
          x={pt(top, 0)[0]}
          y={cy - (d.key / 2) * s}
          width={socketDepth(d) * s}
          height={d.key * s}
          strokeDasharray="2 1.5"
        />
      )}
      {!modelled && (
        <>
          <line
            className="dg-thread"
            x1={pt(0.3, 0)[0]}
            y1={cy - minor * s}
            x2={pt(d.length - d.pitch, 0)[0]}
            y2={cy - minor * s}
          />
          <line
            className="dg-thread"
            x1={pt(0.3, 0)[0]}
            y1={cy + minor * s}
            x2={pt(d.length - d.pitch, 0)[0]}
            y2={cy + minor * s}
          />
        </>
      )}
      <line className="dg-axis" x1={pt(top, 0)[0] - 6} y1={cy} x2={pt(d.length, 0)[0] + 6} y2={cy} />

      <DimGroup name="size" active={active} onPick={onPick}>
        <LinearDim a={pt(d.length * 0.6, d.d / 2)} b={pt(d.length * 0.6, -d.d / 2)} label={`${d.size}`} labelSide={1} />
      </DimGroup>
      <DimGroup name="length" active={active} onPick={onPick}>
        <LinearDim
          a={pt(0, -d.d / 2)}
          b={pt(d.length, -d.d / 2)}
          offset={(R - d.d / 2) * s + 14}
          label={fmtDim(d.length)}
          labelSide={1}
        />
      </DimGroup>
      {hasHead(d.head) && (
        <DimGroup name="head size" active={active} onPick={onPick}>
          <LinearDim
            a={pt(top, -(d.head === "hex" ? hexHalf : R))}
            b={pt(top, d.head === "hex" ? hexHalf : R)}
            offset={-12}
            label={`${d.head === "hex" ? "AF " : "Ø"}${fmtDim(d.headDiameter)}`}
            labelSide={-1}
          />
        </DimGroup>
      )}
      {d.head !== "flat" && hasHead(d.head) && (
        <DimGroup name="head size" active={active} onPick={onPick}>
          <LinearDim a={pt(-d.headHeight, R)} b={pt(0, R)} offset={-10} label={fmtDim(d.headHeight)} />
        </DimGroup>
      )}
      {d.key > 0 && (
        <text className="dg-label" x={W - 6} y={H - 5} textAnchor="end">
          hex key {fmtDim(d.key)}
        </text>
      )}
      <text className="dg-label" x={6} y={H - 5}>
        {d.size}×{fmtDim(d.pitch)} · {modelled ? `thread modelled, −${fmtDim(clearance)}` : "thread cosmetic"}
      </text>
    </svg>
  );
}
