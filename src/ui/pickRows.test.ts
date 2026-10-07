import { describe, expect, it } from "vitest";
import {
  buildDressUpGroups,
  dressUpCountLabel,
  groupPickRows,
  plural,
  type PickRow,
  type PickRowSpec,
  type StoredTargetRow,
} from "./pickRows";

const noop = () => {};
const pick = (bodyId: string | null, kind: "edge" | "face"): PickRow => ({ bodyId, kind, onRemove: noop });
const stored = (targetId: string, edges: number, faces: number): StoredTargetRow => ({
  targetId,
  edges,
  faces,
  onRemove: noop,
});
const names = (id: string) => ({ b1: "Box 1", b2: "Box 2" })[id] ?? id;
const labels = (gs: ReturnType<typeof buildDressUpGroups>) => gs.map((g) => [g.label, ...g.items.map((i) => i.label)]);

describe("plural", () => {
  it("only pluralises away from one", () => {
    expect(plural(1, "edge")).toBe("1 edge");
    expect(plural(0, "edge")).toBe("0 edges");
    expect(plural(3, "face")).toBe("3 faces");
  });
});

describe("groupPickRows", () => {
  const spec = (key: string, kind: string, exact = false): PickRowSpec => ({
    key,
    label: names(key),
    kind,
    exact,
    onRemove: noop,
  });

  it("keeps groups in first-seen order, not key order", () => {
    const gs = groupPickRows([spec("b2", "Face"), spec("b1", "Face")]);
    expect(gs.map((g) => g.key)).toEqual(["b2", "b1"]);
  });

  it("numbers within a group and within a kind", () => {
    const gs = groupPickRows([spec("b1", "Region"), spec("b1", "Text"), spec("b1", "Region")]);
    expect(gs[0].items.map((i) => i.label)).toEqual(["Region 1", "Text 1", "Region 2"]);
  });

  // An exact row keeps its kind as the whole label, and — the part that matters —
  // must not be counted when the numbered rows beside it are tallied.
  it("leaves an exact row out of the numbering", () => {
    const gs = groupPickRows([spec("b1", "Edge 7", true), spec("b1", "Edge")]);
    expect(gs[0].items.map((i) => i.label)).toEqual(["Edge 7", "Edge 1"]);
  });

  it("takes the group label from the first row that opened it", () => {
    const gs = groupPickRows([
      { ...spec("b1", "Face"), label: "First" },
      { ...spec("b1", "Face"), label: "Second" },
    ]);
    expect(gs[0].label).toBe("First");
  });
});

describe("buildDressUpGroups", () => {
  it("numbers picks within their own body AND their own kind", () => {
    const gs = buildDressUpGroups([], [pick("b1", "edge"), pick("b1", "face"), pick("b1", "edge")], names);
    expect(labels(gs)).toEqual([["Box 1", "Edge 1", "Face 1", "Edge 2"]]);
  });

  it("restarts numbering on the next body, in first-seen order", () => {
    const gs = buildDressUpGroups([], [pick("b2", "edge"), pick("b1", "edge"), pick("b2", "edge")], names);
    expect(labels(gs)).toEqual([
      ["Box 2", "Edge 1", "Edge 2"],
      ["Box 1", "Edge 1"],
    ]);
  });

  // A stored target stands for a whole list of names, not one click, so it gets
  // its counts as an exact label and must not be counted as an "Edge n".
  it("gives a stored target its counts, and excludes it from pick numbering", () => {
    const gs = buildDressUpGroups([stored("b1", 12, 2)], [pick("b1", "edge")], names);
    expect(labels(gs)).toEqual([["Box 1", "12 edges + 2 faces", "Edge 1"]]);
  });

  it("omits a zero side of a stored target's counts", () => {
    expect(labels(buildDressUpGroups([stored("b1", 4, 0)], [], names))).toEqual([["Box 1", "4 edges"]]);
    expect(labels(buildDressUpGroups([stored("b1", 0, 1)], [], names))).toEqual([["Box 1", "1 face"]]);
  });

  it("says Nothing rather than an empty label when a stored target has neither", () => {
    expect(labels(buildDressUpGroups([stored("b1", 0, 0)], [], names))).toEqual([["Box 1", "Nothing"]]);
  });

  it("still gives an unresolved pick a row, grouped under the empty id", () => {
    const gs = buildDressUpGroups([], [pick(null, "edge")], names);
    expect(gs).toHaveLength(1);
    expect(gs[0].key).toBe("");
    expect(gs[0].items.map((i) => i.label)).toEqual(["Edge 1"]);
  });

  it("keeps each row's own remover", () => {
    const seen: string[] = [];
    const gs = buildDressUpGroups(
      [{ targetId: "b1", edges: 1, faces: 0, onRemove: () => seen.push("stored") }],
      [{ bodyId: "b1", kind: "edge", onRemove: () => seen.push("pick") }],
      names,
    );
    gs[0].items.forEach((i) => i.onRemove());
    expect(seen).toEqual(["stored", "pick"]);
  });
});

describe("dressUpCountLabel", () => {
  const t = (edges: number, faces: number) => ({ edges: Array(edges).fill(0), faces: Array(faces).fill(0) });

  it("sums across every target", () => {
    expect(dressUpCountLabel([t(2, 0), t(3, 1)])).toBe("5 edges + 1 face");
  });

  it("drops a side that is zero", () => {
    expect(dressUpCountLabel([t(90, 0)])).toBe("90 edges");
  });

  it("is null when there is nothing to report", () => {
    expect(dressUpCountLabel([])).toBeNull();
    expect(dressUpCountLabel([t(0, 0)])).toBeNull();
  });
});
