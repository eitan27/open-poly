import { describe, expect, it } from "vitest";
import { mateValuesText } from "./mateTypes";

describe("mateValuesText", () => {
  it("reads a one-DOF mate plainly", () => {
    expect(mateValuesText({ type: "slider" }, { tz: 15 })).toBe("15 mm");
    expect(mateValuesText({ type: "revolute" }, { rz: 90 })).toBe("90°");
  });

  it("names the axes where a mate has several of a kind", () => {
    expect(mateValuesText({ type: "planar" }, { tx: 3, ty: -4.5, rz: 30 })).toBe("x 3 mm · y -4.5 mm · 30°");
    expect(mateValuesText({ type: "ball" }, { rx: 10, ry: 0, rz: 5 })).toBe("x 10° · y 0° · z 5°");
    expect(mateValuesText({ type: "cylindrical" }, { tz: 12, rz: 90 })).toBe("12 mm · 90°");
  });

  it("shows the expression that sets a value", () => {
    expect(mateValuesText({ type: "slider", values: { tz: "lift" } }, { tz: 25 })).toBe("lift = 25 mm");
  });

  it("is empty for a fastened mate, and reads 0 for a missing value", () => {
    expect(mateValuesText({ type: "fastened" }, {})).toBe("");
    expect(mateValuesText({ type: "slider" }, undefined)).toBe("0 mm");
  });
});
