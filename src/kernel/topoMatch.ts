// Geometric fallback matching for topological references (the "N3" layer of
// the naming strategy — see PLAN §"The hard part: topological naming").
//
// A downstream feature references a face/edge of an earlier body by its
// PERSISTENT NAME (built from OCCT construction history). Names survive most
// edits, but a big upstream change can split/merge topology and re-suffix or
// drop a name. When that happens we fall back to matching the reference's
// stored GEOMETRIC FINGERPRINT (centroid/midpoint, normal, length) against the
// rebuilt body's candidates — and reject the match when nothing is plausibly
// "the same" anymore, so a lost reference surfaces as a fixable error instead
// of silently dressing/extruding the wrong face.
//
// This module is pure math over plain data (no OCCT), so it runs under vitest
// in Node; the worker extracts candidates from the B-rep and feeds it.

export type Vec3 = [number, number, number];

/** What a feature stored about a face when it was picked. */
export interface FaceRefFingerprint {
  center: Vec3;
  /** Unit normal at pick time — absent for non-planar faces / legacy refs. */
  normal?: Vec3;
}

/** A face of the rebuilt body, offered as a match candidate. */
export interface FaceCandidate {
  center: Vec3;
  /** Unit normal — only for planar faces. */
  normal?: Vec3;
}

/** What a dress-up stored about an edge when it was picked. */
export interface EdgeRefFingerprint {
  /** The persistent name at pick time (matched first, before geometry). */
  name: string;
  /** Bounding-box centre of the edge (robust for closed edges like circles,
   *  where the endpoint average degenerates to the seam point). */
  mid?: Vec3;
  length?: number;
}

/** An edge of the rebuilt body, offered as a match candidate. */
export interface EdgeCandidate {
  /** Current persistent name (unnamed edges can still match geometrically). */
  name?: string;
  mid: Vec3;
  length: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Strip the `#n` collision suffixes a name picks up when a boolean/dress-up
 *  splits a face ("id/side0#1∩id/start" → "id/side0∩id/start"). Suffixes are
 *  assigned in OCCT iteration order, which is NOT stable across edits — the
 *  base name is the meaningful part. */
export const stripNameSuffixes = (name: string) => name.replace(/#\d+/g, "");

// How far (as a fraction of the body's characteristic size) a face centroid may
// move before we refuse to call it "the same face". Generous on purpose: a
// legitimate parameter edit slides faces around; a lost reference usually lands
// on a face MUCH farther away (or on nothing plausible at all).
const FACE_DIST_REJECT = 0.5;
// Penalty terms weight; normals disagree → strong pushback but not an outright
// reject (a face can tilt with an at-angle plane edit and still be "the" face).
const FACE_NORMAL_WEIGHT = 0.5;
// A planar reference matching a non-planar candidate (or vice versa) is
// suspicious but possible (a fillet can round what was planar).
const FACE_TYPE_PENALTY = 0.25;

/** Find the candidate face best matching a stored fingerprint, or null when
 *  nothing is plausibly the same face. `scale` is the body's characteristic
 *  size (bounding-box diagonal); distances are judged relative to it. */
export function matchFace(
  ref: FaceRefFingerprint,
  candidates: readonly FaceCandidate[],
  scale: number,
): { index: number; score: number } | null {
  const s = Math.max(scale, 1);
  let best: { index: number; score: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const distScore = len(sub(c.center, ref.center)) / s;
    if (distScore > FACE_DIST_REJECT) continue;
    let score = distScore;
    if (ref.normal && c.normal) {
      // |dot| — a face's normal orientation can flip through a boolean.
      score += FACE_NORMAL_WEIGHT * (1 - Math.abs(dot(ref.normal, c.normal)));
    } else if (ref.normal !== undefined || c.normal !== undefined) {
      score += FACE_TYPE_PENALTY;
    }
    if (!best || score < best.score) best = { index: i, score };
  }
  return best;
}

// Edge thresholds are tighter than faces: an edge is a small feature, and a
// wrong geometric match dresses the wrong rim — reject sooner.
const EDGE_DIST_REJECT = 0.35;
const EDGE_LENGTH_WEIGHT = 0.5;
const EDGE_LENGTH_REJECT = 0.5; // |Δlen| / max(len) beyond this → not the same edge

export type EdgeMatch =
  | { kind: "name"; index: number } // exact persistent-name hit
  | { kind: "base"; index: number } // unique match after stripping #n suffixes
  | { kind: "geom"; index: number } // geometric fingerprint match
  | { kind: "lost" }; // nothing plausible — surface to the user

/** Re-resolve a set of stored edge references against the rebuilt body's
 *  edges. Three passes, each consuming candidates one-to-one:
 *  1. exact persistent-name match;
 *  2. unique base-name match (both sides stripped of `#n` suffixes);
 *  3. geometric match (midpoint + length), best-score-first so two refs can't
 *     fight over one candidate.
 *  Returns one EdgeMatch per ref, in order. */
export function matchEdges(
  refs: readonly EdgeRefFingerprint[],
  candidates: readonly EdgeCandidate[],
  scale: number,
): EdgeMatch[] {
  const s = Math.max(scale, 1);
  const result: EdgeMatch[] = new Array(refs.length).fill(null as unknown as EdgeMatch);
  const taken = new Set<number>();

  // Pass 1: exact names.
  for (let r = 0; r < refs.length; r++) {
    const i = candidates.findIndex((c, ci) => !taken.has(ci) && c.name === refs[r].name);
    if (i >= 0) {
      result[r] = { kind: "name", index: i };
      taken.add(i);
    }
  }

  // Pass 2: base names, only when unambiguous (exactly one unused candidate
  // shares the base — with several, the suffix order isn't meaningful and
  // geometry decides instead).
  for (let r = 0; r < refs.length; r++) {
    if (result[r]) continue;
    const base = stripNameSuffixes(refs[r].name);
    const hits: number[] = [];
    for (let ci = 0; ci < candidates.length; ci++) {
      if (taken.has(ci)) continue;
      const cn = candidates[ci].name;
      if (cn && stripNameSuffixes(cn) === base) hits.push(ci);
    }
    if (hits.length === 1) {
      result[r] = { kind: "base", index: hits[0] };
      taken.add(hits[0]);
    }
  }

  // Pass 3: geometry. Collect every plausible (ref, candidate) pair, then
  // assign globally best-first so the closest pairing wins.
  const pairs: { r: number; ci: number; score: number }[] = [];
  for (let r = 0; r < refs.length; r++) {
    if (result[r]) continue;
    const ref = refs[r];
    if (!ref.mid) continue; // legacy ref with no fingerprint — nothing to match on
    for (let ci = 0; ci < candidates.length; ci++) {
      if (taken.has(ci)) continue;
      const c = candidates[ci];
      const distScore = len(sub(c.mid, ref.mid)) / s;
      if (distScore > EDGE_DIST_REJECT) continue;
      let score = distScore;
      if (ref.length !== undefined) {
        const denom = Math.max(ref.length, c.length, 1);
        const lenScore = Math.abs(ref.length - c.length) / denom;
        if (lenScore > EDGE_LENGTH_REJECT) continue;
        score += EDGE_LENGTH_WEIGHT * lenScore;
      }
      pairs.push({ r, ci, score });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  for (const p of pairs) {
    if (result[p.r] || taken.has(p.ci)) continue;
    result[p.r] = { kind: "geom", index: p.ci };
    taken.add(p.ci);
  }

  for (let r = 0; r < refs.length; r++) if (!result[r]) result[r] = { kind: "lost" };
  return result;
}
