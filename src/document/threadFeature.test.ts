import { describe, expect, it } from "vitest";
import { DEFAULT_THREAD_SETTINGS, threadDims, threadReadout, type ThreadSettings } from "./threadFeature";

const settings = (patch: Partial<ThreadSettings> = {}, params: Partial<ThreadSettings["params"]> = {}) => ({
  ...DEFAULT_THREAD_SETTINGS,
  ...patch,
  params: { ...DEFAULT_THREAD_SETTINGS.params, ...params },
});

describe("threadDims", () => {
  it("defaults to a printable external thread, shrunk by the clearance", () => {
    const t = threadDims(settings(), {});
    expect(t).toMatchObject({ side: "external", profile: "printable", d: 10, pitch: 2, starts: 1 });
    expect(t.crestRadius).toBeCloseTo(5 - 0.15);
    // Printable: 0.3P deep.
    expect(t.crestRadius - t.rootRadius).toBeCloseTo(0.6);
  });

  it("an internal thread grows by the clearance, so a pair has twice it between them", () => {
    const ext = threadDims(settings(), {});
    const int = threadDims(settings({ side: "internal" }), {});
    expect(int.crestRadius - ext.crestRadius).toBeCloseTo(0.3);
  });

  it("takes variables", () => {
    expect(threadDims(settings({}, { diameter: "d * 2" }), { d: 12 }).d).toBe(24);
  });

  it("refuses what can't be built", () => {
    expect(() => threadDims(settings({}, { pitch: "0" }), {})).toThrow(/pitch/);
    expect(() => threadDims(settings({}, { starts: "1.5" }), {})).toThrow(/starts/);
    expect(() => threadDims(settings({}, { length: "1" }), {})).toThrow(/more than one pitch/);
    expect(() => threadDims(settings({}, { clearance: "1" }), {})).toThrow(/quarter pitch/);
    expect(() => threadDims(settings({ profile: "trapezoid" }, { diameter: "4", pitch: "3" }), {})).toThrow(
      /too coarse/,
    );
  });

  it("reads out the lead of a multi-start thread", () => {
    expect(threadReadout(threadDims(settings({}, { starts: "3" }), {}))).toMatch(/3 starts, lead 6/);
  });
});
