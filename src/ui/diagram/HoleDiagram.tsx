// The Hole dialog's cross-section: the hole cut through a block of material, to
// scale, with every dimension the dialog edits drawn on it. The dimension whose
// field has focus lights up; clicking a dimension focuses its field.
import { useId } from "react";
import { countersinkDepth, holeProfile, tipDepth, type HoleDims } from "../../document/hole";
import { AngleDim, DimGroup, LinearDim, type P } from "./Dims";
import { fmtDim } from "./fmtDim";
import { threadSection } from "./threadSection";
import { minorDiameter } from "../../geom/thread";
import "./Diagram.css";

const W = 260;
const H = 184;

interface Props {
  dims: HoleDims;
  /** Nominal thread size ("M3"), for a tapped hole's label. */
  size: string;
  active: string | null;
  onPick?: (name: string) => void;
}

export function HoleDiagram({ dims: d, size, active, onPick }: Props) {
  const hatchId = useId();
  const r = d.diameter / 2;
  const tip = tipDepth(d);
  const csDepth = d.holeType === "countersink" ? countersinkDepth(d) : 0;
  const cbDepth = d.holeType === "counterbore" ? d.counterboreDepth : 0;
  const topR =
    d.holeType === "counterbore"
      ? d.counterboreDiameter / 2
      : d.holeType === "countersink"
        ? d.countersinkDiameter / 2
        : d.holeType === "tapped" && d.threadDiameter
          ? Math.max(r, d.threadDiameter / 2)
          : r;
  // How thick a block to draw: the blind hole plus some floor, or for a
  // through hole enough below the head features to read as "through".
  const head = Math.max(cbDepth, csDepth);
  const T = d.throughAll
    ? head + Math.max(d.diameter * 2.2, 4)
    : d.depth + tip + Math.max(d.depth * 0.3, d.diameter * 0.6);
  const halfW = topR * 1.9 + Math.max(d.diameter * 0.6, 1);
  const s = Math.min((W - 110) / (2 * halfW), (H - 58) / T);
  const cx = W / 2 - 6;
  const top = 34;
  const X = (x: number) => cx + x * s;
  const Y = (y: number) => top + y * s;
  const pt = (x: number, y: number): P => [X(x), Y(y)];

  // The cut, filled; its outline drawn OPEN — no line across the mouth, and
  // for a through hole none across the exit, so it reads as running out of
  // the block's underside rather than ending in a flat floor. The fill runs a
  // pixel past the block to cover the block's own bottom edge there.
  const exit = T + 1.5 / s;
  const prof = holeProfile(d, exit);
  const clip = (pz: number) => Math.min(pz, exit);
  const right = prof.map(([pr, pz]) => pt(pr, clip(pz)));
  const left = prof
    .slice(0, -1)
    .reverse()
    .map(([pr, pz]) => pt(-pr, clip(pz)));
  const path = (pts: P[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const cut = path([...right, ...left]) + " Z";
  // Through: each wall alone, down to the exit (the profile's last point is
  // the axis, which a through hole never reaches).
  const walls = d.throughAll ? [path(right.slice(0, -1)), path(left.slice(1))] : [path([...right, ...left])];

  const boreTop = Math.max(cbDepth, csDepth);
  const boreBottom = d.throughAll ? T : d.depth;
  const boreMid = (boreTop + boreBottom) / 2;
  const rightX = X(halfW) + 14;
  const leftX = X(-halfW) - 14;

  return (
    <svg className="dg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Hole cross-section">
      <defs>
        <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" />
        </pattern>
      </defs>
      <rect className="dg-material" x={X(-halfW)} y={Y(0)} width={2 * halfW * s} height={T * s} />
      <rect
        className="dg-hatch"
        x={X(-halfW)}
        y={Y(0)}
        width={2 * halfW * s}
        height={T * s}
        fill={`url(#${hatchId})`}
      />
      <path className="dg-cut-fill" d={cut} />
      {walls.map((w, i) => (
        <path key={i} className="dg-cut-edge" d={w} />
      ))}
      {d.holeType === "tapped" && d.threadDiameter && d.modelledThread && d.pitch && (
        <>
          {[1, -1].map((side) => {
            // The cavity: the basic profile grown by the clearance, teeth
            // out from the drilled wall; the far side half a pitch on.
            const depth = d.throughAll ? T : d.threadDepth;
            const teeth = threadSection(
              d.threadDiameter! / 2 + d.clearance,
              minorDiameter(d.threadDiameter!, d.pitch!) / 2 + d.clearance,
              d.pitch!,
              0,
              depth,
              side > 0 ? 0 : d.pitch! / 2,
            );
            const ptsPath = [[r, 0] as [number, number], ...teeth, [r, depth] as [number, number]]
              .map(([tr, tz], i) => `${i ? "L" : "M"}${X(side * tr)},${Y(tz)}`)
              .join(" ");
            return <path key={side} className="dg-cut" d={ptsPath + " Z"} />;
          })}
        </>
      )}
      {d.holeType === "tapped" && d.threadDiameter && !d.modelledThread && (
        <>
          <line
            className="dg-thread"
            x1={X(d.threadDiameter / 2)}
            y1={Y(0)}
            x2={X(d.threadDiameter / 2)}
            y2={Y(d.threadDepth)}
          />
          <line
            className="dg-thread"
            x1={X(-d.threadDiameter / 2)}
            y1={Y(0)}
            x2={X(-d.threadDiameter / 2)}
            y2={Y(d.threadDepth)}
          />
        </>
      )}
      <line className="dg-axis" x1={X(0)} y1={Y(0) - 22} x2={X(0)} y2={Y(T) + 8} />

      <DimGroup name="diameter" active={active} onPick={onPick}>
        <LinearDim a={pt(-r, boreMid)} b={pt(r, boreMid)} label={`Ø${fmtDim(d.diameter)}`} />
      </DimGroup>

      {d.throughAll ? (
        <DimGroup name="extent" active={active} onPick={onPick}>
          <text className="dg-label" x={X(0)} y={Y(T) + 18} textAnchor="middle">
            {d.upToNext ? "up to next" : "through all"}
          </text>
        </DimGroup>
      ) : (
        <DimGroup name="depth" active={active} onPick={onPick}>
          <LinearDim
            a={pt(topR, 0)}
            b={pt(topR, d.depth)}
            extB={pt(r, d.depth)}
            offset={-(rightX - X(topR))}
            label={fmtDim(d.depth)}
            labelSide={1}
          />
        </DimGroup>
      )}

      {tip > 0 && (
        <DimGroup name="tipAngle" active={active} onPick={onPick}>
          <AngleDim
            c={pt(0, d.depth + tip)}
            r={Math.max(9, Math.min(tip * s * 0.8, 16))}
            a1={-Math.PI / 2 - (d.tipAngle * Math.PI) / 360}
            a2={-Math.PI / 2 + (d.tipAngle * Math.PI) / 360}
            label={`${fmtDim(d.tipAngle)}°`}
            labelAt={[X(0) + Math.max(r * s, 6) + 5, Y(d.depth + tip) + 2]}
            anchor="start"
          />
        </DimGroup>
      )}

      {d.holeType === "counterbore" && (
        <>
          <DimGroup name="counterboreDiameter" active={active} onPick={onPick}>
            <LinearDim a={pt(-topR, 0)} b={pt(topR, 0)} offset={-16} label={`⌴ Ø${fmtDim(d.counterboreDiameter)}`} />
          </DimGroup>
          <DimGroup name="counterboreDepth" active={active} onPick={onPick}>
            <LinearDim
              a={pt(-topR, 0)}
              b={pt(-topR, d.counterboreDepth)}
              offset={X(-topR) - leftX}
              label={fmtDim(d.counterboreDepth)}
            />
          </DimGroup>
        </>
      )}

      {d.holeType === "countersink" && (
        <>
          <DimGroup name="countersinkDiameter" active={active} onPick={onPick}>
            <LinearDim a={pt(-topR, 0)} b={pt(topR, 0)} offset={-16} label={`⌵ Ø${fmtDim(d.countersinkDiameter)}`} />
          </DimGroup>
          <DimGroup name="countersinkAngle" active={active} onPick={onPick}>
            <CountersinkAngle d={d} pt={pt} s={s} topR={topR} csDepth={csDepth} />
          </DimGroup>
        </>
      )}

      {d.holeType === "tapped" && d.threadDiameter && (
        <>
          <DimGroup name="size" active={active} onPick={onPick}>
            <LinearDim
              a={pt(-d.threadDiameter / 2, 0)}
              b={pt(d.threadDiameter / 2, 0)}
              offset={-16}
              label={`${size}×${fmtDim(d.pitch ?? 0)}`}
            />
          </DimGroup>
          {!d.throughAll && (
            <DimGroup name="threadDepth" active={active} onPick={onPick}>
              <LinearDim
                a={pt(-d.threadDiameter / 2, 0)}
                b={pt(-d.threadDiameter / 2, d.threadDepth)}
                offset={X(-d.threadDiameter / 2) - leftX}
                label={fmtDim(d.threadDepth)}
              />
            </DimGroup>
          )}
        </>
      )}
    </svg>
  );
}

/** The countersink's included angle, as an arc across the cone about its
 *  (virtual) apex on the axis. */
function CountersinkAngle({
  d,
  pt,
  s,
  topR,
  csDepth,
}: {
  d: HoleDims;
  pt: (x: number, y: number) => P;
  s: number;
  topR: number;
  csDepth: number;
}) {
  const half = (d.countersinkAngle * Math.PI) / 360;
  const apexZ = topR / Math.tan(half);
  // Through the middle of the cone's height, label just under the arc.
  const rArc = (apexZ - csDepth / 2) / Math.cos(half);
  const [ax, ay] = pt(0, apexZ);
  return (
    <AngleDim
      c={[ax, ay]}
      r={rArc * s}
      a1={-Math.PI / 2 - half}
      a2={-Math.PI / 2 + half}
      label={`${fmtDim(d.countersinkAngle)}°`}
      labelAt={[ax, ay - rArc * s + 9]}
    />
  );
}
