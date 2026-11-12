import { describe, expect, it } from "vitest";
import type { AnimateSpec } from "./animate";
import { exportFrameValues, exportSize, extensionOf } from "./exportAnimation";

const spec = (mode: AnimateSpec["mode"], seconds = 1): AnimateSpec => ({
  mateId: "m",
  dof: "rz",
  from: 0,
  to: 90,
  seconds,
  mode,
});

describe("exportFrameValues", () => {
  it("runs once from end to end, both included", () => {
    const v = exportFrameValues(spec("once"), 4);
    expect(v).toEqual([0, 30, 60, 90]);
  });
  it("sweeps a loop a frame short of where it starts again", () => {
    expect(exportFrameValues(spec("loop"), 4)).toEqual([0, 22.5, 45, 67.5]);
  });
  it("bounces there and back over twice the time, a frame short of the start", () => {
    expect(exportFrameValues(spec("bounce"), 2)).toEqual([0, 45, 90, 45]);
  });
  it("lasts the sweep's time at the frame rate", () => {
    expect(exportFrameValues(spec("loop", 3), 30)).toHaveLength(90);
    expect(exportFrameValues(spec("bounce", 3), 20)).toHaveLength(120);
  });
});

describe("exportSize", () => {
  it("keeps the view's shape, in even pixels", () => {
    expect(exportSize("video", 16 / 9)).toEqual({ width: 1280, height: 720 });
    expect(exportSize("gif", 1.57)).toEqual({ width: 640, height: 408 });
  });
});

describe("extensionOf", () => {
  it("names the file by its type", () => {
    expect(extensionOf("image/gif")).toBe("gif");
    expect(extensionOf("video/webm")).toBe("webm");
    expect(extensionOf("video/mp4")).toBe("mp4");
  });
});
