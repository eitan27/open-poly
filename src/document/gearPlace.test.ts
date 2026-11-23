import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import {
  addGear,
  addSketch,
  addSketchEntity,
  addTransform,
  createDocument,
  evaluateVariables,
  updateParam,
  removeFeature,
  resolveDocument,
} from "./document";
import { bakeGear, DEFAULT_GEAR_SETTINGS, type GearSettings } from "./gear";
import type { SketchPlaneRef } from "./planes";
import type { Document, GearFeature } from "./types";
import type { Vec2 } from "../geom/gearProfile";

const TOP: SketchPlaneRef = { kind: "datum", id: "plane-top" };
const FRONT: SketchPlaneRef = { kind: "datum", id: "plane-front" };
const settings = (over: Partial<GearSettings> = {}, params: Partial<GearSettings["params"]> = {}): GearSettings => ({
  ...DEFAULT_GEAR_SETTINGS,
  ...over,
  params: { ...DEFAULT_GEAR_SETTINGS.params, backlash: "0.1", ...params },
});
const gearOf = (doc: Document, id: string) => doc.features.find((f) => f.id === id) as GearFeature;
const baked = (doc: Document, id: string) =>
  bakeGear(doc, gearOf(doc, id), evaluateVariables(doc.variables).scope, resolveDocument(doc).planeFrames);

function shoelace(r: Vec2[]) {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
}
const closed = (r: Vec2[]) => [...r, r[0]];
/** Area two gears' outlines (with their holes) share. */
function overlap(doc: Document, a: string, b: string): number {
  const rings = (id: string) => {
    const o = baked(doc, id).outline;
    return [o.outline, ...o.holes].map(closed);
  };
  return polygonClipping
    .intersection([rings(a)] as never, [rings(b)] as never)
    .reduce(
      (s, poly) => s + poly.reduce((t, ring, i) => t + (i === 0 ? 1 : -1) * Math.abs(shoelace(ring as Vec2[])), 0),
      0,
    );
}

