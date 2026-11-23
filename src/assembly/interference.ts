// Interference: which placed parts of an assembly overlap, and by how much.
//
// The overlap itself is the kernel's (an exact boolean common of the two
// solids, in the worker — see `interfere` there); here is what to ask it:
// - only pairs whose world bounding boxes overlap (cheap, from the meshes),
// - among the instances in scope (the selection, or all), visible ones only —
//   hiding one says it isn't part of what's shown, as for export,
// - each part document's features, read from storage (cached by save time).
// Parts that only touch (a face on a face, teeth flank to flank) share no
// volume and don't count.
import { migrateDocument, resolveDocument } from "../document/document";
import type { InterferenceDoc, InterferencePair, Kernel, ShapeMeshPayload } from "../kernel/types";
import { loadDoc } from "../storage/db";
import { applyPoint } from "./placement";
import type { AssemblyDoc, Mat4 } from "./types";
import type { SourceState } from "./useAssemblySources";

type Box = { min: [number, number, number]; max: [number, number, number] };

/** One overlap: two instances and what they share. */
export interface Clash {
  a: string;
  b: string;
  /** mm³ */
  volume: number;
  /** In the world, when asked for. */
  mesh?: ShapeMeshPayload;
}

export interface InterferenceReport {
  clashes: Clash[];
  /** Pairs close enough to need the kernel (boxes overlapping). */
  checked: number;
  /** Instances looked at. */
  instances: number;
  /** Pairs the kernel couldn't decide, with why. */
  errors: { a: string; b: string; error: string }[];
}

const boxCache = new WeakMap<ShapeMeshPayload, Box | null>();
function localBox(mesh: ShapeMeshPayload): Box | null {
  if (boxCache.has(mesh)) return boxCache.get(mesh)!;
  const v = mesh.faces.vertices;
  let box: Box | null = null;
  if (v.length >= 3) {
    box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let i = 0; i < v.length; i += 3)
      for (let k = 0; k < 3; k++) {
        box.min[k] = Math.min(box.min[k], v[i + k]);
        box.max[k] = Math.max(box.max[k], v[i + k]);
      }
  }
  boxCache.set(mesh, box);
  return box;
}

/** `b`'s eight corners placed by `m`, boxed again (a little larger than the
 *  part when it's turned, never smaller). */
export function worldBox(b: Box, m: Mat4): Box {
  const out: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < 8; i++) {
    const p = applyPoint(m, [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
    for (let k = 0; k < 3; k++) {
      out.min[k] = Math.min(out.min[k], p[k]);
      out.max[k] = Math.max(out.max[k], p[k]);
    }
  }
  return out;
}

const overlaps = (p: Box, q: Box, slack: number) =>
  [0, 1, 2].every((k) => p.min[k] <= q.max[k] + slack && q.min[k] <= p.max[k] + slack);

/** The placed parts in play: visible instances whose part has loaded. */
export function placedParts(
  assembly: AssemblyDoc,
  sources: ReadonlyMap<string, SourceState>,
  placements: ReadonlyMap<string, Mat4> | undefined,
): { id: string; docId: string; partId: string; mesh: ShapeMeshPayload; transform: Mat4 }[] {
  const out = [];
  for (const i of assembly.instances) {
    if (i.hidden) continue;
    const src = sources.get(i.source.docId);
    if (src?.status !== "ready") continue;
    const part = src.parts.find((p) => p.partId === i.source.partId);
    if (!part) continue;
    out.push({
      id: i.id,
      docId: i.source.docId,
      partId: i.source.partId,
      mesh: part.mesh,
      transform: placements?.get(i.id) ?? i.transform,
    });
  }
  return out;
}

/** The pairs worth asking the kernel about: both placed, boxes overlapping,
 *  at least one in `scope` (empty = every instance). */
export function candidatePairs(parts: ReturnType<typeof placedParts>, scope: ReadonlySet<string>): [number, number][] {
  const boxes = parts.map((p) => {
    const b = localBox(p.mesh);
    return b && worldBox(b, p.transform);
  });
  const out: [number, number][] = [];
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      if (scope.size && !scope.has(parts[i].id) && !scope.has(parts[j].id)) continue;
      const bi = boxes[i];
      const bj = boxes[j];
      if (bi && bj && overlaps(bi, bj, 1e-3)) out.push([i, j]);
    }
  return out;
}

