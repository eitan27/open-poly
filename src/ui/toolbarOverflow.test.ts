import { describe, expect, it } from "vitest";
import {
  fitCount,
  matchScore,
  nextEnabledIndex,
  searchRows,
  toRows,
  type ToolbarItem,
  type ToolbarRow,
} from "./toolbarOverflow";

const noop = () => {};

function items(): ToolbarItem[] {
  return [
    { id: "sketch", icon: "✎", label: "Sketch", shortcut: "S", title: "Start a sketch", onSelect: noop },
    {
      id: "body",
      icon: "◧",
      label: "Body",
      shortcut: "N",
      title: "New body",
      keywords: ["primitive"],
      onSelect: noop,
      choices: [
        { id: "box", label: "Box", onSelect: noop },
        { id: "cylinder", label: "Cylinder", onSelect: noop },
      ],
    },
    { id: "extrude", icon: "⬆", label: "Extrude", shortcut: "E", title: "Extrude", disabled: true, onSelect: noop },
    {
      id: "chamfer",
      icon: "◣",
      label: "Chamfer",
      shortcut: "C",
      title: "Chamfer",
      keywords: ["bevel"],
      onSelect: noop,
    },
  ];
}

function row(label: string, keywords: string[] = [], disabled = false): ToolbarRow {
  return { id: label, itemId: label, icon: "", label, title: label, disabled, keywords, onSelect: noop };
}

describe("fitCount", () => {
  it("keeps every button when they fit beside the always-present More button", () => {
    // More (60) + 3 × (4 gap + 50) = 222
    expect(fitCount([50, 50, 50], 4, 222, 60)).toBe(3);
  });

  it("reserves room for the More button even when the buttons alone would fit", () => {
    // 158 would hold all three buttons on their own (3×50 + 2×4), but More is
    // always on the bar, so only one 50px button fits beside it.
    expect(fitCount([50, 50, 50], 4, 158, 60)).toBe(1);
  });

  it("reserves room for the More button once anything overflows", () => {
    // 157 available: More (60 + gap) is reserved and only one 50px button fits
    // alongside it (60 + 4 + 50 = 114).
    expect(fitCount([50, 50, 50], 4, 157, 60)).toBe(1);
    // A narrower More button buys back room for a second real button.
    expect(fitCount([50, 50, 50], 4, 157, 40)).toBe(2);
  });

  it("hides everything when even one button cannot share the row with More", () => {
    expect(fitCount([50, 50], 4, 80, 60)).toBe(0);
  });

  it("tolerates sub-pixel measurement error", () => {
    // 60 More + 2 × (4 + 50.2) = 168.4, just over the 168.3 available.
    expect(fitCount([50.2, 50.2], 4, 168.3, 60)).toBe(2);
  });

  it("handles an empty toolbar", () => {
    expect(fitCount([], 4, 100, 60)).toBe(0);
  });
});

describe("toRows", () => {
  it("flattens dropdown choices into one searchable row each", () => {
    const rows = toRows(items());
    expect(rows.map((r) => r.label)).toEqual(["Sketch", "Body ▸ Box", "Body ▸ Cylinder", "Extrude", "Chamfer"]);
    // Choice rows keep the parent item's identity so the flyout knows whether
    // the button they came from is currently hidden.
    expect(rows[1].itemId).toBe("body");
    expect(rows[1].id).toBe("body/box");
  });

  it("propagates the parent's disabled state to its choices", () => {
    const disabledParent: ToolbarItem[] = [
      {
        id: "body",
        icon: "◧",
        label: "Body",
        title: "New body",
        disabled: true,
        onSelect: noop,
        choices: [{ id: "box", label: "Box", onSelect: noop }],
      },
    ];
    expect(toRows(disabledParent)[0].disabled).toBe(true);
  });
});

describe("matchScore", () => {
  it("ranks a label prefix above a word match above a bare substring", () => {
    expect(matchScore(row("Extrude"), "ex")).toBe(0);
    expect(matchScore(row("Body ▸ Cylinder"), "cyl")).toBe(1);
    expect(matchScore(row("Chamfer"), "amf")).toBe(2);
  });

  it("matches keywords below label text", () => {
    const chamfer = row("Chamfer", ["bevel"]);
    expect(matchScore(chamfer, "bev")).toBe(3);
    expect(matchScore(row("Boolean", ["subtract"]), "btrac")).toBe(4);
  });

  it("falls back to a subsequence so abbreviations still hit", () => {
    expect(matchScore(row("Fillet"), "flt")).toBe(5);
  });

  it("rejects a non-match", () => {
    expect(matchScore(row("Fillet"), "zq")).toBeNull();
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(matchScore(row("Revolve"), "  REV ")).toBe(0);
  });
});

describe("searchRows", () => {
  const rows = toRows(items());

  it("returns everything, in order, for an empty query", () => {
    expect(searchRows(rows, "  ")).toEqual(rows);
  });

  it("orders best match first and keeps toolbar order within a tier", () => {
    const hits = searchRows(rows, "b");
    // "Body ▸ Box"/"Body ▸ Cylinder" start with b; "Chamfer" only via bevel.
    expect(hits.map((r) => r.label)).toEqual(["Body ▸ Box", "Body ▸ Cylinder", "Chamfer"]);
  });

  it("drops non-matching rows", () => {
    expect(searchRows(rows, "cylinder").map((r) => r.label)).toEqual(["Body ▸ Cylinder"]);
  });

  it("keeps disabled tools in the results (they're discoverable, just not usable)", () => {
    expect(searchRows(rows, "extrude").map((r) => r.disabled)).toEqual([true]);
  });
});

describe("nextEnabledIndex", () => {
  const rows = [row("a"), row("b", [], true), row("c")];

  it("skips disabled rows going down and wraps at the end", () => {
    expect(nextEnabledIndex(rows, 0, 1)).toBe(2);
    expect(nextEnabledIndex(rows, 2, 1)).toBe(0);
  });

  it("skips disabled rows going up and wraps at the start", () => {
    expect(nextEnabledIndex(rows, 2, -1)).toBe(0);
    expect(nextEnabledIndex(rows, 0, -1)).toBe(2);
  });

  it("starts at the first/last enabled row when nothing is active", () => {
    expect(nextEnabledIndex(rows, -1, 1)).toBe(0);
    expect(nextEnabledIndex(rows, -1, -1)).toBe(2);
  });

  it("returns -1 when nothing is selectable", () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
    expect(nextEnabledIndex([row("a", [], true)], -1, 1)).toBe(-1);
  });
});