describe("placing a gear beside its partner", () => {
  it("puts it at the meshing distance, toward the angle, with its teeth in mesh", () => {
    const one = addGear(
      createDocument(),
      TOP,
      settings({}, { teeth: "12", rotation: "17", centerX: "5", centerY: "-3" }),
    );
    for (const angle of ["0", "90", "-140", "33.3"]) {
      const two = addGear(
        one.doc,
        TOP,
        settings({ meshWith: one.id, placeBeside: true }, { teeth: "24", placeAngle: angle }),
      );
      const b = baked(two.doc, two.id);
      const a = (Number(angle) * Math.PI) / 180;
      expect(b.center[0]).toBeCloseTo(5 + 36 * Math.cos(a));
      expect(b.center[1]).toBeCloseTo(-3 + 36 * Math.sin(a));
      expect(overlap(two.doc, one.id, two.id)).toBeLessThan(1e-3);
    }
  });

  it("follows the partner when it moves, turns or changes size", () => {
    const one = addGear(createDocument(), TOP, settings({}, { teeth: "12" }));
    const two = addGear(one.doc, TOP, settings({ meshWith: one.id, placeBeside: true }, { teeth: "24" }));
    let doc = updateParam(two.doc, one.id, "centerX", "40");
    doc = updateParam(doc, one.id, "rotation", "11");
    doc = updateParam(doc, one.id, "module", "1.5");
    expect(baked(doc, two.id).center[0]).toBeCloseTo(40 + 27);
    expect(overlap(doc, one.id, two.id)).toBeLessThan(1e-3);
  });

  it("adds Rotation to the meshing angle, and a chain of placed gears all mesh", () => {
    const one = addGear(createDocument(), TOP, settings({}, { teeth: "15" }));
    const two = addGear(
      one.doc,
      TOP,
      settings({ meshWith: one.id, placeBeside: true }, { teeth: "22", placeAngle: "20" }),
    );
    const three = addGear(
      two.doc,
      TOP,
      settings({ meshWith: two.id, placeBeside: true }, { teeth: "13", placeAngle: "-60" }),
    );
    expect(overlap(three.doc, one.id, two.id)).toBeLessThan(1e-3);
    expect(overlap(three.doc, two.id, three.id)).toBeLessThan(1e-3);
    // Half a tooth more: now they clash.
    const off = updateParam(three.doc, three.id, "rotation", String(180 / 13));
    expect(overlap(off, two.id, three.id)).toBeGreaterThan(0.5);
  });

  it("puts a pinion inside a ring, and a ring round a pinion", () => {
    const ring = addGear(createDocument(), TOP, settings({ gearType: "internal" }, { teeth: "60", rotation: "4" }));
    const pin = addGear(
      ring.doc,
      TOP,
      settings({ meshWith: ring.id, placeBeside: true }, { teeth: "18", placeAngle: "200" }),
    );
    expect(Math.hypot(...baked(pin.doc, pin.id).center)).toBeCloseTo(42);
    expect(overlap(pin.doc, ring.id, pin.id)).toBeLessThan(1e-3);

    const p2 = addGear(createDocument(), TOP, settings({}, { teeth: "18", rotation: "9" }));
    const r2 = addGear(
      p2.doc,
      TOP,
      settings({ gearType: "internal", meshWith: p2.id, placeBeside: true }, { teeth: "60", placeAngle: "45" }),
    );
    expect(overlap(r2.doc, p2.id, r2.id)).toBeLessThan(1e-3);
  });

  it("refuses a plane that isn't parallel to the partner's", () => {
    const one = addGear(createDocument(), TOP, settings({}, { teeth: "12" }));
    const two = addGear(one.doc, FRONT, settings({ meshWith: one.id, placeBeside: true }, { teeth: "24" }));
    expect(resolveDocument(two.doc).errors[two.id]).toMatch(/parallel/);
  });

  it("refuses a partner a Transform moves afterwards, saying how to fix it", () => {
    const one = addGear(createDocument(), TOP, settings({}, { teeth: "12" }));
    const moved = addTransform(one.doc, one.id, [0, 0, 0], { tx: "10" });
    const two = addGear(moved.doc, TOP, settings({ meshWith: one.id, placeBeside: true }, { teeth: "24" }));
    expect(resolveDocument(two.doc).errors[two.id]).toMatch(/Transform 1 moves Gear 1 .* give Gear 1 a location/);
  });

  it("leaves a gear made before Place beside where its Center X/Y put it", () => {
    const one = addGear(createDocument(), TOP, settings({}, { teeth: "12" }));
    const two = addGear(one.doc, TOP, settings({ meshWith: one.id }, { teeth: "24", centerX: "50" }));
    const { placeAngle: _drop, ...oldParams } = gearOf(two.doc, two.id).params;
    const old: Document = {
      ...two.doc,
      features: two.doc.features.map((f) => (f.id === two.id ? { ...gearOf(two.doc, two.id), params: oldParams } : f)),
    };
    expect(baked(old, two.id).center).toEqual([50, 0]);
  });
});

describe("a gear's picked location", () => {
  const withPoint = (plane: SketchPlaneRef, p: [number, number]) => {
    const s = addSketch(createDocument(), plane);
    return { doc: addSketchEntity(s.doc, s.id, { type: "point", id: "pt", p }), sketchId: s.id };
  };
  const movePoint = (doc: Document, sketchId: string, p: [number, number]) => mapSketchPoint(doc, sketchId, p);

  it("centres on a sketch point, on that sketch's plane, and follows the point", () => {
    const { doc, sketchId } = withPoint(FRONT, [12, -4]);
    // Its own plane says Top; the sketch's (Front) wins, so it follows the sketch.
    const g = addGear(doc, TOP, settings({ center: { sketchId, entityId: "pt", at: "point" } }));
    let b = baked(g.doc, g.id);
    expect(b.center).toEqual([12, -4]);
    expect(b.frame.normal.map((x) => Math.round(Math.abs(x)))).toEqual([0, 1, 0]);
    b = baked(movePoint(g.doc, sketchId, [30, 2]), g.id);
    expect(b.center).toEqual([30, 2]);
  });

  it("centres on a fixed spot of the plane it was picked from", () => {
    const g = addGear(createDocument(), TOP, settings({ center: { uv: [7, 9], plane: FRONT } }));
    const b = baked(g.doc, g.id);
    expect(b.center).toEqual([7, 9]);
    expect(b.frame.normal.map((x) => Math.round(Math.abs(x)))).toEqual([0, 1, 0]);
  });

  it("a location wins over an older gear's Center X / Y", () => {
    const g = addGear(createDocument(), TOP, settings({ center: { uv: [1, 2], plane: TOP } }, { centerX: "50" }));
    expect(baked(g.doc, g.id).center).toEqual([1, 2]);
    const old = addGear(createDocument(), TOP, settings({}, { centerX: "50", centerY: "5" }));
    expect(baked(old.doc, old.id).center).toEqual([50, 5]);
  });

  it("a gear placed beside one with a location meshes around where it is", () => {
    const one = addGear(createDocument(), TOP, settings({ center: { uv: [10, 20], plane: TOP } }, { teeth: "12" }));
    const two = addGear(
      one.doc,
      TOP,
      settings({ meshWith: one.id, placeBeside: true }, { teeth: "24", placeAngle: "0" }),
    );
    expect(baked(two.doc, two.id).center[0]).toBeCloseTo(10 + 36);
    expect(baked(two.doc, two.id).center[1]).toBeCloseTo(20);
  });

  it("a sketch point that's gone is a readable error", () => {
    const { doc, sketchId } = withPoint(TOP, [0, 0]);
    const g = addGear(doc, TOP, settings({ center: { sketchId, entityId: "nope", at: "point" } }));
    expect(() => baked(g.doc, g.id)).toThrow(/sketch point it was placed on is gone/);
  });
});

