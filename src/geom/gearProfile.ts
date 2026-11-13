// Involute spur-gear outlines, in 2D, as plain polylines.
//
// Pure maths, no kernel: the Gear feature bakes these into an extrude profile
// in the document layer, so the ghost, the booleans and the face naming are
// all the extrude's. That also keeps the tooth shape unit-testable in Node.
//
// Conventions. Everything is in the gear's own (u, v) plane, centred on the
// origin, millimetres and radians. Tooth 0 points along +u. Outlines are CCW.
//
// The tooth flank is a true involute of the base circle (sampled), the tip is
// an arc of the addendum circle, the root an arc of the dedendum circle, and
// the two meet through a fillet arc tangent to both — the shape a gear reads
// as, rather than the trochoid a hob would actually cut. Below the base circle
// (small tooth counts) the flank continues radially, which is the usual CAD
// approximation; `undercut` in the result says when that is hiding real
// undercut, so the dialog can suggest a profile shift.
//
// An INTERNAL (ring) gear's tooth SPACE has the same shape as an external
// gear's tooth — two involutes of the same base circle closing in toward the
// outside — so it's built with the same routine, addendum and dedendum swapped,
// and cut as holes out of a ring.

export type Vec2 = [number, number];

export interface GearToothSpec {
  teeth: number;
  /** Module (mm): pitch diameter / teeth. */
  module: number;
  /** Pressure angle, degrees. */
  pressureAngle: number;
  /** Profile shift coefficient x (× module). Positive thickens an external
   *  tooth at its root, which is what fixes undercut on small gears. */
  profileShift: number;
  /** Total backlash (mm, along the pitch circle) this gear gives up — each
   *  tooth is thinned by half of it, so a pair made with the same value meets
   *  with the full amount of play between them. */
  backlash: number;
  /** Root fillet radius (mm). Clamped to what fits in the tooth space. */
  rootFillet: number;
  /** Addendum and dedendum coefficients (× module). Standard: 1 and 1.25. */
  addendum?: number;
  dedendum?: number;
}

export interface GearDims {
  pitchDiameter: number;
  baseDiameter: number;
  /** External: across the tooth tips. Internal: the inner (tip) diameter. */
  tipDiameter: number;
  /** External: at the tooth roots. Internal: the outer (root) diameter. */
  rootDiameter: number;
}

export interface GearOutline {
  outline: Vec2[];
  holes: Vec2[][];
  dims: GearDims;
  /** Non-fatal: the tooth count would undercut at this profile shift. */
  undercut: boolean;
  /** The fillet radius actually used (≤ the one asked for). */
  rootFillet: number;
}

const inv = (phi: number) => Math.tan(phi) - phi;
const deg = (d: number) => (d * Math.PI) / 180;
const polar = (r: number, a: number): Vec2 => [r * Math.cos(a), r * Math.sin(a)];

/** The fewest teeth a standard rack cutter makes without undercut. */
export function minTeethWithoutUndercut(pressureAngleDeg: number, profileShift = 0, addendum = 1): number {
  const s = Math.sin(deg(pressureAngleDeg));
  return (2 * (addendum - profileShift)) / (s * s);
}

/** Check the spec's numbers before any geometry is made, with messages a
 *  person can act on. Throws. */
export function validateToothSpec(spec: GearToothSpec): void {
  const { teeth, module: m, pressureAngle } = spec;
  if (!Number.isFinite(teeth) || !Number.isInteger(teeth)) throw new Error("gear: teeth must be a whole number");
  if (teeth < 6) throw new Error("gear: needs at least 6 teeth");
  if (teeth > 400) throw new Error("gear: at most 400 teeth");
  if (!(m > 0) || !Number.isFinite(m)) throw new Error("gear: module must be greater than 0");
  if (!(pressureAngle >= 10 && pressureAngle <= 35))
    throw new Error("gear: pressure angle must be between 10° and 35°");
  if (!Number.isFinite(spec.profileShift) || Math.abs(spec.profileShift) > 1.5)
    throw new Error("gear: profile shift must be between -1.5 and 1.5");
  if (!(spec.backlash >= 0) || !Number.isFinite(spec.backlash)) throw new Error("gear: backlash can't be negative");
  if (!(spec.rootFillet >= 0) || !Number.isFinite(spec.rootFillet))
    throw new Error("gear: root fillet can't be negative");
}

