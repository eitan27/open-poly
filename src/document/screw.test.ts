import { describe, it, expect } from "vitest";
import {
  addHole,
  addScrew,
  createDocument,
  deletePart,
  removeFeature,
  resolveDocument,
  updateParam,
  updateScrew,
} from "./document";
import { DEFAULT_HOLE_SETTINGS, type HoleSettings } from "./hole";
import { DEFAULT_SCREW_SETTINGS, screwDims, screwProfile, screwSize, type ScrewSettings } from "./screw";
import type { SketchPlaneRef } from "./planes";
import type { Document, ScrewFeature, SketchFeature } from "./types";

const TOP = { kind: "datum", id: "plane-top" } as const;
const screw = (patch: Partial<ScrewSettings> = {}, params: Partial<ScrewSettings["params"]> = {}): ScrewSettings => ({
  ...DEFAULT_SCREW_SETTINGS,
  ...patch,
  params: { ...DEFAULT_SCREW_SETTINGS.params, ...params },
});
type V3 = [number, number, number];
type Frame = { origin: V3; uAxis: V3; vAxis: V3; normal: V3 };
type Seated = { frame: Frame; frames?: Frame[]; centers: [number, number][]; profile: [number, number][] };
/** Where each screw of a resolved screw feature sits, rounded. */
const origins = (rf: Seated) =>
  (rf.frames ?? [rf.frame]).map((f, i) => {
    expect(rf.centers[i]).toEqual([0, 0]);
    return f.origin.map((x) => Math.round(x * 1e6) / 1e6 + 0);
  });
const hole = (patch: Partial<HoleSettings> = {}): HoleSettings => ({
  ...DEFAULT_HOLE_SETTINGS,
  ...patch,
  params: { ...DEFAULT_HOLE_SETTINGS.params },
});

const withPoints = (): Document => {
  const base = createDocument();
  const sketch: SketchFeature = {
    id: "s",
    type: "sketch",
    name: "Sketch",
    suppressed: false,
    plane: TOP,
    entities: [
      { type: "point", id: "a", p: [0, 0] },
      { type: "point", id: "b", p: [20, 0] },
    ],
    constraints: [],
  };
  return { ...base, features: [...base.features, sketch] };
};

describe("screwDims", () => {
  it("takes head dimensions from the ISO tables", () => {
    expect(screwDims("socket", "M3", 10)).toMatchObject({ d: 3, headDiameter: 5.5, headHeight: 3, key: 2.5 });
    expect(screwDims("hex", "M6", 20)).toMatchObject({ headDiameter: 10, headHeight: 4, key: 0 });
    const flat = screwDims("flat", "M4", 10);
    expect(flat.headHeight).toBe(0);
    expect(flat.coneDepth).toBeCloseTo((flat.headDiameter - 4) / 2);
  });

  it("rejects silly lengths and unknown sizes", () => {
    expect(() => screwDims("socket", "M3", 0)).toThrow(/length/);
    expect(() => screwDims("flat", "M10", 3)).toThrow(/longer than its head/);
    expect(() => screwDims("socket", "M7", 10)).toThrow(/unknown size/);
  });

  it("profiles from the head top on the axis to the tip on the axis", () => {
    for (const head of ["socket", "button", "flat", "hex"] as const) {
      const d = screwDims(head, "M5", 16);
      const p = screwProfile(d);
      expect(p[0][0]).toBe(0);
      expect(p.at(-1)).toEqual([0, 16]);
      // Never wider than the head, never past the length.
      for (const [r, z] of p) {
        expect(r).toBeLessThanOrEqual(d.headDiameter / 2 + 1e-9);
        expect(z).toBeLessThanOrEqual(16 + 1e-9);
      }
    }
  });
});

