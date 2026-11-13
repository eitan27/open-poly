// Placing several instances at once — the Insert dialog's per-part count, and
// Duplicate on an instance — so copies are never stacked on one another (they
// would look like one part, and only the top one could be clicked). They're
// laid out in a grid of about √n columns, a gap apart, clear of what's there.
//
// Inserting every part once keeps today's behaviour: the document's parts land
// together beside what's placed, in the arrangement they were modelled in.
// Once any part is wanted more than once, each part's copies get a grid of
// their own, the grids side by side along +X past everything placed.
// Duplicates go in a grid just beside their original, turned as it is, in its
// colour, with no mates and not grounded: they're new parts to place.
import { insertInstances, updateInstance } from "./assembly";
import { applyPoint, INSERT_GAP_MM, insertShift, meshBounds, multiply, translation, type Vec3 } from "./placement";
import type { AssemblyDoc, Mat4 } from "./types";
import type { ShapeMeshPayload } from "../kernel/types";

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** `mesh`'s bounds once moved by `m` (its box's corners, moved). */
export function placedBounds(mesh: ShapeMeshPayload, m: Mat4): Bounds | null {
  const b = meshBounds(mesh);
  if (!b) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) {
        const p = applyPoint(m, [x, y, z]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
  return { min, max };
}

/** Moves that lay `n` copies of something with `bounds` out in a grid of
 *  ⌈√n⌉ columns along +X and rows along +Y, a `gap` apart, the grid's left
 *  edge at x = `left`. Its width, for the next grid. */
export function gridMoves(n: number, bounds: Bounds, left: number, gap: number): { moves: Mat4[]; width: number } {
  const cols = Math.ceil(Math.sqrt(n));
  const w = bounds.max[0] - bounds.min[0] + gap;
  const d = bounds.max[1] - bounds.min[1] + gap;
  const moves = Array.from({ length: n }, (_, k) =>
    translation([left - bounds.min[0] + (k % cols) * w, Math.floor(k / cols) * d, 0]),
  );
  return { moves, width: Math.min(n, cols) * w };
}

/** One part to insert, `count` times. */
export interface InsertPick {
  partId: string;
  name: string;
  mesh: ShapeMeshPayload;
  count: number;
}

/** Where each copy of `picks` goes, given the bounds of what's placed:
 *  every part once keeps the document's arrangement, beside what's there;
 *  otherwise a grid per part, side by side past it. */
export function insertLayout(
  placed: (Bounds | null)[],
  picks: InsertPick[],
  gap = INSERT_GAP_MM,
): { partId: string; name: string; transform: Mat4 }[] {
  const live = picks.filter((p) => p.count > 0);
  if (live.every((p) => p.count === 1)) {
    const shift = insertShift(
      placed,
      live.map((p) => meshBounds(p.mesh)),
      gap,
    );
    return live.map((p) => ({ partId: p.partId, name: p.name, transform: translation([shift, 0, 0]) }));
  }
  const there = placed.filter((b): b is Bounds => b !== null);
  let left: number | null = there.length ? Math.max(...there.map((b) => b.max[0])) + gap : null;
  const out: { partId: string; name: string; transform: Mat4 }[] = [];
  for (const p of live) {
    const b = meshBounds(p.mesh) ?? { min: [0, 0, 0], max: [0, 0, 0] };
    // With nothing placed, the first grid starts where the part was modelled.
    const start = left ?? b.min[0];
    const g = gridMoves(p.count, b, start, gap);
    for (const m of g.moves) out.push({ partId: p.partId, name: p.name, transform: m });
    left = start + g.width;
  }
  return out;
}

/** `a` with `count` copies of each instance in `ids`, in a grid beside it —
 *  or, if that would overlap something already placed (an earlier copy
 *  included), past everything along +X, level with it. `placement` and `mesh`
 *  give where an instance sits and its part's mesh. The copies' ids, in
 *  order. */
export function duplicateInstances(
  a: AssemblyDoc,
  ids: string[],
  count: number,
  placement: (id: string) => Mat4,
  mesh: (id: string) => ShapeMeshPayload | undefined,
  genId: () => string,
  gap = INSERT_GAP_MM,
): { assembly: AssemblyDoc; ids: string[] } {
  let out = a;
  const made: string[] = [];
  // What's placed, kept up to date as copies are added.
  const placed: Bounds[] = [];
  for (const i of a.instances) {
    const m = mesh(i.id);
    const b = m && placedBounds(m, placement(i.id));
    if (b) placed.push(b);
  }
  for (const id of ids) {
    const inst = a.instances.find((i) => i.id === id);
    const m = mesh(id);
    if (!inst || !m || count < 1) continue;
    const at = placement(id);
    const b = placedBounds(m, at);
    if (!b) continue;
    // A copy is named after the original without its number: Bolt <1> → Bolt <2>.
    const base = inst.name.replace(/\s*<\d+>$/, "");
    // Beside the original if the grid there is clear, else past everything.
    let grid = gridMoves(count, b, b.max[0] + gap, gap);
    const area = (g: typeof grid): Bounds => ({
      min: [b.max[0] + gap, b.min[1], b.min[2]],
      max: [
        b.max[0] + gap + g.width,
        b.min[1] + Math.ceil(count / Math.ceil(Math.sqrt(count))) * (b.max[1] - b.min[1] + gap),
        b.max[2],
      ],
    });
    if (placed.some((p) => overlaps(p, area(grid)))) {
      const past = Math.max(...placed.map((p) => p.max[0])) + gap;
      grid = gridMoves(count, b, past, gap);
    }
    const { moves } = grid;
    // insertInstances numbers the names (Bolt <2>, <3>…); it grounds only the
    // first instance of an empty assembly, which one with the original isn't.
    const parts = moves.map((move) => ({ partId: inst.source.partId, name: base, transform: multiply(move, at) }));
    const r = insertInstances(out, inst.source.docId, parts, genId);
    out = r.assembly;
    for (const [k, nid] of r.ids.entries()) {
      if (inst.color !== undefined) out = updateInstance(out, nid, { color: inst.color });
      made.push(nid);
      const nb = placedBounds(m, parts[k].transform);
      if (nb) placed.push(nb);
    }
  }
  return { assembly: out, ids: made };
}

/** Whether two boxes overlap (touching doesn't count). */
function overlaps(p: Bounds, q: Bounds): boolean {
  return [0, 1, 2].every((k) => p.min[k] < q.max[k] - 1e-6 && q.min[k] < p.max[k] - 1e-6);
}
