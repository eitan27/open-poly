import { describe, it, expect } from "vitest";
import { PLANES, type PlaneFrameData } from "./planes";
import { resolveSectionPlane, sectionKeeps } from "./sectionView";

describe("resolveSectionPlane", () => {
  it("shifts the origin along the frame's own normal by `offset`, unflipped", () => {
    // Front datum: origin (0,0,0), normal +Y.
    const r = resolveSectionPlane(PLANES["plane-front"], 5, false);
    expect(r.origin).toEqual([0, 5, 0]);
    expect(r.normal).toEqual([0, 1, 0]);
  });

  it("flip negates the effective normal but does NOT move the origin", () => {
    const r = resolveSectionPlane(PLANES["plane-front"], 5, true);
    expect(r.origin).toEqual([0, 5, 0]); // same shifted origin as unflipped
    // toBeCloseTo (not toEqual) — negating +0 yields -0, which toEqual treats
    // as distinct from 0.
    r.normal.forEach((c, i) => expect(c).toBeCloseTo([0, -1, 0][i], 9));
  });

  it("a negative offset shifts backward along the normal", () => {
    const r = resolveSectionPlane(PLANES["plane-top"], -8, false); // Top: normal +Z
    expect(r.origin).toEqual([0, 0, -8]);
  });

  it("normalizes a non-unit frame normal before applying the offset", () => {
    const frame: PlaneFrameData = { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 1, 0], normal: [0, 0, 2] };
    const r = resolveSectionPlane(frame, 3, false);
    expect(r.origin).toEqual([0, 0, 3]); // normalized to unit length first, not [0,0,6]
    expect(r.normal).toEqual([0, 0, 1]);
  });
});

describe("sectionKeeps", () => {
  it("keeps everything when there's no plane (section view off)", () => {
    expect(sectionKeeps(null, [-1000, -1000, -1000])).toBe(true);
    expect(sectionKeeps(null, [1000, 1000, 1000])).toBe(true);
  });

  it("keeps points on the normal side, rejects points on the far side", () => {
    const plane = resolveSectionPlane(PLANES["plane-front"], 0, false); // origin (0,0,0), normal +Y
    expect(sectionKeeps(plane, [0, 5, 0])).toBe(true);
    expect(sectionKeeps(plane, [0, -5, 0])).toBe(false);
  });

  it("a point exactly on the plane counts as kept (matches the GPU clip boundary)", () => {
    const plane = resolveSectionPlane(PLANES["plane-front"], 0, false);
    expect(sectionKeeps(plane, [3, 0, -7])).toBe(true);
  });

  it("flip swaps which side is kept for the SAME point", () => {
    const point: [number, number, number] = [0, 5, 0];
    const kept = resolveSectionPlane(PLANES["plane-front"], 0, false);
    const flipped = resolveSectionPlane(PLANES["plane-front"], 0, true);
    expect(sectionKeeps(kept, point)).toBe(true);
    expect(sectionKeeps(flipped, point)).toBe(false);
  });

  it("respects the offset, not just the plane's original position", () => {
    const plane = resolveSectionPlane(PLANES["plane-front"], 10, false); // kept region now y >= 10
    expect(sectionKeeps(plane, [0, 12, 0])).toBe(true);
    expect(sectionKeeps(plane, [0, 8, 0])).toBe(false); // was kept at offset 0, not anymore
  });
});

// Regression coverage for BACKLOG.md's "picking must respect the clip" gotcha
// and the sketch-on-an-interior-face workflow (see
// scripts/verify-section-view-sketch.mjs for the full end-to-end version):
// this is the exact plane/point math clip-aware picking runs on every click.
describe("sectionKeeps — interior-face picking scenario", () => {
  // A 40x40x20 box (x,y ∈ [-20,20], z ∈ [0,20]) with a pocket cut into its
  // +X face, floor at x=8. Section view on the Front datum (y=0, unflipped)
  // keeps y >= 0 — the setup scripts/verify-section-view-sketch.mjs drives
  // for real through the browser.
  const plane = resolveSectionPlane(PLANES["plane-front"], 0, false);

  it("the pocket floor point exposed by the cut is pickable", () => {
    expect(sectionKeeps(plane, [8, 8, 8])).toBe(true);
  });

  it("the same floor extended to the clipped-away half is not pickable", () => {
    expect(sectionKeeps(plane, [8, -8, 8])).toBe(false);
  });
});