/** The circles a spec describes, without building the outline. */
export function gearDims(spec: GearToothSpec, internal = false): GearDims {
  const ha = spec.addendum ?? 1;
  const hf = spec.dedendum ?? 1.25;
  const m = spec.module;
  const r = (m * spec.teeth) / 2;
  const rb = r * Math.cos(deg(spec.pressureAngle));
  const x = spec.profileShift;
  if (internal) {
    // Shift moves an internal gear's teeth outward (away from the pinion),
    // mirroring what it does to an external gear.
    return {
      pitchDiameter: 2 * r,
      baseDiameter: 2 * rb,
      tipDiameter: 2 * (r - m * (ha - x)),
      rootDiameter: 2 * (r + m * (hf + x)),
    };
  }
  return {
    pitchDiameter: 2 * r,
    baseDiameter: 2 * rb,
    tipDiameter: 2 * (r + m * (ha + x)),
    rootDiameter: 2 * (r - m * (hf - x)),
  };
}

interface ToothShape {
  teeth: number;
  rb: number;
  rTip: number;
  rRoot: number;
  /** Half the tooth's angular thickness at the pitch circle, plus inv(α):
   *  the flank's angle at radius ρ ≥ rb is `psi - inv(acos(rb/ρ))`. */
  psi: number;
  fillet: number;
}

/** The flank's angle (from the tooth centreline) at radius ρ. Radial below the
 *  base circle. */
function flankAngle(t: ToothShape, rho: number): number {
  const rr = Math.max(rho, t.rb);
  return t.psi - inv(Math.acos(t.rb / rr));
}

/** Closest point on a polyline to `c`: the point, its distance, and the index
 *  of the segment it lies on. */
function closestOnPolyline(pts: Vec2[], c: Vec2): { p: Vec2; d: number; seg: number } {
  let best = { p: pts[0], d: Infinity, seg: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((c[0] - ax) * dx + (c[1] - ay) * dy) / len2)) : 0;
    const p: Vec2 = [ax + t * dx, ay + t * dy];
    const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
    if (d < best.d) best = { p, d, seg: i };
  }
  return best;
}

/** Arc points from angle a0 to a1 (exclusive of a0, inclusive of a1) on a
 *  circle of radius r about `c`, with at most `maxStep` radians per chord. */
