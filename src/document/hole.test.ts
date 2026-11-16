import { describe, it, expect } from "vitest";
import { addHole, createDocument, resolveDocument, updateParam } from "./document";
import {
  DEFAULT_HOLE_SETTINGS,
  countersinkDepth,
  defaultHolePoints,
  entityHolePoint,
  holeCenters,
  holePlacement,
  holeScope,
  holePointAt,
  snapPoint,
  holeDims,
  holeProfile,
  tipDepth,
  type HoleSettings,
} from "./hole";
import type { Document, HoleFeature, SketchFeature } from "./types";

const settings = (patch: Partial<HoleSettings> = {}, params: Partial<HoleSettings["params"]> = {}): HoleSettings => ({
  ...DEFAULT_HOLE_SETTINGS,
  ...patch,
  params: { ...DEFAULT_HOLE_SETTINGS.params, ...params },
});

describe("holeDims", () => {
  it("takes a metric clearance hole from the ISO 273 table by fit", () => {
    expect(holeDims(settings({ size: "M3", fit: "close" }), {}).diameter).toBe(3.2);
    expect(holeDims(settings({ size: "M3", fit: "normal" }), {}).diameter).toBe(3.4);
    expect(holeDims(settings({ size: "M3", fit: "loose" }), {}).diameter).toBe(3.6);
  });

  it("drills the tap drill for a tapped hole, and reports the thread", () => {
    const d = holeDims(
      settings({ holeType: "tapped", size: "M6", extent: "blind" }, { depth: "12", threadDepth: "10" }),
      {},
    );
    expect(d).toMatchObject({ diameter: 5, threadDiameter: 6, pitch: 1, threadDepth: 10 });
  });

  it("ignores a metric hole's typed diameters, and reads a custom hole's (with variables)", () => {
    expect(holeDims(settings({ size: "M4" }, { diameter: "99" }), {}).diameter).toBe(4.5);
    expect(holeDims(settings({ size: "custom" }, { diameter: "d + 1" }), { d: 4 }).diameter).toBe(5);
  });

  it("drops the drill point on a through hole", () => {
    expect(holeDims(settings({ extent: "throughAll" }, { tipAngle: "118" }), {}).tipAngle).toBe(0);
  });

  it("refuses shapes that aren't a hole", () => {
    const bad: [Partial<HoleSettings>, Partial<HoleSettings["params"]>, RegExp][] = [
      [{ size: "custom" }, { diameter: "0" }, /diameter/],
      [{ extent: "blind" }, { depth: "0" }, /depth/],
      [{ holeType: "counterbore", size: "custom" }, { diameter: "8", counterboreDiameter: "6" }, /wider/],
      [{ holeType: "counterbore", extent: "blind", size: "M3" }, { depth: "2" }, /shallower/],
      [{ holeType: "tapped", extent: "blind" }, { depth: "5", threadDepth: "6" }, /deeper/],
      [{ extent: "blind" }, { tipAngle: "180" }, /tip angle/],
    ];
    for (const [patch, params, msg] of bad) expect(() => holeDims(settings(patch, params), {})).toThrow(msg);
  });
});

describe("holeProfile", () => {
  it("a blind simple hole: wall, then a drill point on the axis", () => {
    const d = holeDims(
      settings({ size: "custom", extent: "blind" }, { diameter: "6", depth: "10", tipAngle: "90" }),
      {},
    );
    expect(tipDepth(d)).toBeCloseTo(3);
    expect(holeProfile(d)).toEqual([
      [3, 0],
      [3, 10],
      [0, 13],
    ]);
  });

  it("a flat-bottomed blind hole ends square on the axis", () => {
    const d = holeDims(
      settings({ size: "custom", extent: "blind" }, { diameter: "6", depth: "10", tipAngle: "0" }),
      {},
    );
    expect(holeProfile(d).at(-1)).toEqual([0, 10]);
  });

  it("a counterbore steps in at its depth", () => {
    const d = holeDims(
      settings({ holeType: "counterbore", size: "M3", extent: "blind" }, { depth: "10", tipAngle: "0" }),
      {},
    );
    expect(holeProfile(d)).toEqual([
      [3, 0],
      [3, 3.4],
      [1.7, 3.4],
      [1.7, 10],
      [0, 10],
    ]);
  });

  it("a 90° countersink runs in at 45° to the bore", () => {
    const d = holeDims(
      settings(
        { holeType: "countersink", size: "custom", extent: "blind" },
        { diameter: "4", countersinkDiameter: "8", countersinkAngle: "90", depth: "10", tipAngle: "0" },
      ),
      {},
    );
    expect(countersinkDepth(d)).toBeCloseTo(2);
    expect(holeProfile(d)[1][1]).toBeCloseTo(2);
  });

  it("through all: the bore never ends above the head feature, so depth stays monotonic", () => {
    const d = holeDims(settings({ holeType: "counterbore", size: "M6", extent: "throughAll" }), {});
    const prof = holeProfile(d, 0);
    for (let i = 1; i < prof.length; i++) expect(prof[i][1]).toBeGreaterThanOrEqual(prof[i - 1][1]);
    expect(prof.at(-1)).toEqual([0, 6.4]);
  });
});

