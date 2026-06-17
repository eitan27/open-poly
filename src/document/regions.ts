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

function shoelace(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(a) / 2;
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

  // Trace closed loops of line entities via shared endpoints.
  const lines = entities.filter((e): e is Extract<SketchEntity, { type: "line" }> => e.type === "line");
  const adj = new Map<string, { lineId: string; to: Vec2 }[]>();
  const link = (from: Vec2, to: Vec2, lineId: string) => {
    const k = key(from);
    if (!adj.has(k)) adj.set(k, []);
    adj.get(k)!.push({ lineId, to });
  };
  for (const l of lines) {
    link(l.a, l.b, l.id);
    link(l.b, l.a, l.id);
  }
  const used = new Set<string>();
  for (const start of lines) {
    if (used.has(start.id)) continue;
    const loop: Vec2[] = [start.a];
    let cur = start.b;
    used.add(start.id);
    let closed = false;
    for (let guard = 0; guard <= lines.length; guard++) {
      if (key(cur) === key(start.a)) {
        closed = true;
        break;
      }
      loop.push(cur);
      const next = (adj.get(key(cur)) ?? []).find((e) => !used.has(e.lineId));
      if (!next) break;
      used.add(next.lineId);
      cur = next.to;
    }
    if (closed && loop.length >= 3) {
      regions.push({ id: `region-loop-${start.id}`, outline: loop, area: shoelace(loop) });
    }
  }

  return regions;
}