describe("resolve", () => {
  it("puts one screw at every hole, the hole's size, seated on a counterbore floor", () => {
    const h = addHole(withPoints(), "s", "body", hole({ holeType: "counterbore", size: "M5" }));
    const { doc, id } = addScrew(h.doc, screw({ size: "M3", holeId: h.id }));
    const f = doc.features.find((x) => x.id === id) as ScrewFeature;
    expect(screwSize(doc, f)).toBe("M5");
    // A metric hole decides the size: the screw keeps none of its own.
    expect(f.size).toBeUndefined();
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as Seated;
    // Each screw at its own seat: the hole's centre, M5's counterbore depth
    // (DIN 974-1: 5.4) down, pointing out of the hole.
    expect(origins(rf)).toEqual([
      [0, 0, -5.4],
      [20, 0, -5.4],
    ]);
    expect(rf.frame.normal).toEqual([0, 0, 1]);
    expect(rf.profile[0][1]).toBeCloseTo(-5); // the head's top, its height above the seat
  });

  it("in a hole whose targets span planes, each screw takes its hole's frame", () => {
    const FRONT = { kind: "datum", id: "plane-front" } as const;
    const h = addHole(
      createDocument(),
      undefined,
      undefined,
      hole({
        points: [
          { uv: [1, 2], plane: TOP },
          { uv: [3, 4], plane: FRONT },
        ],
      }),
    );
    const { doc, id } = addScrew(h.doc, screw({ holeId: h.id }));
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as Seated;
    expect(origins(rf)).toEqual([
      [1, 2, 0],
      [3, 0, 4],
    ]);
    expect(rf.frames![0].normal).not.toEqual(rf.frames![1].normal);
  });

  it("with no location, one screw at the Top plane's origin", () => {
    const { doc, id } = addScrew(createDocument(), screw());
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as Seated;
    expect(origins(rf)).toEqual([[0, 0, 0]]);
    expect(doc.features.at(-1)).not.toHaveProperty("points");
  });

  it("at picked spots: a fixed spot on a face, and a sketch point it follows — each into its own plane", () => {
    const FACE: SketchPlaneRef = {
      kind: "face",
      featureId: "body",
      frame: { origin: [0, -15, 7], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] },
    };
    const { doc, id } = addScrew(
      withPoints(),
      screw({
        points: [
          { uv: [3, -2], plane: FACE },
          { sketchId: "s", entityId: "b", at: "point" },
        ],
      }),
    );
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as Seated;
    expect(origins(rf)).toEqual([
      [3, -15, 5],
      [20, 0, 0],
    ]);
    // Head on the face, shank going in: the side face's seat points out of
    // it (−y); the sketch point's, out of its Top-plane sketch (+z).
    expect(rf.frames!.map((f) => f.normal)).toEqual([
      [0, -1, 0],
      [0, 0, 1],
    ]);
    const moved = {
      ...doc,
      features: doc.features.map((f) =>
        f.id === "s" && f.type === "sketch"
          ? { ...f, entities: f.entities.map((e) => (e.id === "b" && e.type === "point" ? { ...e, p: [30, 5] } : e)) }
          : f,
      ),
    } as Document;
    expect(origins(resolveDocument(moved).features.find((x) => x.id === id) as Seated)[1]).toEqual([30, 5, 0]);
  });

  it("Flip turns a face spot over: head inside, shank out", () => {
    const FACE: SketchPlaneRef = {
      kind: "face",
      featureId: "body",
      frame: { origin: [0, -15, 7], uAxis: [1, 0, 0], vAxis: [0, 0, 1], normal: [0, -1, 0] },
    };
    const { doc, id } = addScrew(createDocument(), screw({ points: [{ uv: [3, -2], plane: FACE }] }));
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as Seated;
    expect(origins(rf)).toEqual([[3, -15, 5]]);
    // Head outside, shank going in (+y): the seat points out, along −y.
    expect(rf.frame.normal).toEqual([0, -1, 0]);
    const flipped = resolveDocument(
      updateScrew(doc, id, { ...screw({ points: [{ uv: [3, -2], plane: FACE }] }), flip: true }),
    );
    expect((flipped.features.find((x) => x.id === id) as Seated).frame.normal.map((x) => x + 0)).toEqual([0, 1, 0]);
  });

  it("in a hole and at spots together; Flip turns the spots, a hole's own flip its screws", () => {
    const h = addHole(withPoints(), "s", "body", hole({ flip: true }));
    const { doc, id } = addScrew(h.doc, screw({ holeId: h.id, points: [{ uv: [50, 0], plane: TOP }] }));
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as Seated;
    expect(origins(rf)).toEqual([
      [0, 0, 0],
      [20, 0, 0],
      [50, 0, 0],
    ]);
    // The hole drills up (flipped): its screws point up, out of it downward.
    expect(rf.frames!.map((f) => f.normal[2])).toEqual([-1, -1, 1]);
    const flipped = resolveDocument(
      updateScrew(doc, id, { ...screw({ holeId: h.id, points: [{ uv: [50, 0], plane: TOP }] }), flip: true }),
    );
    expect((flipped.features.find((x) => x.id === id) as Seated).frames!.map((f) => f.normal[2])).toEqual([1, 1, -1]);
  });

  it("deleting its Hole leaves every screw where it was, with the size it had", () => {
    const h = addHole(withPoints(), "s", "body", hole({ holeType: "counterbore", size: "M5", flip: true }));
    const { doc, id } = addScrew(h.doc, screw({ holeId: h.id, points: [{ uv: [50, 0], plane: TOP }] }));
    const before = resolveDocument(doc).features.find((x) => x.id === id) as Seated;
    const gone = removeFeature(doc, h.id);
    const f = gone.features.find((x) => x.id === id) as ScrewFeature;
    expect(f.holeId).toBeUndefined();
    expect(f.size).toBe("M5");
    expect(f.points).toHaveLength(3);
    const r = resolveDocument(gone);
    expect(r.errors[id]).toBeUndefined();
    const after = r.features.find((x) => x.id === id) as Seated;
    expect(origins(after)).toEqual(origins(before));
    expect(after.frames!.map((x) => x.normal)).toEqual(before.frames!.map((x) => x.normal));
    expect(after.profile).toEqual(before.profile);
  });

  it("errors when its hole is gone without being deleted, and recovers when moved", () => {
    const h = addHole(withPoints(), "s", "body", hole());
    const { doc, id } = addScrew(h.doc, screw({ holeId: h.id }));
    const gone: Document = { ...doc, features: doc.features.filter((x) => x.id !== h.id) };
    expect(resolveDocument(gone).errors[id]).toMatch(/hole no longer exists/);
    const moved = updateScrew(gone, id, screw());
    expect((moved.features.find((x) => x.id === id) as ScrewFeature).holeId).toBeUndefined();
    expect(resolveDocument(moved).errors[id]).toBeUndefined();
  });

  it("leaves out the holes it's told to skip, and refuses to place none", () => {
    const h = addHole(withPoints(), "s", "body", hole());
    const { doc, id } = addScrew(h.doc, screw({ holeId: h.id, skipHoles: [0], points: [{ uv: [50, 0], plane: TOP }] }));
    expect(origins(resolveDocument(doc).features.find((x) => x.id === id) as Seated)).toEqual([
      [20, 0, 0],
      [50, 0, 0],
    ]);
    const none = updateScrew(doc, id, screw({ holeId: h.id, skipHoles: [0, 1] }));
    expect(resolveDocument(none).errors[id]).toMatch(/every screw is removed/);
    // Not in a hole: nothing to skip, nothing saved.
    const loose = updateScrew(doc, id, screw({ skipHoles: [1] }));
    expect(loose.features.find((x) => x.id === id)).not.toHaveProperty("skipHoles");
  });

  it("Delete part: a step of its own, gathering the parts deleted in a row", () => {
    const { doc, id } = addScrew(
      createDocument(),
      screw({ points: [0, 10, 20].map((x) => ({ uv: [x, 0] as [number, number], plane: TOP })) }),
    );
    const one = deletePart(doc, `${id}#1`);
    const two = deletePart(one.doc, `${id}#2`);
    expect(two.id).toBe(one.id);
    const del = two.doc.features.at(-1)!;
    expect(del).toMatchObject({ type: "deletePart", name: "Delete part 1", partIds: [`${id}#1`, `${id}#2`] });
    // The screw itself is untouched.
    expect(two.doc.features.find((x) => x.id === id)).toEqual(doc.features.find((x) => x.id === id));
    expect(resolveDocument(two.doc).features.at(-1)).toEqual({
      id: del.id,
      type: "deletePart",
      partIds: [`${id}#1`, `${id}#2`],
    });
    // Bringing one back.
    const back = updateParam(two.doc, del.id, "restore", `${id}#1`);
    expect((back.features.at(-1) as { partIds: string[] }).partIds).toEqual([`${id}#2`]);
  });

  it("length is editable through updateParam", () => {
    const { doc, id } = addScrew(createDocument(), screw());
    expect((updateParam(doc, id, "length", "30").features.at(-1) as ScrewFeature).params.length).toBe("30");
  });
});

