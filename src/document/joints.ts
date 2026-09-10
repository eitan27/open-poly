// Geometry that arrives already joined gets that joint written down.
//
// The solver identifies points REFERENTIALLY — one point per entity vertex, so
// two vertices at the same coordinates are two points until a `coincident`
// constraint says they're one (see sketch/solver.ts). That's what makes a
// coincidence survive a solve that moves things. The cost is that a joint can no
// longer be implied by position: everything that produces already-touching
// geometry — a chained polyline, a rectangle's four corners, an arc drawn onto a
// line's end, a sketch the agent authors as a list of shapes — has to say so.
//
// Rather than teach every producer, the joints are derived once, where geometry
// enters a sketch (`addSketchEntities`) and where old documents are loaded
// (`migrateDocument`): any two solver-visible vertices sitting on the same point
// are joined, unless they're already joined. That preserves exactly what the old
// coordinate merge did — and then keeps it.

import type { SketchConstraint, SketchEntity, Vec2 } from "./types";

/** One solver-visible vertex of one entity. `at` matches PointRef's naming: a
 *  line's two ends, a circle's centre, an arc's centre and two ends. */
export interface Vertex {
  entity: string;
  at: "a" | "b" | "c";
  p: Vec2;
}

/** Rounded-coordinate key — the same 4dp rounding the solver uses to decide a
 *  vertex is sitting on the origin, so "same point" means the same thing on both
 *  sides. */
export function coordKey(p: Vec2): string {
  const c = (v: number) => {
    const s = v.toFixed(4);
    return s === "-0.0000" ? "0.0000" : s;
  };
  return `${c(p[0])},${c(p[1])}`;
}

const ORIGIN_KEY = coordKey([0, 0]);

/** The vertices of an entity that the solver can constrain. Derived geometry
 *  (offset/mirror/project output) is regenerated from its sources rather than
 *  solved, and splines/points/text aren't mapped, so none of them have any. */
export function entityVertices(e: SketchEntity): Vertex[] {
  if (e.derivedFrom) return [];
  if (e.type === "line")
    return [
      { entity: e.id, at: "a", p: e.a },
      { entity: e.id, at: "b", p: e.b },
    ];
  if (e.type === "circle") return [{ entity: e.id, at: "c", p: e.c }];
  if (e.type === "arc")
    return [
      { entity: e.id, at: "c", p: e.c },
      { entity: e.id, at: "a", p: [e.c[0] + e.r * Math.cos(e.start), e.c[1] + e.r * Math.sin(e.start)] },
      { entity: e.id, at: "b", p: [e.c[0] + e.r * Math.cos(e.end), e.c[1] + e.r * Math.sin(e.end)] },
    ];
  return [];
}

/** Union-find over vertex keys, so a joint that already holds — directly or
 *  through a chain of other joints — is never written twice. */
class Joined {
  private parent = new Map<string, string>();
  find(k: string): string {
    const p = this.parent.get(k);
    if (p === undefined) return k;
    const root = this.find(p);
    this.parent.set(k, root);
    return root;
  }
  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent.set(ra, rb);
    return true;
  }
}

const vertexKey = (v: { entity: string; at: string }) => `${v.entity}:${v.at}`;

/** The `coincident` constraints a sketch is MISSING: one for each pair of
 *  vertices that sit on the same point without already being joined.
 *
 *  Two exclusions. Vertices on the **origin** are left alone — the solver pins
 *  each of them there as immovable ground, so they're already coincident and a
 *  constraint between two pinned points reads as redundant. And a vertex already
 *  joined to another **transitively** needs nothing: a rectangle's four corners
 *  are four constraints, not six. */
export function missingJoints(
  entities: SketchEntity[],
  constraints: SketchConstraint[],
  genId: () => string,
): SketchConstraint[] {
  const joined = new Joined();
  for (const c of constraints) {
    if (c.type !== "coincident") continue;
    if ("entity" in c.a && "entity" in c.b) joined.union(vertexKey(c.a), vertexKey(c.b));
  }

  const groups = new Map<string, Vertex[]>();
  for (const e of entities) {
    for (const v of entityVertices(e)) {
      const k = coordKey(v.p);
      if (k === ORIGIN_KEY) continue;
      const g = groups.get(k);
      if (g) g.push(v);
      else groups.set(k, [v]);
    }
  }

  const added: SketchConstraint[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    for (const v of rest) {
      if (!joined.union(vertexKey(first), vertexKey(v))) continue;
      added.push({
        id: genId(),
        type: "coincident",
        a: { entity: first.entity, at: first.at },
        b: { entity: v.entity, at: v.at },
      });
    }
  }
  return added;
}
