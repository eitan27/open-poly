import { describe, it, expect } from "vitest";
import type { Selection } from "../selection/types";
import type { FaceRef } from "./types";
import { shellBodyFromSelection, toggleShellFace, retargetShell, NO_SHELL_FACES } from "./shellTarget";

const bodies = new Set(["box", "cyl"]);
const ref = (name: string): FaceRef => ({ name, center: [0, 0, 0], normal: [0, 0, 1] });

describe("shellBodyFromSelection — a pick anywhere on a body arms the body", () => {
  it("a face pick arms its OWNING BODY, not the face", () => {
    // The whole point of the change: clicking a face is the default way to
    // touch anything in the viewport, so Shell must not read that as "open
    // this face".
    const sel: Selection[] = [{ kind: "face", featureId: "box", faceId: 3 }];
    expect(shellBodyFromSelection(sel, bodies)).toBe("box");
  });

  it("a whole-body pick arms that body", () => {
    expect(shellBodyFromSelection([{ kind: "feature", id: "box" }], bodies)).toBe("box");
  });

  it("edge and vertex picks arm the body too", () => {
    const edge: Selection[] = [{ kind: "edge", featureId: "cyl", edgeId: 1 }];
    const vertex: Selection[] = [{ kind: "vertex", featureId: "cyl", point: [1, 2, 3] }];
    expect(shellBodyFromSelection(edge, bodies)).toBe("cyl");
    expect(shellBodyFromSelection(vertex, bodies)).toBe("cyl");
  });

  it("several faces of the SAME body still arm just that one body", () => {
    const sel: Selection[] = [
      { kind: "face", featureId: "box", faceId: 1 },
      { kind: "face", featureId: "box", faceId: 2 },
      { kind: "face", featureId: "box", faceId: 5 },
    ];
    expect(shellBodyFromSelection(sel, bodies)).toBe("box");
  });

  it("a mixed face + body pick on one body is not ambiguous", () => {
    const sel: Selection[] = [
      { kind: "feature", id: "box" },
      { kind: "face", featureId: "box", faceId: 2 },
    ];
    expect(shellBodyFromSelection(sel, bodies)).toBe("box");
  });
});

describe("shellBodyFromSelection — when there is no single body", () => {
  it("an empty selection arms nothing", () => {
    expect(shellBodyFromSelection([], bodies)).toBeNull();
  });

  it("two different bodies is ambiguous, not a guess", () => {
    const sel: Selection[] = [
      { kind: "face", featureId: "box", faceId: 1 },
      { kind: "face", featureId: "cyl", faceId: 4 },
    ];
    expect(shellBodyFromSelection(sel, bodies)).toBeNull();
  });

  it("a pick on something that isn't a rendered body arms nothing", () => {
    // e.g. a sketch or a suppressed feature: present in the selection, absent
    // from the rendered-body set.
    const sketch: Selection[] = [{ kind: "feature", id: "sketch1" }];
    const ghost: Selection[] = [{ kind: "face", featureId: "ghost", faceId: 0 }];
    expect(shellBodyFromSelection(sketch, bodies)).toBeNull();
    expect(shellBodyFromSelection(ghost, bodies)).toBeNull();
  });

  it("sketch picks contribute nothing, and don't rescue an otherwise empty pick", () => {
    const sel: Selection[] = [
      { kind: "sketchFace", sketchId: "sketch1", regionId: "r0" },
      { kind: "sketchEntity", sketchId: "sketch1", entityId: "e0" },
      { kind: "sketchPoint", sketchId: "sketch1", point: [0, 0] },
    ];
    expect(shellBodyFromSelection(sel, bodies)).toBeNull();
  });

  it("a sketch pick alongside one body still arms that body", () => {
    const sel: Selection[] = [
      { kind: "sketchFace", sketchId: "sketch1", regionId: "r0" },
      { kind: "face", featureId: "box", faceId: 1 },
    ];
    expect(shellBodyFromSelection(sel, bodies)).toBe("box");
  });
});

describe("toggleShellFace — the optional faces-to-open list", () => {
  it("arms a face, keeping names and fingerprints in lockstep", () => {
    const r = toggleShellFace(NO_SHELL_FACES, "top", ref("top"));
    expect(r.faces).toEqual(["top"]);
    expect(r.faceRefs).toEqual([ref("top")]);
  });

  it("accumulates several faces in pick order", () => {
    let s = toggleShellFace(NO_SHELL_FACES, "top", ref("top"));
    s = toggleShellFace(s, "front", ref("front"));
    s = toggleShellFace(s, "side#1", ref("side#1"));
    expect(s.faces).toEqual(["top", "front", "side#1"]);
    expect(s.faceRefs.map((f) => f.name)).toEqual(["top", "front", "side#1"]);
  });

  it("clicking an armed face again un-arms it, dropping BOTH array entries", () => {
    let s = toggleShellFace(NO_SHELL_FACES, "top", ref("top"));
    s = toggleShellFace(s, "front", ref("front"));
    s = toggleShellFace(s, "top", ref("top"));
    expect(s.faces).toEqual(["front"]);
    expect(s.faceRefs).toEqual([ref("front")]);
  });

  it("un-arming the middle of the list keeps the rest aligned", () => {
    let s = NO_SHELL_FACES;
    for (const n of ["a", "b", "c"]) s = toggleShellFace(s, n, ref(n));
    s = toggleShellFace(s, "b", ref("b"));
    expect(s.faces).toEqual(["a", "c"]);
    expect(s.faceRefs.map((f) => f.name)).toEqual(["a", "c"]);
  });

  it("does not mutate the state it was given", () => {
    const before: typeof NO_SHELL_FACES = { faces: ["top"], faceRefs: [ref("top")] };
    toggleShellFace(before, "front", ref("front"));
    expect(before.faces).toEqual(["top"]);
    expect(before.faceRefs).toHaveLength(1);
  });

  it("empty is the starting state — a sealed hollow shell with no opening", () => {
    expect(NO_SHELL_FACES).toEqual({ faces: [], faceRefs: [] });
  });
});

describe("retargetShell — re-picking the body", () => {
  it("switching to a different body drops faces that belonged to the old one", () => {
    const current = { targetId: "box", faces: ["top"], faceRefs: [ref("top")] };
    expect(retargetShell(current, "cyl")).toEqual({ targetId: "cyl", faces: [], faceRefs: [] });
  });

  it("re-picking the SAME body keeps the armed faces", () => {
    const current = { targetId: "box", faces: ["top", "front"], faceRefs: [ref("top"), ref("front")] };
    expect(retargetShell(current, "box")).toEqual(current);
  });

  it("arming the first body from an empty dialog starts with no faces", () => {
    expect(retargetShell({ targetId: null, ...NO_SHELL_FACES }, "box")).toEqual({
      targetId: "box",
      faces: [],
      faceRefs: [],
    });
  });
});