function arcPoints(c: Vec2, r: number, a0: number, a1: number, maxStep: number, minSegs = 1): Vec2[] {
  const n = Math.max(minSegs, Math.ceil(Math.abs(a1 - a0) / maxStep));
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/** One HALF of one tooth unit, from the tooth's centreline (angle 0, on the
 *  tip circle) to the middle of the next space (angle π/N, on the root
 *  circle), as CCW points. Also returns the fillet radius actually used. */
function halfTooth(t: ToothShape): { pts: Vec2[]; fillet: number } {
  const half = Math.PI / t.teeth;
  const thetaTip = flankAngle(t, t.rTip);
  const thetaRoot = flankAngle(t, t.rRoot);
  if (thetaTip <= 1e-4)
    throw new Error("gear: the teeth come to a point — lower the profile shift, or use fewer teeth");
  if (thetaRoot >= half - 1e-4)
    throw new Error("gear: neighbouring teeth overlap at the root — raise the profile shift");

  // The flank, root to tip, in polar → cartesian. Sampled evenly in roll
  // angle, which crowds points near the base circle where the involute bends
  // hardest. A radial stub covers any part below the base circle.
  const flank: Vec2[] = [];
  const start = Math.max(t.rRoot, t.rb);
  if (t.rRoot < t.rb) flank.push(polar(t.rRoot, flankAngle(t, t.rRoot)));
  const roll = (rho: number) => Math.sqrt(Math.max(0, (rho / t.rb) ** 2 - 1));
  const r0 = roll(start),
    r1 = roll(t.rTip);
  const FLANK_SEGS = 7;
  for (let i = 0; i <= FLANK_SEGS; i++) {
    const rl = r0 + ((r1 - r0) * i) / FLANK_SEGS;
    const rho = t.rb * Math.sqrt(1 + rl * rl);
    flank.push(polar(rho, flankAngle(t, rho)));
  }

  // Tip arc, centreline → flank.
  const pts: Vec2[] = [polar(t.rTip, 0)];
  pts.push(...arcPoints([0, 0], t.rTip, 0, thetaTip, deg(6)));

  // Fillet: a circle of radius rf tangent to the root circle (centre on the
  // circle of radius rRoot + rf) and to the flank. Slide its centre from the
  // flank toward the middle of the space until it clears the flank by exactly
  // rf. Shrink rf until it fits in the space at all.
  let rf = t.fillet;
  let fit: { gamma: number; touch: { p: Vec2; seg: number } } | null = null;
  for (let tries = 0; rf > 1e-3 && tries < 30; tries++) {
    const rc = t.rRoot + rf;
    const gap = (g: number) => closestOnPolyline(flank, polar(rc, g)).d - rf;
    if (gap(half) < 0) {
      rf *= 0.8;
      continue;
    }
    let lo = thetaRoot,
      hi = half;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (gap(mid) < 0) lo = mid;
      else hi = mid;
    }
    const touch = closestOnPolyline(flank, polar(rc, hi));
    // The fillet must touch the flank above the root, not at its very end.
    if (touch.seg === 0 && Math.hypot(...touch.p) <= t.rRoot + 1e-9) {
      rf *= 0.8;
      continue;
    }
    fit = { gamma: hi, touch };
    break;
  }

  if (fit) {
    // Flank from tip down to the tangent point (the polyline walked backwards).
    for (let i = flank.length - 2; i > fit.touch.seg; i--) pts.push(flank[i]);
    pts.push(fit.touch.p);
    const c = polar(t.rRoot + rf, fit.gamma);
    const a0 = Math.atan2(fit.touch.p[1] - c[1], fit.touch.p[0] - c[0]);
    const a1 = fit.gamma + Math.PI; // toward the gear centre: the root tangent point
    // Go the short way round.
    let a1n = a1;
    while (a1n - a0 > Math.PI) a1n -= 2 * Math.PI;
    while (a0 - a1n > Math.PI) a1n += 2 * Math.PI;
    pts.push(...arcPoints(c, rf, a0, a1n, deg(25), 2));
    pts.push(...arcPoints([0, 0], t.rRoot, fit.gamma, half, deg(6)));
  } else {
    for (let i = flank.length - 2; i >= 0; i--) pts.push(flank[i]);
    rf = 0;
    pts.push(...arcPoints([0, 0], t.rRoot, thetaRoot, half, deg(6)));
  }
  return { pts, fillet: rf };
}

/** All N teeth from one half: mirror it for the other side of the tooth, then
 *  rotate the unit round. CCW, no repeated closing point. */
function ringOfTeeth(half: Vec2[], teeth: number, rotation: number): Vec2[] {
  const unit: Vec2[] = [];
  // The mirrored half runs from the middle of the previous space up to the
  // centreline; skip its last point (the centreline itself, which `half`
  // starts with).
  for (let i = half.length - 1; i >= 1; i--) unit.push([half[i][0], -half[i][1]]);
  unit.push(...half.slice(0, -1)); // drop the next space's middle: the next unit starts there
  const out: Vec2[] = [];
  for (let k = 0; k < teeth; k++) {
    const a = rotation + (2 * Math.PI * k) / teeth;
    const ca = Math.cos(a),
      sa = Math.sin(a);
    for (const [x, y] of unit) out.push([x * ca - y * sa, x * sa + y * ca]);
  }
  return out;
}

/** A circle as a polyline, CCW. */
export function circlePoints(r: number, segs = 64, center: Vec2 = [0, 0]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    out.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  return out;
}

/** A D-shaped bore: a circle of `diameter` with one side cut flat so the
 *  distance from the flat to the far side is `acrossFlat`. The flat faces +u. */
export function dFlatPoints(diameter: number, acrossFlat: number, segs = 64): Vec2[] {
  const r = diameter / 2;
  const c = acrossFlat - r; // the flat's distance from the centre (signed)
  if (!(acrossFlat > 0) || acrossFlat >= diameter) throw new Error("gear: the D-flat must be smaller than the bore");
  const a0 = Math.acos(Math.max(-1, Math.min(1, c / r)));
  const out: Vec2[] = [];
  const n = Math.max(8, Math.round((segs * (2 * Math.PI - 2 * a0)) / (2 * Math.PI)));
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((2 * Math.PI - 2 * a0) * i) / n;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return out; // the closing edge is the flat
}

