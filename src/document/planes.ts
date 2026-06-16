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

/** Where a sketch lives: a named datum plane, or a planar face of a body. */
export type SketchPlaneRef =
  | { kind: "datum"; id: SketchPlaneId }
  | { kind: "face"; featureId: string; frame: PlaneFrameData };

export function frameOf(ref: SketchPlaneRef): PlaneFrameData {
  return ref.kind === "datum" ? PLANES[ref.id] : ref.frame;
}

export function planeRefLabel(ref: SketchPlaneRef): string {
  return ref.kind === "datum" ? `${PLANES[ref.id].label} plane` : "Face";
}

/** Map a 2D sketch point on a frame to a 3D world position. */
export function uvToWorld(frame: PlaneFrameData, u: number, v: number): Vec3 {
  return [
    frame.origin[0] + u * frame.uAxis[0] + v * frame.vAxis[0],
    frame.origin[1] + u * frame.uAxis[1] + v * frame.vAxis[1],
    frame.origin[2] + u * frame.uAxis[2] + v * frame.vAxis[2],
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
