import { describe, expect, it } from "vitest";
import { isBlankCapture } from "./usePersistedDocuments";

const fill = (n: number, rgba: [number, number, number, number]) => {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) out.set(rgba, i * 4);
  return out;
};

describe("isBlankCapture", () => {
  it("flags a transparent readback and an all-black one", () => {
    expect(isBlankCapture(fill(5000, [0, 0, 0, 0]))).toBe(true);
    expect(isBlankCapture(fill(5000, [0, 0, 0, 255]))).toBe(true);
  });

  it("accepts the dark and light viewport backgrounds", () => {
    expect(isBlankCapture(fill(5000, [27, 29, 35, 255]))).toBe(false);
    expect(isBlankCapture(fill(5000, [233, 237, 243, 255]))).toBe(false);
  });
});