describe("modelled thread", () => {
  it("cosmetic is the default", () => {
    expect(DEFAULT_SCREW_SETTINGS.thread).toBe("cosmetic");
  });

  it("modelled: the profile stops at the head and a thread runs from the seat to the tip", () => {
    const { doc, id } = addScrew(createDocument(), screw({ size: "M5", thread: "modelled" }, { length: "16" }));
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as {
      profile: [number, number][];
      thread?: { d: number; pitch: number; offset: number; z0: number; z1: number; tipChamfer: boolean };
    };
    expect(rf.thread).toMatchObject({ d: 5, pitch: 0.8, offset: -0.1, z1: 16, tipChamfer: true });
    // Starts at the seat, where it is stitched onto the head's underside.
    expect(rf.thread!.z0).toBe(0);
    expect(rf.profile.at(-1)).toEqual([0, 0]);
  });

  it("a countersunk head's thread starts at the bottom of its cone", () => {
    const { doc, id } = addScrew(createDocument(), screw({ head: "flat", size: "M4", thread: "modelled" }));
    const rf = resolveDocument(doc).features.find((x) => x.id === id) as { thread?: { z0: number } };
    const cone = screwDims("flat", "M4", 12).coneDepth;
    expect(rf.thread!.z0).toBe(cone);
  });

  it("a screw from before modelled threads (no `thread`) stays cosmetic", () => {
    const { doc, id } = addScrew(createDocument(), screw());
    const old: Document = {
      ...doc,
      features: doc.features.map((f) => (f.id === id ? { ...f, thread: undefined } : f)),
    };
    const rf = resolveDocument(old).features.find((x) => x.id === id) as { thread?: unknown; profile: number[][] };
    expect(rf.thread).toBeUndefined();
    expect(rf.profile.at(-1)).toEqual([0, 12]);
  });

  it("refuses a clearance that would eat the thread", () => {
    const { doc, id } = addScrew(createDocument(), screw({ size: "M3", thread: "modelled" }, { clearance: "0.2" }));
    expect(resolveDocument(doc).errors[id]).toMatch(/clearance can be at most 0.125/);
  });
});