// Each part document's resolved features, by its save time.
const featureCache = new Map<string, { version: string; doc: InterferenceDoc }>();

async function docsFor(
  docIds: Iterable<string>,
  sources: ReadonlyMap<string, SourceState>,
): Promise<InterferenceDoc[] | string> {
  const out: InterferenceDoc[] = [];
  for (const docId of new Set(docIds)) {
    const src = sources.get(docId);
    const version = src?.status === "ready" ? String(src.updatedAt) : "";
    const kept = featureCache.get(docId);
    if (kept && kept.version === version) {
      out.push(kept.doc);
      continue;
    }
    const rec = await loadDoc(docId);
    if (!rec || rec.assembly) return `A part document (${src && "name" in src ? src.name : docId}) is gone.`;
    const doc: InterferenceDoc = {
      docId,
      version,
      features: resolveDocument(migrateDocument(rec.doc)).features,
    };
    featureCache.set(docId, { version, doc });
    out.push(doc);
  }
  return out;
}

const pairOf = (parts: ReturnType<typeof placedParts>, [i, j]: [number, number]): InterferencePair => ({
  a: { docId: parts[i].docId, bodyId: parts[i].partId, transform: [...parts[i].transform] },
  b: { docId: parts[j].docId, bodyId: parts[j].partId, transform: [...parts[j].transform] },
});

/** What overlaps, where the parts are now. `scope`: instances to check
 *  against everything (empty = every pair). */
export async function checkInterference(
  kernel: Pick<Kernel, "interfere">,
  assembly: AssemblyDoc,
  sources: ReadonlyMap<string, SourceState>,
  placements: ReadonlyMap<string, Mat4> | undefined,
  scope: ReadonlySet<string> = new Set(),
  withMesh = true,
): Promise<InterferenceReport | string> {
  const parts = placedParts(assembly, sources, placements);
  const pairs = candidatePairs(parts, scope);
  const report: InterferenceReport = { clashes: [], checked: pairs.length, instances: parts.length, errors: [] };
  if (!pairs.length) return report;
  const docs = await docsFor(
    pairs.flatMap(([i, j]) => [parts[i].docId, parts[j].docId]),
    sources,
  );
  if (typeof docs === "string") return docs;
  const [results] = await kernel.interfere(docs, [pairs.map((p) => pairOf(parts, p))], withMesh);
  pairs.forEach(([i, j], k) => {
    const r = results[k];
    if (r.error) report.errors.push({ a: parts[i].id, b: parts[j].id, error: r.error });
    else if (r.volume > 0)
      report.clashes.push({ a: parts[i].id, b: parts[j].id, volume: r.volume, ...(r.mesh ? { mesh: r.mesh } : {}) });
  });
  report.clashes.sort((p, q) => q.volume - p.volume);
  return report;
}

/** One sampled moment of a motion: the driven value and where everything is. */
export interface MotionFrame {
  value: number;
  placements: ReadonlyMap<string, Mat4>;
}

/** Each frame's overlaps, in one round trip (no meshes — show one by checking
 *  again at its value). Clashes are named by instance ids. */
export async function checkMotion(
  kernel: Pick<Kernel, "interfere">,
  assembly: AssemblyDoc,
  sources: ReadonlyMap<string, SourceState>,
  frames: MotionFrame[],
  scope: ReadonlySet<string> = new Set(),
): Promise<{ value: number; clashes: Clash[] }[] | string> {
  const perFrame = frames.map((f) => {
    const parts = placedParts(assembly, sources, f.placements);
    return { parts, pairs: candidatePairs(parts, scope) };
  });
  const docIds = perFrame.flatMap(({ parts, pairs }) => pairs.flatMap(([i, j]) => [parts[i].docId, parts[j].docId]));
  if (!docIds.length) return frames.map((f) => ({ value: f.value, clashes: [] }));
  const docs = await docsFor(docIds, sources);
  if (typeof docs === "string") return docs;
  const results = await kernel.interfere(
    docs,
    perFrame.map(({ parts, pairs }) => pairs.map((p) => pairOf(parts, p))),
    false,
  );
  return perFrame.map(({ parts, pairs }, f) => ({
    value: frames[f].value,
    clashes: pairs.flatMap(([i, j], k) =>
      results[f][k].volume > 0 ? [{ a: parts[i].id, b: parts[j].id, volume: results[f][k].volume }] : [],
    ),
  }));
}

