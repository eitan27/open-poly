import { describe, it, expect } from "vitest";
import {
  buildGuides,
  guidesForPoint,
  guideIntersection,
  projectOntoGuide,
  snapToGuides,
  type Guide,
} from "./inference";
import type { Vec2 } from "../document/types";

// Sketch uv already reads as "screen px" for the tests, so the projector is the
// identity and tolerances are in uv units.
const idPx = (uv: Vec2): Vec2 => uv;

describe("guidesForPoint", () => {
  it("emits horizontal + vertical for a bare point", () => {
    const g = guidesForPoint([2, 3]);
    expect(g.map((x) => x.meaning).sort()).toEqual(["horizontal", "vertical"]);
    expect(g.every((x) => x.origin[0] === 2 && x.origin[1] === 3)).toBe(true);
  });

  it("adds parallel + perpendicular (unit dirs) for a point on a line", () => {
    const g = guidesForPoint([0, 0], [2, 0], "L1"); // horizontal line dir
    const par = g.find((x) => x.meaning === "parallel")!;
    const per = g.find((x) => x.meaning === "perpendicular")!;
    expect(par.dir).toEqual([1, 0]);
    expect(Math.hypot(...per.dir)).toBeCloseTo(1);
    expect(Math.abs(per.dir[0])).toBeCloseTo(0); // perpendicular to horizontal → vertical
    expect(par.refId).toBe("L1");
    expect(per.refId).toBe("L1");
  });
});

describe("projectOntoGuide", () => {
  it("drops the cursor onto a horizontal guide", () => {
    const g: Guide = { origin: [0, 5], dir: [1, 0], meaning: "horizontal" };
    expect(projectOntoGuide([3, 9], g)).toEqual([3, 5]);
  });
  it("drops the cursor onto a 45° guide", () => {
    const g: Guide = { origin: [0, 0], dir: [Math.SQRT1_2, Math.SQRT1_2], meaning: "parallel" };
    const q = projectOntoGuide([2, 0], g);
    expect(q[0]).toBeCloseTo(1);
    expect(q[1]).toBeCloseTo(1);
  });
});

describe("guideIntersection", () => {
  it("intersects a horizontal and a vertical guide", () => {
    const h: Guide = { origin: [0, 4], dir: [1, 0], meaning: "horizontal" };
    const v: Guide = { origin: [7, 0], dir: [0, 1], meaning: "vertical" };
    expect(guideIntersection(h, v)).toEqual([7, 4]);
  });
  it("returns null for parallel guides", () => {
    const a: Guide = { origin: [0, 0], dir: [1, 0], meaning: "horizontal" };
    const b: Guide = { origin: [0, 3], dir: [1, 0], meaning: "horizontal" };
    expect(guideIntersection(a, b)).toBeNull();
  });
});

describe("snapToGuides", () => {
  it("snaps a near-horizontal cursor onto a point's horizontal guide (and captures it)", () => {
    const guides = guidesForPoint([0, 10]); // H at y=10, V at x=0
    // Cursor near the horizontal line, far from the vertical one.
    const snap = snapToGuides([50, 12], guides, idPx, 5);
    expect(snap).not.toBeNull();
    expect(snap!.uv[1]).toBe(10); // dropped onto y=10
    expect(snap!.meanings).toEqual([{ meaning: "horizontal", refId: undefined }]);
  });

  it("returns null when the cursor is out of tolerance", () => {
    const guides = guidesForPoint([0, 10]);
    expect(snapToGuides([50, 30], guides, idPx, 5)).toBeNull();
  });

  it("snaps to the INTERSECTION of two points' guides and reports both meanings", () => {
    // Point A at (0,10) gives a horizontal guide y=10; point B at (30,0) gives a
    // vertical guide x=30. Their intersection is (30,10).
    const guides = [...guidesForPoint([0, 10]), ...guidesForPoint([30, 0])];
    const snap = snapToGuides([31, 11], guides, idPx, 5);
    expect(snap!.uv[0]).toBeCloseTo(30);
    expect(snap!.uv[1]).toBeCloseTo(10);
    const kinds = snap!.meanings.map((m) => m.meaning).sort();
    expect(kinds).toEqual(["horizontal", "vertical"]);
  });

  it("prefers an intersection over a single nearby guide", () => {
    const guides = [...guidesForPoint([0, 10]), ...guidesForPoint([30, 0])];
    // Slightly closer to the horizontal line alone, but the intersection is still
    // within tolerance → intersection wins.
    const snap = snapToGuides([29, 10.5], guides, idPx, 6);
    expect(snap!.uv[0]).toBeCloseTo(30);
    expect(snap!.uv[1]).toBeCloseTo(10);
    expect(snap!.meanings.length).toBe(2);
  });

  it("angle-snaps the drawn segment parallel to an armed line", () => {
    // Draft start at origin; an armed 45° line direction. A cursor near the 45°
    // ray from the start snaps onto it → the segment is parallel to that line.
    const guides = buildGuides({ points: [], draftStart: [0, 0], armedDirs: [{ dir: [1, 1], refId: "L7" }] });
    const snap = snapToGuides([10, 9], guides, idPx, 3);
    expect(snap!.uv[0]).toBeCloseTo(snap!.uv[1]); // on the y=x ray
    expect(snap!.meanings).toContainEqual({ meaning: "parallel", refId: "L7" });
  });

  it("angle-snaps perpendicular to an armed line", () => {
    // Armed horizontal line → the perpendicular guide through the start is vertical.
    const guides = buildGuides({ points: [], draftStart: [5, 0], armedDirs: [{ dir: [1, 0], refId: "L1" }] });
    const snap = snapToGuides([5.5, 20], guides, idPx, 3);
    expect(snap!.uv[0]).toBeCloseTo(5); // dropped onto x=5 (vertical)
    expect(snap!.meanings.some((m) => m.meaning === "perpendicular" && m.refId === "L1")).toBe(true);
  });

  it("folds a coincident third guide's meaning into an intersection", () => {
    // Draft start at origin with an armed horizontal line: emits its own H guide
    // (meaning 'horizontal') AND a parallel guide along the same [1,0] dir
    // (meaning 'parallel', ref L1) — both are the x-axis. A hovered point at
    // (20,0)'s vertical guide crosses them at (20,0). The snap should report the
    // vertical plus BOTH horizontal-ish meanings on that line, deduped.
    const guides = buildGuides({
      points: [{ p: [20, 30] }],
      draftStart: [0, 0],
      armedDirs: [{ dir: [1, 0], refId: "L1" }],
    });
    const snap = snapToGuides([20.5, 0.5], guides, idPx, 3);
    expect(snap!.uv[0]).toBeCloseTo(20);
    expect(snap!.uv[1]).toBeCloseTo(0);
    const kinds = snap!.meanings.map((m) => m.meaning);
    expect(kinds).toContain("vertical");
    expect(kinds).toContain("parallel"); // from the armed line
    expect(kinds).toContain("horizontal"); // the draft-start's own H guide
  });
});
