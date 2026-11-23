import { describe, expect, it } from "vitest";
import polygonClipping from "polygon-clipping";
import { addGear, createDocument, evaluateVariables, removeFeature, resolveDocument, updateParam } from "./document";
import { bakeGear, DEFAULT_GEAR_SETTINGS, gearReadout, meshCandidates, unlinkGear, type GearSettings } from "./gear";
import type { SketchPlaneRef } from "./planes";
import type { Document, GearFeature } from "./types";
import type { Vec2 } from "../geom/gearProfile";

const TOP: SketchPlaneRef = { kind: "datum", id: "plane-top" };
const settings = (over: Partial<GearSettings> = {}, params: Partial<GearSettings["params"]> = {}): GearSettings => ({
  ...DEFAULT_GEAR_SETTINGS,
  ...over,
  params: { ...DEFAULT_GEAR_SETTINGS.params, backlash: "0.1", ...params },
});
const gearOf = (doc: Document, id: string) => doc.features.find((f) => f.id === id) as GearFeature;
const scope = (doc: Document) => evaluateVariables(doc.variables).scope;
const baked = (doc: Document, id: string) =>
  bakeGear(doc, gearOf(doc, id), scope(doc), resolveDocument(doc).planeFrames);

function shoelace(r: Vec2[]) {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
}
const closed = (r: Vec2[]) => [...r, r[0]];
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

const rackSettings = (pinion: string, params: Partial<GearSettings["params"]> = {}) =>
  settings({ gearType: "rack", meshWith: pinion, placeBeside: true, bore: "none" }, { teeth: "12", ...params });

