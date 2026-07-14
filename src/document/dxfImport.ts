// Convert a DXF file's 2D geometry into native SketchEntity[] so an imported
// drawing becomes a fully-editable Open Poly sketch (not an opaque blob like a
// STEP body). Parsing is pure TypeScript — no kernel/worker round-trip. The
// caller places the returned entities on a chosen plane; everything here works
// in the DXF's own 2D (x, y) coordinates, optionally scaled.
//
// Supported: LINE, CIRCLE, ARC, LWPOLYLINE/POLYLINE (incl. bulge arcs), SPLINE
// (sampled to an interpolated spline), TEXT/MTEXT (→ our text entity). Anything
// else (HATCH, DIMENSION, INSERT/blocks, ELLIPSE, 3D solids …) is counted in
// `skipped` so the import is transparent and never silently drops geometry.
import DxfParser from "dxf-parser";
import type { SketchEntity, Vec2 } from "./types";
import { genId } from "./document";

export interface DxfImportResult {
  entities: SketchEntity[];
  /** Count of imported entities by our SketchEntity kind (line/arc/…). */
  counts: Record<string, number>;
  /** Count of unsupported DXF entity types we skipped, by DXF type name. */
  skipped: Record<string, number>;
  /** Non-fatal issues worth surfacing (e.g. a malformed spline fell back). */
  warnings: string[];
}

interface Pt { x: number; y: number }
interface DxfVertex extends Pt { bulge?: number }

/** How finely a DXF SPLINE / interpolated curve is sampled into points. */
const SPLINE_SAMPLES_PER_SEG = 8;
const SPLINE_MIN_SAMPLES = 24;

/** Parse DXF text and convert its entities to sketch entities. `scale` multiplies
 *  every coordinate and length (default 1 — DXF units assumed to be mm). Throws
 *  only if the DXF itself is unparseable; unsupported entities are skipped. */
export function parseDxfToEntities(
  text: string,
  opts: { scale?: number } = {},
): DxfImportResult {
  const scale = opts.scale ?? 1;
  // dxf-parser's scanner chokes on a trailing blank line (reads an unpaired
  // group). Normalise line endings and drop a lone trailing empty line.
  const clean = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "\n");
  const parsed = new DxfParser().parseSync(clean);
  const entities: SketchEntity[] = [];
  const counts: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const warnings: string[] = [];

  const s = (n: number) => n * scale;
  const p = (pt: Pt): Vec2 => [s(pt.x), s(pt.y)];
  const bump = (rec: Record<string, number>, k: string) => { rec[k] = (rec[k] ?? 0) + 1; };
  const push = (e: SketchEntity) => { entities.push(e); bump(counts, e.type); };

  const dxfEntities = (parsed?.entities ?? []) as unknown as Array<Record<string, unknown> & { type: string }>;
  for (const ent of dxfEntities) {
    switch (ent.type) {
      case "LINE": {
        const vs = ent.vertices as Pt[] | undefined;
        if (vs && vs.length >= 2) push({ type: "line", id: genId(), a: p(vs[0]), b: p(vs[1]) });
        break;
      }
      case "CIRCLE": {
        const c = ent.center as Pt, r = ent.radius as number;
        if (c && r > 0) push({ type: "circle", id: genId(), c: p(c), r: s(r) });
        break;
      }
      case "ARC": {
        const c = ent.center as Pt, r = ent.radius as number;
        // dxf-parser already converts ARC angles to radians; our arc is CCW from
        // start to end, exactly matching the DXF convention.
        const start = ent.startAngle as number, end = ent.endAngle as number;
        if (c && r > 0) push({ type: "arc", id: genId(), c: p(c), r: s(r), start, end });
        break;
      }
      case "LWPOLYLINE":
      case "POLYLINE": {
        const vs = (ent.vertices as DxfVertex[] | undefined) ?? [];
        const closed = ent.shape === true;
        polylineToEntities(vs, closed, scale, push);
        break;
      }
      case "SPLINE": {
        const pts = splineSamplePoints(ent, warnings);
        if (pts.length >= 2) push({ type: "spline", id: genId(), points: pts.map(p) });
        break;
      }
      case "TEXT": {
        const at = ent.startPoint as Pt | undefined;
        const value = String(ent.text ?? "").trim();
        const h = ent.textHeight as number;
        if (at && value && h > 0)
          push({ type: "text", id: genId(), p: p(at), value, height: s(h), rotation: deg((ent.rotation as number) ?? 0) });
        break;
      }
      case "MTEXT": {
        const at = ent.position as Pt | undefined;
        const value = stripMtext(String(ent.text ?? ""));
        const h = ent.height as number;
        if (at && value && h > 0)
          push({ type: "text", id: genId(), p: p(at), value, height: s(h), rotation: deg((ent.rotation as number) ?? 0) });
        break;
      }
      default:
        bump(skipped, ent.type);
    }
  }

  return { entities, counts, skipped, warnings };
}

/** Degrees → radians (DXF TEXT/MTEXT rotation is in degrees; our text stores
 *  radians). */
function deg(d: number): number { return (d * Math.PI) / 180; }

/** Expand a polyline's vertices into line/arc entities, honouring per-vertex
 *  `bulge` (an arc from that vertex to the next). Closes the loop when `closed`. */