function mapSketchPoint(doc: Document, sketchId: string, p: [number, number]): Document {
  return {
    ...doc,
    features: doc.features.map((f) =>
      f.id === sketchId && f.type === "sketch"
        ? { ...f, entities: f.entities.map((e) => (e.id === "pt" && e.type === "point" ? { ...e, p } : e)) }
        : f,
    ),
  };
}

describe("a meshed gear's module, and losing its partner", () => {
  /** A 54-tooth m1.5 gear, and an 18-tooth one meshed beside it. */
  const pair = (placeBeside = true) => {
    const one = addGear(createDocument(), TOP, settings({}, { teeth: "54", module: "1.5", pressureAngle: "25" }));
    const two = addGear(one.doc, TOP, settings({ meshWith: one.id, placeBeside }, { teeth: "18", placeAngle: "30" }));
    return { doc: two.doc, one: one.id, two: two.id };
  };
  const pts = (doc: Document, id: string) => baked(doc, id).outline.outline;

  it("keeps no module, pitch diameter or pressure angle of its own", () => {
    const { doc, two } = pair();
    const p = gearOf(doc, two).params;
    expect(p.module).toBeUndefined();
    expect(p.pitchDiameter).toBeUndefined();
    expect(p.pressureAngle).toBeUndefined();
    expect(baked(doc, two).spec.module).toBe(1.5);
  });

  it("follows the partner's module when that changes", () => {
    const { doc, one, two } = pair();
    const next = updateParam(doc, one, "module", "2");
    expect(baked(next, two).spec.module).toBe(2);
  });

  it("deleting the partner leaves it exactly where and what it was, on its own values", () => {
    const { doc, one, two } = pair();
    const before = pts(doc, two);
    const after = removeFeature(doc, one);
    const g = gearOf(after, two);
    expect(g.meshWith).toBeUndefined();
    expect(g.placeBeside).toBeUndefined();
    expect(g.params.module).toBe("1.5");
    expect(g.params.pitchDiameter).toBe("27");
    expect(g.params.pressureAngle).toBe("25");
    expect(g.center && "uv" in g.center).toBe(true);
    expect(resolveDocument(after).errors[two]).toBeUndefined();
    const now = pts(after, two);
    expect(now.length).toBe(before.length);
    now.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(before[i][0], 4);
      expect(y).toBeCloseTo(before[i][1], 4);
    });
  });

  it("not placed beside it, keeps its own location and rotation", () => {
    const { doc, one, two } = pair(false);
    const g = gearOf(removeFeature(doc, one), two);
    expect(g.center).toBeUndefined();
    expect(g.params.rotation).toBe(gearOf(doc, two).params.rotation);
    expect(g.params.module).toBe("1.5");
  });

  it("down a chain, only the gear meshed with the deleted one is unlinked", () => {
    const { doc, one, two } = pair();
    const three = addGear(doc, TOP, settings({ meshWith: two, placeBeside: true }, { teeth: "30" }));
    const before = pts(three.doc, three.id);
    const after = removeFeature(three.doc, one);
    expect(gearOf(after, three.id).meshWith).toBe(two);
    pts(after, three.id).forEach(([x, y], i) => {
      expect(x).toBeCloseTo(before[i][0], 4);
      expect(y).toBeCloseTo(before[i][1], 4);
    });
  });
});