describe("a rack", () => {
  it("builds on its own, centred on its pitch line, running along its direction", () => {
    const r = addGear(createDocument(), TOP, settings({ gearType: "rack" }, { teeth: "10", rotation: "90" }));
    const b = baked(r.doc, r.id);
    expect("rack" in b.outline).toBe(true);
    const ys = b.outline.outline.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10 * Math.PI * 2, 6);
    expect(resolveDocument(r.doc).errors[r.id]).toBeUndefined();
  });

  it("sits beside its pinion at the pitch radius, teeth in mesh, for any angle and pinion phase", () => {
    for (const rot of ["0", "7", "-13.3"])
      for (const angle of ["0", "90", "-140", "33.3"]) {
        const pin = addGear(createDocument(), TOP, settings({}, { teeth: "15", rotation: rot, centerX: "4" }));
        const rack = addGear(pin.doc, TOP, rackSettings(pin.id, { placeAngle: angle }));
        const b = baked(rack.doc, rack.id);
        const a = (Number(angle) * Math.PI) / 180;
        // Its pitch line is 15 mm (the pitch radius) out along the angle.
        const along = (b.center[0] - 4) * Math.cos(a) + b.center[1] * Math.sin(a);
        expect(along).toBeCloseTo(15, 6);
        // Within a tooth pitch of centred on the pinion.
        const across = -(b.center[0] - 4) * Math.sin(a) + b.center[1] * Math.cos(a);
        expect(Math.abs(across)).toBeLessThanOrEqual(Math.PI);
        expect(overlap(rack.doc, pin.id, rack.id)).toBeLessThan(1e-3);
        // Half a tooth along: now they clash.
        const off = updateParam(rack.doc, rack.id, "slide", "0.5");
        expect(overlap(off, pin.id, rack.id)).toBeGreaterThan(0.5);
      }
  });

  it("slides whole teeth and stays in mesh; pushes out by the pinion's profile shift", () => {
    const pin = addGear(createDocument(), TOP, settings({}, { teeth: "10", profileShift: "0.4" }));
    const rack = addGear(pin.doc, TOP, rackSettings(pin.id, { slide: "-3" }));
    const b = baked(rack.doc, rack.id);
    expect(b.center[0]).toBeCloseTo(10 + 0.8, 6);
    expect(overlap(rack.doc, pin.id, rack.id)).toBeLessThan(1e-3);
    // And it's in mesh, not just clear: unlinked where it is, then pushed a
    // quarter millimetre toward the pinion (more than the backlash allows),
    // it clashes.
    const g = gearOf(rack.doc, rack.id);
    const patch = unlinkGear(rack.doc, g, scope(rack.doc), resolveDocument(rack.doc).planeFrames, "module")!;
    const uv = (patch.center as { uv: [number, number] }).uv;
    const closer: Document = {
      ...rack.doc,
      features: rack.doc.features.map((f) =>
        f.id === rack.id ? { ...g, ...patch, center: { uv: [uv[0] - 0.25, uv[1]], plane: TOP } } : f,
      ),
    };
    expect(overlap(closer, pin.id, rack.id)).toBeGreaterThan(1e-3);
  });

  it("follows its pinion's size, and refuses a ring gear or being a partner", () => {
    const pin = addGear(createDocument(), TOP, settings({}, { teeth: "12" }));
    const rack = addGear(pin.doc, TOP, rackSettings(pin.id));
    const doc = updateParam(rack.doc, pin.id, "module", "1.5");
    expect(baked(doc, rack.id).spec.module).toBe(1.5);
    expect(overlap(doc, pin.id, rack.id)).toBeLessThan(1e-3);

    const ring = addGear(rack.doc, TOP, settings({ gearType: "internal" }, { teeth: "60" }));
    expect(meshCandidates(ring.doc, rack.id, "rack").map((g) => g.id)).toEqual([pin.id]);
    expect(meshCandidates(ring.doc, undefined, "spur").map((g) => g.id)).toEqual([pin.id, ring.id]);
    const onRing = addGear(ring.doc, TOP, rackSettings(ring.id));
    expect(resolveDocument(onRing.doc).errors[onRing.id]).toMatch(/ring gear/);
    const onRack = addGear(rack.doc, TOP, settings({ meshWith: rack.id }));
    expect(resolveDocument(onRack.doc).errors[onRack.id]).toMatch(/is a rack/);
  });

  it("reads out its length and the pinion's distance to its pitch line", () => {
    const pin = addGear(createDocument(), TOP, settings({}, { teeth: "12" }));
    const rack = addGear(pin.doc, TOP, rackSettings(pin.id, { endMargin: "5" }));
    const g = gearOf(rack.doc, rack.id);
    const r = gearReadout(rack.doc, g, scope(rack.doc), resolveDocument(rack.doc).planeFrames);
    expect(r.dims).toBeNull();
    expect(r.rack!.length).toBeCloseTo(12 * 2 * Math.PI + 10, 6);
    expect(r.centerDistance).toBeCloseTo(12, 6);
    // 12 teeth meet a rack's tips below the base circle: the note says the
    // shift that clears it, and goes once it's given.
    expect(r.notes.join(" ")).toMatch(/Gear 1's 12 teeth clash .* profile shift of at least 0\.3[0-9]* /);
    const shifted = updateParam(rack.doc, pin.id, "profileShift", "0.3");
    const r2 = gearReadout(shifted, gearOf(shifted, rack.id), scope(shifted), resolveDocument(shifted).planeFrames);
    expect(r2.notes).toEqual([]);
    // The diagram's shape is in the rack's own axes: pitch line on y = 0.
    const ys = r.shape.outline.map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(2, 6);
  });

  it("keeps its place when unlinked, or when its pinion is deleted", () => {
    const pin = addGear(createDocument(), TOP, settings({}, { teeth: "12", rotation: "5" }));
    const rack = addGear(pin.doc, TOP, rackSettings(pin.id, { placeAngle: "30", slide: "1" }));
    const before = baked(rack.doc, rack.id).outline.outline;
    const g = gearOf(rack.doc, rack.id);
    const patch = unlinkGear(rack.doc, g, scope(rack.doc), resolveDocument(rack.doc).planeFrames, "module")!;
    const unlinked: Document = {
      ...rack.doc,
      features: rack.doc.features.map((f) => (f.id === rack.id ? { ...g, ...patch } : f)),
    };
    const after = baked(unlinked, rack.id).outline.outline;
    after.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(before[i][0], 5);
      expect(p[1]).toBeCloseTo(before[i][1], 5);
    });
    const gone = removeFeature(rack.doc, pin.id);
    expect(resolveDocument(gone).errors[rack.id]).toBeUndefined();
  });
});