describe("holeCenters + resolve", () => {
  const sketch = (entities: SketchFeature["entities"]): SketchFeature => ({
    id: "s",
    type: "sketch",
    name: "Sketch",
    suppressed: false,
    plane: { kind: "datum", id: "plane-top" },
    entities,
    constraints: [],
  });

  it("uses points and circle centres, once each", () => {
    const s = sketch([
      { type: "point", id: "a", p: [1, 2] },
      { type: "circle", id: "b", c: [5, 5], r: 1 },
      { type: "point", id: "c", p: [5, 5] },
      { type: "line", id: "d", a: [0, 0], b: [9, 9] },
    ]);
    expect(holeCenters(s)).toEqual([
      [1, 2],
      [5, 5],
    ]);
  });

  it("resolves to a hole on the sketch's plane, and errors usefully", () => {
    const base: Document = { ...createDocument() };
    const withSketch: Document = {
      ...base,
      features: [...base.features, sketch([{ type: "point", id: "a", p: [1, 2] }])],
    };
    const { doc, id } = addHole(withSketch, "s", "body", settings());
    const rf = resolveDocument(doc).features.find((f) => f.id === id);
    expect(rf).toMatchObject({ type: "hole", targets: ["body"], centers: [[1, 2]], throughAll: true });
    // No body: every part the holes reach.
    const noTarget = addHole(withSketch, "s", undefined, settings());
    expect(resolveDocument(noTarget.doc).errors[noTarget.id]).toBeUndefined();
    expect(resolveDocument(noTarget.doc).features.find((f) => f.id === noTarget.id)).toMatchObject({
      type: "hole",
      targets: undefined,
    });
    const empty: Document = { ...base, features: [...base.features, sketch([])] };
    const e = addHole(empty, "s", "body", settings());
    expect(resolveDocument(e.doc).errors[e.id]).toMatch(/no points/);
  });

  it("params are editable through updateParam", () => {
    const { doc, id } = addHole(createDocument(), "s", "b", settings());
    expect((updateParam(doc, id, "depth", "7").features.at(-1) as HoleFeature).params.depth).toBe("7");
  });
});

describe("modelled tapped thread", () => {
  it("cuts a real thread for a metric tapped hole, its drill no wider than the grown minor diameter", () => {
    const d = holeDims(settings({ holeType: "tapped", size: "M8", thread: "modelled" }, { clearance: "0" }), {});
    expect(d.modelledThread).toBe(true);
    // M8 tap drill is 6.8; the basic minor diameter is 8 − 1.0825·1.25 ≈ 6.647.
    expect(d.diameter).toBeCloseTo(6.647, 3);
    const grown = holeDims(settings({ holeType: "tapped", size: "M8", thread: "modelled" }, { clearance: "0.1" }), {});
    expect(grown.diameter).toBe(6.8);
  });

  it("stays cosmetic for a custom size or an old hole", () => {
    expect(holeDims(settings({ holeType: "tapped", size: "custom", thread: "modelled" }), {}).modelledThread).toBe(
      false,
    );
    expect(holeDims(settings({ holeType: "tapped", size: "M4", thread: undefined }), {}).modelledThread).toBe(false);
  });

  it("resolves with the cavity's thread, starting above the mouth", () => {
    const base: Document = { ...createDocument() };
    const withSketch: Document = {
      ...base,
      features: [
        ...base.features,
        {
          id: "s",
          type: "sketch",
          name: "Sketch",
          suppressed: false,
          plane: { kind: "datum", id: "plane-top" },
          entities: [{ type: "point", id: "a", p: [0, 0] }],
          constraints: [],
        } as SketchFeature,
      ],
    };
    const { doc, id } = addHole(
      withSketch,
      "s",
      "body",
      settings({ holeType: "tapped", size: "M5", thread: "modelled" }),
    );
    const rf = resolveDocument(doc).features.find((f) => f.id === id);
    expect(rf).toMatchObject({ thread: { d: 5, pitch: 0.8, offset: 0.1, tipChamfer: false } });
    expect((rf as { thread: { z0: number } }).thread.z0).toBeLessThan(0);
  });
});

