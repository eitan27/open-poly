import { describe, it, expect } from "vitest";
import { addPlane, createDocument, resolvePlanes, setFeatureHidden, setSuppressed } from "./document";
import { frameOf, planeResolves } from "./planes";
import type { PlaneFeature } from "./types";

const scope = {};

describe("hiding a reference plane is a view toggle, not a suppress", () => {
  it("setFeatureHidden flags the plane but leaves it in the model", () => {
    const { doc, id } = addPlane(createDocument(), {
      method: "offset",
      base: { kind: "datum", id: "plane-top" },
      offset: "10",
    });
    const hidden = setFeatureHidden(doc, id, true);
    expect((hidden.features[0] as PlaneFeature).hidden).toBe(true);
    // still resolved, so sketches and features built on it keep working
    const frames = resolvePlanes(hidden, scope);
    expect(frames.has(id)).toBe(true);
    expect(frameOf({ kind: "plane", planeId: id }, frames).origin[2]).toBeCloseTo(10, 6);
    expect(planeResolves({ kind: "plane", planeId: id }, frames)).toBe(true);
  });

  it("suppressing a plane, by contrast, drops it from the resolved frames", () => {
    const { doc, id } = addPlane(createDocument(), {
      method: "offset",
      base: { kind: "datum", id: "plane-top" },
      offset: "10",
    });
    const frames = resolvePlanes(setSuppressed(doc, id, true), scope);
    expect(frames.has(id)).toBe(false);
    // render paths must be able to ask instead of catching a throw
    expect(planeResolves({ kind: "plane", planeId: id }, frames)).toBe(false);
    expect(() => frameOf({ kind: "plane", planeId: id }, frames)).toThrow();
  });

  it("a datum-plane ref always resolves", () => {
    expect(planeResolves({ kind: "datum", id: "plane-front" }, new Map())).toBe(true);
  });
});
