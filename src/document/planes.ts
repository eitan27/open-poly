// The three standard datum planes and their 2D coordinate frames. A sketch lives
// on one plane; sketch entities are stored in 2D (u, v) and mapped to 3D world
// space as: world = origin + u*uAxis + v*vAxis. Axes are orthonormal, so the
// inverse is u = (P - origin)·uAxis, v = (P - origin)·vAxis. (Z-up world.)

export type SketchPlaneId = "plane-top" | "plane-front" | "plane-right";

export type Vec3 = [number, number, number];

export interface PlaneFrame {
  id: SketchPlaneId;
  label: string;
  origin: Vec3;
  uAxis: Vec3;
  vAxis: Vec3;
  normal: Vec3;
  /** Standard view that looks normal-to this plane. */
  view: "top" | "front" | "right";
}

export const PLANES: Record<SketchPlaneId, PlaneFrame> = {
  "plane-top": {
    id: "plane-top",
    label: "Top",
    origin: [0, 0, 0],
    uAxis: [1, 0, 0],
    vAxis: [0, 1, 0],
    normal: [0, 0, 1],
    view: "top",
  },
  "plane-front": {
    id: "plane-front",
    label: "Front",
    origin: [0, 0, 0],
    uAxis: [1, 0, 0],
    vAxis: [0, 0, 1],
    normal: [0, 1, 0],
    view: "front",
  },
  "plane-right": {
    id: "plane-right",
    label: "Right",
    origin: [0, 0, 0],
    uAxis: [0, 1, 0],
    vAxis: [0, 0, 1],
    normal: [1, 0, 0],
    view: "right",
  },
};

/** A bare coordinate frame (no datum identity) — used for sketches on faces. */
export interface PlaneFrameData {
  origin: Vec3;
  uAxis: Vec3;
  vAxis: Vec3;
  normal: Vec3;
}

/** Where a sketch (or a new reference plane) is placed: a named datum plane, a
 *  planar face of a body, or a user-created reference plane (by feature id). */
export type SketchPlaneRef =
  | { kind: "datum"; id: SketchPlaneId }
  | { kind: "face"; featureId: string; frame: PlaneFrameData }
  | { kind: "plane"; planeId: string };

/** Resolve a placement ref to a concrete frame. Reference-plane refs need the
 *  resolved-planes map (planeId -> frame), computed from the document. */
export function frameOf(ref: SketchPlaneRef, planes?: Map<string, PlaneFrameData>): PlaneFrameData {
  if (ref.kind === "datum") return PLANES[ref.id];
  if (ref.kind === "face") return ref.frame;
  const frame = planes?.get(ref.planeId);
  if (!frame) throw new Error("reference plane not found");
  return frame;
}

export function planeRefLabel(ref: SketchPlaneRef): string {
  if (ref.kind === "datum") return `${PLANES[ref.id].label} plane`;
  return ref.kind === "face" ? "Face" : "Reference plane";
}

/** Translate a frame along its own normal (an offset/parallel plane). */
export function offsetFrame(frame: PlaneFrameData, distance: number): PlaneFrameData {
  return {
    ...frame,
    origin: [
      frame.origin[0] + frame.normal[0] * distance,
      frame.origin[1] + frame.normal[1] * distance,
      frame.origin[2] + frame.normal[2] * distance,
    ],
  };
}

/** Map a 2D sketch point on a frame to a 3D world position. */
export function uvToWorld(frame: PlaneFrameData, u: number, v: number): Vec3 {
  return [
    frame.origin[0] + u * frame.uAxis[0] + v * frame.vAxis[0],
    frame.origin[1] + u * frame.uAxis[1] + v * frame.vAxis[1],
    frame.origin[2] + u * frame.uAxis[2] + v * frame.vAxis[2],
  ];
}

/** Orthographic projection of a world point onto a frame's plane → its 2D (u, v)
 *  sketch coordinates. The inverse of `uvToWorld`, dropping the normal component
 *  (so points off the plane fall to their foot of perpendicular). Used by the
 *  Project/Convert sketch tool to pull existing 3D geometry into a sketch. */
