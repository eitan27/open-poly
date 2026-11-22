import { describe, expect, it } from "vitest";
import {
  DEFAULT_THREAD_SETTINGS,
  matchThread,
  suggestThread,
  threadDims,
  threadReadout,
  type ThreadSettings,
} from "./threadFeature";
import { createDocument } from "./document";
import type { Document, ThreadFeature } from "./types";

const settings = (patch: Partial<ThreadSettings> = {}, params: Partial<ThreadSettings["params"]> = {}) => ({
  ...DEFAULT_THREAD_SETTINGS,
  ...patch,
  params: { ...DEFAULT_THREAD_SETTINGS.params, ...params },
});

describe("threadDims", () => {
  it("defaults to a printable thread on the whole face, a rod's shrunk by the clearance", () => {
    const t = threadDims(settings(), {});
    expect(t).toMatchObject({ side: "external", profile: "printable", d: 10, pitch: 2, starts: 1, length: null });
    expect(t.crestRadius).toBeCloseTo(5 - 0.15);
    // Printable: 0.3P deep.
    expect(t.crestRadius - t.rootRadius).toBeCloseTo(0.6);
  });

  it("a hole's grows by the clearance, so a pair has twice it between them", () => {
    const ext = threadDims(settings(), {}, "external");
    const int = threadDims(settings(), {}, "internal");
    expect(int.crestRadius - ext.crestRadius).toBeCloseTo(0.3);
  });

  it("takes variables", () => {
    expect(threadDims(settings({}, { diameter: "d * 2" }), { d: 12 }).d).toBe(24);
  });

  it("refuses what can't be built", () => {
    expect(() => threadDims(settings({}, { pitch: "0" }), {})).toThrow(/pitch/);
    expect(() => threadDims(settings({}, { starts: "1.5" }), {})).toThrow(/starts/);
    expect(() => threadDims(settings({ fullLength: false }, { length: "1" }), {})).toThrow(/more than one pitch/);
    expect(() => threadDims(settings({}, { clearance: "1" }), {})).toThrow(/quarter pitch/);
    expect(() => threadDims(settings({ profile: "trapezoid" }, { diameter: "4", pitch: "3" }), {})).toThrow(
      /too coarse/,
    );
  });

  it("ignores the length on the whole face", () => {
    expect(threadDims(settings({}, { length: "1" }), {}).length).toBeNull();
  });

  it("reads out the lead of a multi-start thread", () => {
    expect(threadReadout(threadDims(settings({ fullLength: false }, { starts: "3" }), {}))).toMatch(/3 starts, lead 6/);
  });
});

describe("suggestThread", () => {
  it("on a rod: its own diameter, rounded down so the crests are whole", () => {
    expect(suggestThread({ radius: 4.999999, internal: false }, settings(), {}).diameter).toBe("10");
    expect(suggestThread({ radius: 4.97, internal: false }, settings(), {}).diameter).toBe("9.9");
  });

  it("in a hole: the size whose minor diameter is the bore, rounded up", () => {
    // Ø8 + 2 × 0.6 deep = Ø9.2.
    expect(suggestThread({ radius: 4, internal: true }, settings(), {}).diameter).toBe("9.2");
  });

  it("a pitch in proportion: a Ø3 rod gets 1 mm, not 2 (which would take half its core)", () => {
    expect(suggestThread({ radius: 1.5, internal: false }, settings(), {})).toEqual({ diameter: "3", pitch: "1" });
    expect(suggestThread({ radius: 3, internal: false }, settings(), {}).pitch).toBe("1.5");
    // A hole keeps a pitch it's told to, and sizes for it: Ø8 + 2 × 0.3.
    expect(suggestThread({ radius: 4, internal: true }, settings({}, { pitch: "1" }), {}, true)).toEqual({
      diameter: "8.6",
      pitch: "1",
    });
  });

  it("ISO: a metric size with its coarse pitch — an M6 rod, an M6 tap drill", () => {
    const iso = settings({ profile: "iso" });
    expect(suggestThread({ radius: 3, internal: false }, iso, {})).toEqual({ diameter: "6", pitch: "1" });
    expect(suggestThread({ radius: 2.5, internal: true }, iso, {})).toEqual({ diameter: "6", pitch: "1" });
  });
});

describe("matchThread", () => {
  const withThread = (): { doc: Document; id: string } => {
    const doc = createDocument();
    const t: ThreadFeature = {
      id: "t1",
      type: "thread",
      name: "Thread 1",
      suppressed: false,
      face: { featureId: "rod", faceId: 1, center: [0, 0, 0] },
      side: "external",
      ...settings({ profile: "trapezoid", leftHand: true }, { diameter: "14", pitch: "3", starts: "2" }),
    };
    return { doc: { ...doc, features: [...doc.features, t] }, id: t.id };
  };

  it("copies a Thread's size, pitch, profile, starts and hand — by its faces' names on the cut body", () => {
    const { doc } = withThread();
    const m = matchThread(doc, { partId: "plate", faceName: "t1/thread12" }, null, settings(), {});
    expect(m?.label).toBe("Thread 1");
    expect(m?.patch).toMatchObject({
      profile: "trapezoid",
      leftHand: true,
      params: { diameter: "14", pitch: "3", starts: "2" },
    });
    // Not its clearance: that stays each part's own.
    expect(m?.patch.params.clearance).toBeUndefined();
  });

  it("never matches the thread being edited", () => {
    const { doc } = withThread();
    expect(matchThread(doc, { partId: "plate", faceName: "t1/thread12" }, null, settings(), {}, "t1")).toBeNull();
  });

  it("a plain face gets the thread it's ready for", () => {
    const m = matchThread(createDocument(), { partId: "plate" }, { radius: 4, internal: true }, settings(), {});
    expect(m?.label).toBe("a Ø8 hole");
    expect(m?.patch.params.diameter).toBe("9.2");
  });
});