describe("hole points", () => {
  const sk: SketchFeature = {
    id: "s",
    type: "sketch",
    name: "Sketch 1",
    suppressed: false,
    plane: { kind: "datum", datumId: "top" },
    entities: [
      { type: "point", id: "p", p: [1, 2] },
      { type: "line", id: "l", a: [0, 0], b: [10, 0] },
      { type: "circle", id: "c", c: [5, 5], r: 2 },
      { type: "arc", id: "a", c: [0, 10], r: 3, start: 0, end: Math.PI / 2 },
    ],
    constraints: [],
  } as unknown as SketchFeature;
  const ent = (id: string) => sk.entities.find((e) => e.id === id)!;

  it("finds each entity's snap points, and none it doesn't have", () => {
    expect(snapPoint(ent("l"), "mid")).toEqual([5, 0]);
    expect(snapPoint(ent("l"), "end")).toEqual([10, 0]);
    expect(snapPoint(ent("c"), "center")).toEqual([5, 5]);
    const arcEnd = snapPoint(ent("a"), "end")!;
    expect(arcEnd[0]).toBeCloseTo(0);
    expect(arcEnd[1]).toBeCloseTo(13);
    expect(snapPoint(ent("c"), "start")).toBeNull();
    expect(snapPoint(ent("p"), "mid")).toBeNull();
  });

  it("reads a click on a whole entity as its centre, midpoint or itself", () => {
    expect(entityHolePoint(ent("l"))).toEqual({ entityId: "l", at: "mid" });
    expect(entityHolePoint(ent("a"))).toEqual({ entityId: "a", at: "center" });
    expect(entityHolePoint(ent("p"))).toEqual({ entityId: "p", at: "point" });
  });

  it("names the snap point at a picked vertex", () => {
    expect(holePointAt(sk, [10, 0])).toEqual({ sketchId: "s", entityId: "l", at: "end" });
    expect(holePointAt(sk, [5, 5])).toEqual({ sketchId: "s", entityId: "c", at: "center" });
    expect(holePointAt(sk, [3, 3])).toBeNull();
  });

  it("places holes at the picked points — or, with none given, every point and circle centre", () => {
    expect(holeCenters(sk, [{ entityId: "l", at: "mid" }])).toEqual([[5, 0]]);
    expect(holeCenters(sk)).toEqual([
      [1, 2],
      [5, 5],
    ]);
    expect(defaultHolePoints(sk)).toEqual([
      { entityId: "p", at: "point" },
      { entityId: "c", at: "center" },
    ]);
  });

  it("follows the sketch: a moved line moves its midpoint hole", () => {
    const moved = {
      ...sk,
      entities: sk.entities.map((e) => (e.id === "l" ? { ...e, b: [20, 0] } : e)),
    } as SketchFeature;
    expect(holeCenters(moved, [{ entityId: "l", at: "mid" }])).toEqual([[10, 0]]);
  });

  it("says so when a picked entity is gone", () => {
    expect(() => holeCenters(sk, [{ entityId: "gone", at: "point" }])).toThrow(/gone from the sketch/);
  });
});

describe("holePlacement", () => {
  const face = {
    kind: "face" as const,
    featureId: "box",
    frame: {
      origin: [0, 0, 15] as [number, number, number],
      uAxis: [1, 0, 0] as [number, number, number],
      vAxis: [0, 1, 0] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
    },
  };
  // A sketch on the Top datum (z = 0), below the face.
  const top = {
    id: "t",
    type: "sketch",
    name: "Sketch 1",
    suppressed: false,
    plane: { kind: "datum", id: "plane-top" },
    entities: [{ type: "line", id: "l", a: [0, 0], b: [10, 0] }],
    constraints: [],
  } as unknown as SketchFeature;
  const hole = (patch: Partial<HoleFeature>): HoleFeature =>
    ({ id: "h", type: "hole", name: "Hole 1", suppressed: false, ...settings(), ...patch }) as HoleFeature;
  const sketchOf = (id: string) => (id === "t" ? top : undefined);

  it("places fixed spots on its plane", () => {
    const p = holePlacement(hole({ plane: face, points: [{ uv: [3, 4] }, { uv: [3, 4] }] }), sketchOf, new Map());
    expect(p.frame.origin).toEqual([0, 0, 15]);
    expect(p.centers).toEqual([[3, 4]]); // coincident spots count once
  });

  it("carries another sketch's point onto its plane, and follows it", () => {
    const ref = { sketchId: "t", entityId: "l", at: "mid" as const };
    expect(holePlacement(hole({ plane: face, points: [ref] }), sketchOf, new Map()).centers).toEqual([[5, 0]]);
  });

  it("asks for a location before it has one", () => {
    expect(() => holePlacement(hole({ points: [] }), sketchOf, new Map())).toThrow(/select where/);
  });

  it("cuts its picked parts, an older hole's one body, or everything it reaches", () => {
    expect(holeScope(hole({ scope: ["a", "b"] }))).toEqual(["a", "b"]);
    expect(holeScope(hole({ sketchId: "t", targetId: "x" }))).toEqual(["x"]);
    expect(holeScope(hole({ plane: face }))).toBeUndefined();
  });
});
