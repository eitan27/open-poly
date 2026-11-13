import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import { addGear, addTransform, createDocument, evaluateVariables, updateParam, resolveDocument } from "./document";
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
    expect(resolveDocument(two.doc).errors[two.id]).toMatch(/Transform 1 moves Gear 1 .* Center X\/Y/);
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
