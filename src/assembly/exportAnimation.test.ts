import { describe, expect, it } from "vitest";
import type { AnimateSpec } from "./animate";
import { exportFrameValues, exportSize, extensionOf, videoMimeType } from "./exportAnimation";

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

describe("videoMimeType", () => {
  const has =
    (...types: string[]) =>
    (t: string) =>
      types.includes(t);
  it("picks H.264 MP4 over WebM where both record (Chrome)", () => {
    expect(videoMimeType(has("video/webm;codecs=vp9", "video/webm", "video/mp4;codecs=avc1.640028", "video/mp4"))).toBe(
      "video/mp4;codecs=avc1.640028",
    );
  });
  it("falls back to WebM where MP4 doesn't record (Firefox)", () => {
    expect(videoMimeType(has("video/webm;codecs=vp8", "video/webm"))).toBe("video/webm;codecs=vp8");
  });
  it("prefers WebM to an MP4 of unnamed codec, which may not be H.264", () => {
    expect(videoMimeType(has("video/webm", "video/mp4"))).toBe("video/webm");
  });
  it("takes bare MP4 when that's all there is (Safari)", () => {
    expect(videoMimeType(has("video/mp4"))).toBe("video/mp4");
  });
  it("is null where nothing records", () => {
    expect(videoMimeType(() => false)).toBeNull();
  });
});