function toothShape(spec: GearToothSpec, internal: boolean): ToothShape {
  const ha = spec.addendum ?? 1;
  const hf = spec.dedendum ?? 1.25;
  const m = spec.module;
  const N = spec.teeth;
  const alpha = deg(spec.pressureAngle);
  const r = (m * N) / 2;
  const rb = r * Math.cos(alpha);
  if (!internal) {
    // Tooth thickness on the pitch circle, minus this gear's half of the play.
    const s = m * (Math.PI / 2 + 2 * spec.profileShift * Math.tan(alpha)) - spec.backlash / 2;
    return {
      teeth: N,
      rb,
      rTip: r + m * (ha + spec.profileShift),
      rRoot: r - m * (hf - spec.profileShift),
      psi: s / (2 * r) + inv(alpha),
      fillet: spec.rootFillet,
    };
  }
  // The SPACE of an internal gear, built as if it were an external tooth: its
  // "tip" is the ring's root (outer) circle and its "root" the ring's tip
  // (inner) circle. Backlash widens the space; a positive shift thins the
  // internal tooth (moves material outward), so it widens the space too.
  const x = spec.profileShift;
  const space = m * (Math.PI / 2 + 2 * x * Math.tan(alpha)) + spec.backlash / 2;
  return {
    teeth: N,
    rb,
    rTip: r + m * (hf + x),
    rRoot: r - m * (ha - x),
    psi: space / (2 * r) + inv(alpha),
    // A fillet here would round the internal tooth's TIP corners, not its
    // root — so none. (Its root corners are the space's tip corners, which
    // the tip arc meets at a sharp corner; fine for a first cut.)
    fillet: 0,
  };
}

export interface GearShapeOptions {
  internal?: boolean;
  /** Rotation of the whole gear about its centre, radians. */
  rotation?: number;
  /** External: an optional bore cut from the middle. */
  bore?: { kind: "round"; diameter: number } | { kind: "dflat"; diameter: number; acrossFlat: number };
  /** Internal: the radial thickness of the ring beyond the tooth roots (mm). */
  rimWidth?: number;
}

/** The complete gear outline: for an external gear the toothed outline (and a
 *  bore hole); for an internal gear the rim circle with the toothed space as
 *  the hole. Throws with a readable message when the numbers can't make one. */
export function gearOutline(spec: GearToothSpec, opts: GearShapeOptions = {}): GearOutline {
  validateToothSpec(spec);
  const internal = !!opts.internal;
  const dims = gearDims(spec, internal);
  const shape = toothShape(spec, internal);
  const { pts: half, fillet } = halfTooth(shape);
  const teethRing = ringOfTeeth(half, spec.teeth, opts.rotation ?? 0);
  const undercut =
    !internal && spec.teeth < minTeethWithoutUndercut(spec.pressureAngle, spec.profileShift, spec.addendum ?? 1) - 1e-9;

  if (internal) {
    const rim = opts.rimWidth ?? 2 * spec.module;
    if (!(rim > 0) || !Number.isFinite(rim)) throw new Error("gear: rim width must be greater than 0");
    const outerR = dims.rootDiameter / 2 + rim;
    // Rim facets fine enough that a chord never dips toward the tooth roots.
    const segs = Math.max(96, Math.min(360, spec.teeth * 3));
    return { outline: circlePoints(outerR, segs), holes: [teethRing], dims, undercut: false, rootFillet: 0 };
  }

  const holes: Vec2[][] = [];
  const bore = opts.bore;
  if (bore) {
    if (!(bore.diameter > 0) || !Number.isFinite(bore.diameter))
      throw new Error("gear: bore diameter must be greater than 0");
    if (bore.diameter >= dims.rootDiameter - 1e-6)
      throw new Error(
        `gear: the bore (Ø${round(bore.diameter)}) must be smaller than the root diameter (Ø${round(dims.rootDiameter)})`,
      );
    holes.push(bore.kind === "round" ? circlePoints(bore.diameter / 2) : dFlatPoints(bore.diameter, bore.acrossFlat));
  }
  return { outline: teethRing, holes, dims, undercut, rootFillet: fillet };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Centre distance of a meshing pair at the standard (unshifted) pitch
 *  circles: the sum of the pitch radii, or their difference when one is an
 *  internal gear. */
export function centerDistance(module: number, teethA: number, teethB: number, oneIsInternal = false): number {
  return oneIsInternal ? (module * Math.abs(teethA - teethB)) / 2 : (module * (teethA + teethB)) / 2;
}
