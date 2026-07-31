import { describe, expect, it } from "vitest";
import { expandPickToChains, expandToChains, expansionCount } from "./edgeChains";

// A body with two rims and some plain edges. Chain representatives are arbitrary
// but stable — here each rim's own first segment.
//   rim A: 10,11,12,13   (chain 10)
//   rim B: 20,21,22      (chain 20)
//   singletons: 30, 31   (a box's straight edges — absent from the map)
const chains = new Map<number, number>([
  [10, 10], [11, 10], [12, 10], [13, 10],
  [20, 20], [21, 20], [22, 20],
]);

describe("expandToChains", () => {
  it("pulls in the whole rim from one of its segments", () => {
    expect([...expandToChains([11], chains)].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("is the fix for the half-chamfer: a partial rim becomes the whole rim", () => {
    // A document saved when the wall had fewer facets names only some of them.
    expect([...expandToChains([10, 11], chains)].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("is idempotent — a complete rim expands to itself", () => {
    const once = expandToChains([10, 11, 12, 13], chains);
    expect([...expandToChains(once, chains)].sort((a, b) => a - b)).toEqual([...once].sort((a, b) => a - b));
  });

  it("leaves a straight edge alone (its own singleton, absent from the map)", () => {
    expect([...expandToChains([30], chains)]).toEqual([30]);
  });

  it("keeps an unrecognised edge rather than dropping it", () => {
    // Silently dressing nothing would be worse than dressing just that edge.
    expect(expandToChains([999], chains).has(999)).toBe(true);
  });

  it("handles several chains and singletons together, without cross-contamination", () => {
    const out = expandToChains([12, 21, 31], chains);
    expect([...out].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 20, 21, 22, 31]);
  });

  it("does NOT merge separate rims", () => {
    const out = expandToChains([11], chains);
    expect(out.has(20)).toBe(false);
    expect(out.has(21)).toBe(false);
  });

  it("returns nothing for no hits", () => {
    expect(expandToChains([], chains).size).toBe(0);
  });
});

describe("expansionCount", () => {
  it("reports how many edges were added", () => {
    expect(expansionCount([10, 11], expandToChains([10, 11], chains))).toBe(2);
  });
  it("is zero when nothing was added", () => {
    expect(expansionCount([30], expandToChains([30], chains))).toBe(0);
    const full = [10, 11, 12, 13];
    expect(expansionCount(full, expandToChains(full, chains))).toBe(0);
  });
});

describe("expandPickToChains", () => {
  // A faceted rim: 4 chords in one chain, plus two unrelated singleton edges.
  const rim = [
    { edgeId: 10, chainId: 7 },
    { edgeId: 11, chainId: 7 },
    { edgeId: 12, chainId: 7 },
    { edgeId: 13, chainId: 7 },
    { edgeId: 20 },
    { edgeId: 21 },
  ];

  it("pulls in the whole chain from one picked chord", () => {
    expect(expandPickToChains(rim, [11]).sort()).toEqual([10, 11, 12, 13]);
  });

  it("keeps the picked edge first, so callers can still anchor on it", () => {
    expect(expandPickToChains(rim, [12])[0]).toBe(12);
  });

  it("leaves a singleton edge alone — a box edge is not a rim", () => {
    expect(expandPickToChains(rim, [20])).toEqual([20]);
  });

  it("de-duplicates when several chords of the same chain are picked", () => {
    expect(expandPickToChains(rim, [10, 12]).sort()).toEqual([10, 11, 12, 13]);
  });

  it("mixes a chain and a singleton without cross-contamination", () => {
    expect(expandPickToChains(rim, [10, 21]).sort()).toEqual([10, 11, 12, 13, 21]);
  });

  it("passes through an edge the mesh has no group for", () => {
    expect(expandPickToChains(rim, [99])).toEqual([99]);
  });

  it("is a no-op on an empty pick", () => {
    expect(expandPickToChains(rim, [])).toEqual([]);
  });
});
