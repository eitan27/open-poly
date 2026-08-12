import { describe, expect, it } from "vitest";
import { formatNumber } from "./format";

describe("formatNumber", () => {
  it("shows integers with no decimal point", () => {
    expect(formatNumber(5)).toBe("5");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(-3)).toBe("-3");
  });

  it("trims trailing zeros", () => {
    expect(formatNumber(1.5)).toBe("1.5");
    expect(formatNumber(1.25)).toBe("1.25");
  });

  it("rounds to 3 decimal places", () => {
    expect(formatNumber(1 / 3)).toBe("0.333");
  });

  it("drops a bare trailing decimal point when the fraction rounds away", () => {
    expect(formatNumber(9.9999999)).toBe("10");
  });

  it("formats negative fractional values", () => {
    expect(formatNumber(-1.5)).toBe("-1.5");
  });

  // A negative that rounds away must not surface as "-0" — it reads as a bug in
  // a measurement readout, and the implementations this consolidated all showed
  // "0" here (they rounded via Math.round(v * 1000) / 1000, and String(-0) is "0").
  it("renders a negative that rounds away as 0, not -0", () => {
    expect(formatNumber(-0.0004)).toBe("0");
    expect(formatNumber(-1e-7)).toBe("0");
    expect(formatNumber(-0)).toBe("0");
  });
});