function polylineToEntities(
  vs: DxfVertex[],
  closed: boolean,
  scale: number,
  push: (e: SketchEntity) => void,
): void {
  if (vs.length < 2) return;
  const n = vs.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = vs[i];
    const b = vs[(i + 1) % n];
    const p0: Vec2 = [a.x * scale, a.y * scale];
    const p1: Vec2 = [b.x * scale, b.y * scale];
    if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 1e-9) continue; // dup vertex
    const arc = a.bulge ? arcFromBulge(p0, p1, a.bulge) : null;
    if (arc) push({ type: "arc", id: genId(), c: arc.c, r: arc.r, start: arc.start, end: arc.end });
    else push({ type: "line", id: genId(), a: p0, b: p1 });
  }
}

/** Convert a DXF polyline bulge segment (p0→p1, bulge = tan(θ/4)) into a CCW arc
 *  {center, radius, start, end}. Returns null for a degenerate (near-zero) bulge
 *  so the caller falls back to a straight line. */
export function arcFromBulge(
  p0: Vec2,
  p1: Vec2,
  bulge: number,
): { c: Vec2; r: number; start: number; end: number } | null {
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const theta = 4 * Math.atan(bulge); // signed swept angle
  if (chord < 1e-9 || Math.abs(theta) < 1e-9) return null;
  const rs = chord / (2 * Math.sin(theta / 2)); // signed radius
  const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
  const ux = (p1[0] - p0[0]) / chord, uy = (p1[1] - p0[1]) / chord;
  const lx = -uy, ly = ux; // left normal of the chord direction
  // For a CCW (positive) bulge the center sits to the LEFT of p0→p1 by the signed
  // apothem; the signs of rs and cos(θ/2) make major arcs (θ>π) fall out too.
  const d = rs * Math.cos(theta / 2);
  const c: Vec2 = [mx + lx * d, my + ly * d];
  const r = Math.abs(rs);
  // Our arc runs CCW from start to end. A positive bulge is already CCW p0→p1; a
  // negative (clockwise) bulge traces the same geometric arc CCW from p1 to p0.
  if (bulge >= 0) {
    const start = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
    return { c, r, start, end: start + theta };
  }
  const start = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
  return { c, r, start, end: start - theta }; // -theta > 0 since theta < 0
}

/** Sample a DXF SPLINE onto its curve as an ordered point list (our spline is an
 *  interpolation *through* its points). Prefers on-curve fit points; otherwise
 *  evaluates the B-spline from control points + knots via De Boor. */
function splineSamplePoints(ent: Record<string, unknown>, warnings: string[]): Pt[] {
  const fit = ent.fitPoints as Pt[] | undefined;
  if (fit && fit.length >= 2) return fit;
  const ctrl = ent.controlPoints as Pt[] | undefined;
  if (!ctrl || ctrl.length < 2) return [];
  const degree = Math.max(1, Math.min((ent.degreeOfSplineCurve as number) ?? 3, ctrl.length - 1));
  let knots = ent.knotValues as number[] | undefined;
  if (!knots || knots.length !== ctrl.length + degree + 1) {
    if (knots && knots.length > 0)
      warnings.push("A spline had an inconsistent knot vector; approximated it uniformly.");
    knots = clampedUniformKnots(ctrl.length, degree);
  }
  const nSamples = Math.max(SPLINE_MIN_SAMPLES, ctrl.length * SPLINE_SAMPLES_PER_SEG);
  const u0 = knots[degree], u1 = knots[ctrl.length];
  const out: Pt[] = [];
  for (let i = 0; i <= nSamples; i++) {
    const u = u0 + ((u1 - u0) * i) / nSamples;
    out.push(deBoor(Math.min(u, u1 - 1e-9), degree, ctrl, knots));
  }
  return out;
}

/** A clamped uniform knot vector for `n` control points of the given degree
 *  (degree+1 zeros, evenly spaced interior knots, degree+1 ones). */
function clampedUniformKnots(n: number, degree: number): number[] {
  const knots: number[] = [];
  const interior = n - degree - 1; // number of interior knots
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i <= interior; i++) knots.push(i / (interior + 1));
  for (let i = 0; i <= degree; i++) knots.push(1);
  return knots;
}

/** Evaluate a B-spline at parameter u via De Boor's algorithm. */
function deBoor(u: number, degree: number, ctrl: Pt[], knots: number[]): Pt {
  // Find the knot span k with knots[k] <= u < knots[k+1].
  let k = degree;
  while (k < ctrl.length - 1 && u >= knots[k + 1]) k++;
  const dx: number[] = [], dy: number[] = [];
  for (let j = 0; j <= degree; j++) { dx[j] = ctrl[k - degree + j].x; dy[j] = ctrl[k - degree + j].y; }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom === 0 ? 0 : (u - knots[i]) / denom;
      dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j];
      dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j];
    }
  }
  return { x: dx[degree], y: dy[degree] };
}

/** Strip MTEXT inline formatting so we keep the readable text. MTEXT embeds
 *  codes like \fArial|b0; {\H2;…} \P (paragraph) and escaped braces. */
function stripMtext(raw: string): string {
  return raw
    .replace(/\\P/g, " ") // paragraph break → space
    .replace(/\\[A-Za-z][^;\\]*;/g, "") // \f…; \H…; \A…; etc.
    .replace(/[{}]/g, "") // group braces
    .replace(/\\([{}\\])/g, "$1") // unescape \{ \} \\
    .trim();
}