export function worldToUv(frame: PlaneFrameData, p: Vec3): [number, number] {
  const dx = p[0] - frame.origin[0];
  const dy = p[1] - frame.origin[1];
  const dz = p[2] - frame.origin[2];
  return [
    dx * frame.uAxis[0] + dy * frame.uAxis[1] + dz * frame.uAxis[2],
    dx * frame.vAxis[0] + dy * frame.vAxis[1] + dz * frame.vAxis[2],
  ];
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Build a sketch frame for a planar face from a point on it and its normal. */
export function deriveFaceFrame(point: Vec3, normal: Vec3): PlaneFrameData {
  const n = norm(normal);
  const ref: Vec3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = norm(cross(ref, n));
  const v = norm(cross(n, u));
  const d = point[0] * n[0] + point[1] * n[1] + point[2] * n[2];
  // closest point on the face plane to the world origin
  const origin: Vec3 = [n[0] * d, n[1] * d, n[2] * d];
  return { origin, uAxis: u, vAxis: v, normal: n };
}

/** Build a frame from an explicit origin + normal (origin is kept as-is, unlike
 *  deriveFaceFrame which snaps it to the foot of the perpendicular from world 0). */
export function frameFromPointNormal(origin: Vec3, normal: Vec3): PlaneFrameData {
  const n = norm(normal);
  const ref: Vec3 = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = norm(cross(ref, n));
  const v = norm(cross(n, u));
  return { origin, uAxis: u, vAxis: v, normal: n };
}

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** Midplane between two plane frames: origin at the midpoint of the two frame
 *  origins, normal the aligned average (B's normal is flipped if it faces away,
 *  so two faces pointing at each other still give a sensible between-plane). */
export function midplaneFrame(a: PlaneFrameData, b: PlaneFrameData): PlaneFrameData {
  const alignedB = dot3(a.normal, b.normal) < 0 ? scale3(b.normal, -1) : b.normal;
  const n = add3(a.normal, alignedB);
  const normal = Math.hypot(n[0], n[1], n[2]) < 1e-9 ? a.normal : n;
  return frameFromPointNormal(scale3(add3(a.origin, b.origin), 0.5), normal);
}

/** Rotate vector v about unit axis k by `ang` radians (Rodrigues' formula). */
function rotateAbout(v: Vec3, k: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang),
    s = Math.sin(ang);
  const kxv = cross(k, v);
  const kdv = dot3(k, v) * (1 - c);
  return [v[0] * c + kxv[0] * s + k[0] * kdv, v[1] * c + kxv[1] * s + k[1] * kdv, v[2] * c + kxv[2] * s + k[2] * kdv];
}

/** A plane hinged on the base's u- or v-axis (through the base origin), tilted by
 *  `angleDeg` away from the base plane. The hinge axis becomes the new u-axis. */
export function angledFrame(base: PlaneFrameData, axis: "u" | "v", angleDeg: number): PlaneFrameData {
  const k = norm(axis === "u" ? base.uAxis : base.vAxis);
  const normal = rotateAbout(base.normal, k, (angleDeg * Math.PI) / 180);
  const v = cross(normal, k);
  return { origin: base.origin, uAxis: k, vAxis: norm(v), normal: norm(normal) };
}

/** Plane through three points (origin p0, normal (p1-p0)×(p2-p0)); null if the
 *  points are collinear. */
export function planeThrough3Points(p0: Vec3, p1: Vec3, p2: Vec3): PlaneFrameData | null {
  const n = cross(sub3(p1, p0), sub3(p2, p0));
  if (Math.hypot(n[0], n[1], n[2]) < 1e-9) return null;
  return frameFromPointNormal(p0, n);
}

/** The line where two planes meet: direction = n_a × n_b, plus the point on the
 *  line closest to the world origin. Returns null if the planes are parallel
 *  (|n_a × n_b| ≈ 0, no intersection line). Used to turn a plane armed as a
 *  revolve axis into a concrete rotation axis (the plane ∩ the profile plane). */
export function planeIntersectionLine(a: PlaneFrameData, b: PlaneFrameData): { origin: Vec3; dir: Vec3 } | null {
  const dir = cross(a.normal, b.normal);
  const denom = dot3(dir, dir);
  if (denom < 1e-12) return null; // parallel planes
  // Plane offsets d = n·origin (planes are n·x = d).
  const da = dot3(a.normal, a.origin);
  const db = dot3(b.normal, b.origin);
  // p0 = ( da (n_b × dir) + db (dir × n_a) ) / |dir|²  — the foot of the
  // perpendicular from the origin onto the intersection line.
  const origin = scale3(add3(scale3(cross(b.normal, dir), da), scale3(cross(dir, a.normal), db)), 1 / denom);
  return { origin, dir };
}