/** A clash's volume for reading: "0.42 mm³", "1,250 mm³". */
export function fmtVolume(v: number): string {
  const n = v >= 100 ? Math.round(v) : v >= 1 ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 1000;
  return `${n.toLocaleString("en-US")} mm³`;
}

/** A pair's clashes over a motion, as runs of consecutive sampled values. */
export interface ClashRange {
  a: string;
  b: string;
  from: number;
  to: number;
  /** Where in the run they overlap most. */
  worst: { value: number; volume: number };
}

/** `checkMotion`'s frames as ranges per pair, in sweep order. */
export function clashRanges(frames: { value: number; clashes: Clash[] }[]): ClashRange[] {
  const out: ClashRange[] = [];
  const open = new Map<string, ClashRange>();
  frames.forEach((f) => {
    const here = new Set<string>();
    for (const c of f.clashes) {
      const key = [c.a, c.b].sort().join("|");
      here.add(key);
      const r = open.get(key);
      if (r) {
        r.to = f.value;
        if (c.volume > r.worst.volume) r.worst = { value: f.value, volume: c.volume };
      } else {
        const n: ClashRange = {
          a: c.a,
          b: c.b,
          from: f.value,
          to: f.value,
          worst: { value: f.value, volume: c.volume },
        };
        open.set(key, n);
        out.push(n);
      }
    }
    for (const key of [...open.keys()]) if (!here.has(key)) open.delete(key);
  });
  return out;
}

/** The values a motion check samples from `from` to `to`, both included:
 *  about every 2° (or 0.5 mm), 24–240 of them. */
export function motionSamples(from: number, to: number, rotation: boolean): number[] {
  const n = Math.min(240, Math.max(24, Math.ceil(Math.abs(to - from) / (rotation ? 2 : 0.5))));
  return Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);
}

/** The instances a motion moves: placed differently in some frame. */
export function movingInstances(frames: MotionFrame[]): Set<string> {
  const out = new Set<string>();
  const first = frames[0]?.placements;
  if (!first) return out;
  for (const f of frames.slice(1))
    for (const [id, m] of f.placements) {
      const m0 = first.get(id);
      if (!m0 || m.some((v, i) => Math.abs(v - m0[i]) > 1e-6)) out.add(id);
    }
  return out;
}

/** Check a motion for clashes: solve each value (`at`), stopping where a
 *  mate fails that didn't before (`baseProblems`), then intersect the parts
 *  that move with everything else, `batch` frames per round trip.
 *  `onProgress` after each batch; `cancelled` checked between them (then
 *  null). A string when it can't: why. */
export async function sweepClashes(
  kernel: Pick<Kernel, "interfere">,
  assembly: AssemblyDoc,
  sources: ReadonlyMap<string, SourceState>,
  at: (value: number) => { placements: ReadonlyMap<string, Mat4>; problems: ReadonlyMap<string, string> },
  values: number[],
  baseProblems: ReadonlyMap<string, string>,
  opts: { batch?: number; onProgress?: (done: number) => void; cancelled?: () => boolean } = {},
): Promise<{ ranges: ClashRange[]; samples: number; jammedAt?: number } | string | null> {
  const frames: MotionFrame[] = [];
  let jammedAt: number | undefined;
  for (const value of values) {
    const s = at(value);
    if ([...s.problems.keys()].some((p) => !baseProblems.has(p))) {
      jammedAt = value;
      break;
    }
    frames.push({ value, placements: s.placements });
  }
  const moving = movingInstances(frames);
  const batch = opts.batch ?? 12;
  const found: { value: number; clashes: Clash[] }[] = [];
  for (let i = 0; i < frames.length && moving.size; i += batch) {
    const r = await checkMotion(kernel, assembly, sources, frames.slice(i, i + batch), moving);
    if (opts.cancelled?.()) return null;
    if (typeof r === "string") return r;
    found.push(...r);
    opts.onProgress?.(Math.min(frames.length, i + batch));
  }
  return { ranges: clashRanges(found), samples: frames.length, ...(jammedAt !== undefined ? { jammedAt } : {}) };
}
