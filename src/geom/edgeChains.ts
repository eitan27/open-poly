// Expanding a stored edge selection to the whole smooth curve it names.
//
// A faceted round wall's rim is not one circle to the kernel — it is N tiny
// straight segments, like a dotted line. Clicking it selects the whole ring
// (that's what the chain grouping is for), but the feature is SAVED as the literal
// list of segment names. So the saved list is a lossy encoding of "the rim": it
// records the segments the rim happened to have when you clicked.
//
// Change how finely walls are faceted and that list silently means something else.
// A rim stored as 48 segment names, on a wall now cut into 96, still resolves —
// every one of those names exists — but it is only half the rim. The result is
// half a chamfer, with no error and no warning: measured on a real document, 194
// faces on reopen where a fresh build gives 290.
//
// So the list is treated as a set of REPRESENTATIVES rather than an inventory:
// each named segment pulls in the whole tangent-continuous chain it belongs to.
// "Chamfer this rim" then means the rim, however many pieces it is cut into. This
// is pure set arithmetic over the chain grouping, kept here so it can be tested
// without the kernel.

/** Every edge sharing a tangent-continuous chain with any of `hits`.
 *
 *  `chainOf` maps an edge to a representative for its chain (what the kernel's
 *  edgeChainsFrom produces); an edge missing from it is its own singleton, which
 *  is the common case — a box's rim, a straight joint — and passes through
 *  unchanged. `hits` are always included even when the map has nothing for them,
 *  so an unrecognised edge is still dressed rather than silently dropped. */
export function expandToChains(hits: Iterable<number>, chainOf: ReadonlyMap<number, number>): Set<number> {
  const wanted = new Set<number>();
  // Group once rather than rescanning the map per hit: dressing a 96-chord ring on
  // an imported body with thousands of edges would otherwise be quadratic.
  let members: Map<number, number[]> | null = null;
  for (const h of hits) {
    wanted.add(h);
    const chain = chainOf.get(h);
    if (chain === undefined) continue;
    if (!members) {
      members = new Map();
      for (const [edge, rep] of chainOf) {
        const arr = members.get(rep);
        if (arr) arr.push(edge); else members.set(rep, [edge]);
      }
    }
    for (const edge of members.get(chain) ?? []) wanted.add(edge);
  }
  return wanted;
}

/** How many edges an expansion added — for reporting that a saved selection
 *  covered only part of its chain, which is worth surfacing rather than fixing
 *  silently. */
export function expansionCount(hits: Iterable<number>, expanded: ReadonlySet<number>): number {
  let n = 0;
  for (const _ of hits) n++;
  return Math.max(0, expanded.size - n);
}
