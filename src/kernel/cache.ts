// Content-hashing for the regen caches (builderCache/meshCache/dressUpCache in
// worker.ts). Pulled out because it is genuinely dependency-free — unlike almost
// everything else in worker.ts, none of this touches OCCT or getOC(), so it is
// the one slice of the kernel that can be isolated without dragging the wasm in,
// and the only one Vitest can exercise in Node at all.

import type { ResolvedFeature } from "./types";

/** cyrb53 — a fast, well-distributed 53-bit string hash. Used to keep content
 *  keys short and bounded (combining keys down a long feature chain would grow
 *  without a hash). Collisions are astronomically unlikely at our scale. */
export function hashKey(str: string): string {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A pure builder's content key: just its resolved feature (no body inputs). */
export const builderKey = (feature: ResolvedFeature) => hashKey(JSON.stringify(feature));

/** A derived body's content key: its feature plus the keys of the bodies it read.
 *
 *  `inputKeys` is the whole dependency set, not just the obvious target: a
 *  transform whose axis is a body EDGE folds that body's key in too, so moving
 *  the edge's own body re-runs the transform instead of serving a stale one. Get
 *  that set wrong and the bug is invisible — a correct-looking key that misses a
 *  real input just returns yesterday's body. */
export const contentKey = (feature: ResolvedFeature, inputKeys: string[]) =>
  hashKey(JSON.stringify(feature) + "|" + inputKeys.join("|"));
