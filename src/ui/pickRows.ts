// The row lists that accumulating pick slots show, as pure functions.
//
// Chamfer/Fillet and Extrude both display "what have I picked so far", grouped by
// the body (or sketch) each pick came from and numbered within that group per kind
// — "Edge 1, Face 1, Edge 2", restarting on the next group. Each had its own copy
// of that rule, one inline in a 153-line JSX block and one in a `useMemo`, and
// neither was tested, because nothing reachable only from a JSX tail is.
//
// It is all pure string and count arithmetic, so it lives here, once.

/** "1 edge", "3 edges". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface DressUpRow {
  /** "Edge 2", or a stored target's own finished label. */
  label: string;
  onRemove: () => void;
}

export interface PickGroup {
  /** What the rows are grouped by — a body or sketch id. */
  key: string;
  /** That id's display name, resolved by the caller. */
  label: string;
  items: DressUpRow[];
}

/** One row to place. `kind` is the noun it is numbered under ("Edge", "Region");
 *  an `exact` entry keeps `kind` as its whole label and takes no part in the
 *  numbering, which is how a stored target shows its counts instead of a tally. */
export interface PickRowSpec {
  key: string;
  label: string;
  kind: string;
  exact?: boolean;
  onRemove: () => void;
}

/** Group rows by `key`, in first-seen order, numbering each within its group and
 *  its kind. The one rule both accumulating dialogs follow. */
export function groupPickRows(specs: PickRowSpec[]): PickGroup[] {
  const groups: PickGroup[] = [];
  // Per group, per kind. Both copies of this rule used to count rows whose LABEL
  // started with the kind noun, which is a different thing and quietly wrong at
  // the edges: an exact row is not supposed to be counted at all, and "Edges"
  // starts with "Edge". Neither case was reachable from the labels those dialogs
  // actually produce, so it never bit — counting explicitly means it cannot.
  const tallies = new Map<PickGroup, Map<string, number>>();
  for (const spec of specs) {
    let g = groups.find((x) => x.key === spec.key);
    if (!g) {
      groups.push((g = { key: spec.key, label: spec.label, items: [] }));
      tallies.set(g, new Map());
    }
    if (spec.exact) {
      g.items.push({ label: spec.kind, onRemove: spec.onRemove });
      continue;
    }
    const tally = tallies.get(g)!;
    const n = (tally.get(spec.kind) ?? 0) + 1;
    tally.set(spec.kind, n);
    g.items.push({ label: `${spec.kind} ${n}`, onRemove: spec.onRemove });
  }
  return groups;
}

/** A stored target: what the feature being edited already dresses. One row for
 *  the whole thing, because it is a list of names rather than a sequence of
 *  clicks — there is nothing finer to remove. */
export interface StoredTargetRow {
  targetId: string;
  edges: number;
  faces: number;
  onRemove: () => void;
}

/** A live pick: one click, which may stand for a whole tangent chain. */
export interface PickRow {
  /** Null when the pick resolved to no body — it still takes a row, so the user
   *  can see and remove it, but it groups under the empty id like it always did. */
  bodyId: string | null;
  kind: "edge" | "face";
  onRemove: () => void;
}

/** The Chamfer/Fillet row list: stored targets first, each labelled with its own
 *  counts, then the live picks numbered per body and kind.
 *
 *  `bodyLabel` resolves an id to a display name; it needs the document, which is
 *  why it is passed in rather than looked up here. */
export function buildDressUpGroups(
  stored: StoredTargetRow[],
  picks: PickRow[],
  bodyLabel: (bodyId: string) => string,
): PickGroup[] {
  return groupPickRows([
    ...stored.map((t): PickRowSpec => {
      const counts = [t.edges ? plural(t.edges, "edge") : null, t.faces ? plural(t.faces, "face") : null].filter(
        Boolean,
      );
      return {
        key: t.targetId,
        label: bodyLabel(t.targetId),
        kind: counts.join(" + ") || "Nothing",
        exact: true,
        onRemove: t.onRemove,
      };
    }),
    ...picks.map((p): PickRowSpec => ({
      key: p.bodyId ?? "",
      label: bodyLabel(p.bodyId ?? ""),
      kind: p.kind === "edge" ? "Edge" : "Face",
      onRemove: p.onRemove,
    })),
  ]);
}

/** What the picks actually RESOLVE to, which is the interesting number: one click
 *  on a faceted rim stands for its whole tangent chain, so three picks can be
 *  ninety-odd edges. Zeros are left out — "0 edges + 1 face" says nothing the rows
 *  don't. Null when there is nothing to report. */
export function dressUpCountLabel(targets: { edges: unknown[]; faces: unknown[] }[]): string | null {
  const e = targets.reduce((n, x) => n + x.edges.length, 0);
  const f = targets.reduce((n, x) => n + x.faces.length, 0);
  return [e ? plural(e, "edge") : null, f ? plural(f, "face") : null].filter(Boolean).join(" + ") || null;
}
