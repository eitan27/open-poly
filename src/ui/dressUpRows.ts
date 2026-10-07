// The Chamfer/Fillet dialog's row list, as pure functions.
//
// This was the densest logic inline in App.tsx's JSX — nine closures ahead of the
// markup, building a grouped, per-kind-numbered list out of two different sources.
// None of it was tested, because nothing in a JSX tail can be. It is all pure
// string and count arithmetic, so it lives here instead.

/** "1 edge", "3 edges". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export interface DressUpRow {
  /** "Edge 2", or a stored target's own finished label. */
  label: string;
  onRemove: () => void;
}

export interface DressUpGroup {
  bodyId: string;
  /** The body's display name, resolved by the caller. */
  bodyLabel: string;
  items: DressUpRow[];
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

/** Group the dialog's rows by the body they dress, which is how they commit — one
 *  dress-up feature each.
 *
 *  Numbering is per body AND per kind, so the rows read the way they were picked:
 *  the second edge on a body is "Edge 2" even if a face was picked between them,
 *  and the first edge on the next body is "Edge 1" again. Stored targets come
 *  first and carry their own exact label, so they never take part in numbering.
 *
 *  `bodyLabel` resolves an id to a display name; it needs the document, which is
 *  why it is passed in rather than looked up here. */
export function buildDressUpGroups(
  stored: StoredTargetRow[],
  picks: PickRow[],
  bodyLabel: (bodyId: string) => string,
): DressUpGroup[] {
  const groups: DressUpGroup[] = [];
  const groupFor = (bodyId: string) => {
    let g = groups.find((x) => x.bodyId === bodyId);
    if (!g) groups.push((g = { bodyId, bodyLabel: bodyLabel(bodyId), items: [] }));
    return g;
  };

  for (const t of stored) {
    const counts = [t.edges ? plural(t.edges, "edge") : null, t.faces ? plural(t.faces, "face") : null].filter(Boolean);
    groupFor(t.targetId).items.push({ label: counts.join(" + ") || "Nothing", onRemove: t.onRemove });
  }
  for (const p of picks) {
    const g = groupFor(p.bodyId ?? "");
    const kind = p.kind === "edge" ? "Edge" : "Face";
    const n = g.items.filter((q) => q.label.startsWith(kind)).length + 1;
    g.items.push({ label: `${kind} ${n}`, onRemove: p.onRemove });
  }
  return groups;
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
