// Detects enclosed regions ("sketch faces") of a sketch: each circle is a disk,
// and closed loops of connected line segments are polygons. Outlines are in 2D
// (uv); used both for the clickable fill and for area display. (MVP: lines +
// circles; arcs are not yet treated as region boundaries.)
import type { SketchEntity, Vec2 } from "./types";

export interface SketchRegion {
  id: string;
  outline: Vec2[]; // closed loop of uv points
  area: number;
}

const key = (p: Vec2) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

/** Signed area (CCW positive) via the shoelace formula. */
function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

export function detectSketchRegions(entities: SketchEntity[]): SketchRegion[] {
  const regions: SketchRegion[] = [];

  for (const e of entities) {
    if (e.type !== "circle") continue;
    const outline: Vec2[] = [];
    const SEG = 48;
    for (let i = 0; i < SEG; i++) {
      const t = (2 * Math.PI * i) / SEG;
      outline.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]);
    }
    regions.push({ id: `region-${e.id}`, outline, area: Math.PI * e.r * e.r });
  }

  // Find every enclosed region bounded by line entities. Treat the lines as a
  // planar graph and enumerate its faces: each line becomes two directed
  // half-edges, and each directed half-edge belongs to exactly one face. This
  // (unlike a greedy loop tracer) lets a single line bound two adjacent
  // regions — e.g. the middle polygon formed when two polygons are bridged.
  const lines = entities.filter((e): e is Extract<SketchEntity, { type: "line" }> => e.type === "line");

  // Unique vertices (by rounded position).
  const nodeIndex = new Map<string, number>();
  const nodePos: Vec2[] = [];
  const node = (p: Vec2): number => {
    const k = key(p);
    let i = nodeIndex.get(k);
    if (i === undefined) {
      i = nodePos.length;
      nodeIndex.set(k, i);
      nodePos.push(p);
    }
    return i;
  };

  // Half-edges, stored so that twin(i) === i ^ 1.
  interface HalfEdge { from: number; to: number; lineId: string; angle: number }
  const he: HalfEdge[] = [];
  for (const l of lines) {
    const a = node(l.a);
    const b = node(l.b);
    if (a === b) continue; // degenerate
    he.push({ from: a, to: b, lineId: l.id, angle: Math.atan2(l.b[1] - l.a[1], l.b[0] - l.a[0]) });
    he.push({ from: b, to: a, lineId: l.id, angle: Math.atan2(l.a[1] - l.b[1], l.a[0] - l.b[0]) });
  }

  // Outgoing half-edges per vertex, sorted CCW by angle.
  const outgoing: number[][] = nodePos.map(() => []);
  he.forEach((e, i) => outgoing[e.from].push(i));
  for (const list of outgoing) list.sort((p, q) => he[p].angle - he[q].angle);

  // next(e): arriving at e.to, turn to the most-clockwise next edge — i.e. the
  // half-edge just before the reverse edge (twin) in CCW order around e.to.
  const next = (i: number): number => {
    const twin = i ^ 1;
    const list = outgoing[he[i].to];
    const pos = list.indexOf(twin);
    return list[(pos - 1 + list.length) % list.length];
  };

  const visited = new Array<boolean>(he.length).fill(false);
  for (let s = 0; s < he.length; s++) {
    if (visited[s]) continue;
    const loop: Vec2[] = [];
    const lineIds = new Set<string>();
    let cur = s;
    for (let guard = 0; guard <= he.length; guard++) {
      if (visited[cur]) break;
      visited[cur] = true;
      loop.push(nodePos[he[cur].from]);
      lineIds.add(he[cur].lineId);
      cur = next(cur);
      if (cur === s) break;
    }
    // Bounded faces come out CCW (positive signed area); the single outer face
    // comes out CW (negative) and is discarded. Slivers/danglers are ~0.
    const a = signedArea(loop);
    if (loop.length >= 3 && a > 1e-7) {
      const id = `region-loop-${[...lineIds].sort().join("_")}`;
      regions.push({ id, outline: loop, area: a });
    }
  }

  return regions;
}
