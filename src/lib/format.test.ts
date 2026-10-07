import { describe, expect, it } from "vitest";
import { formatNumber, formatRounded3 } from "./format";

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

describe("formatRounded3 vs formatNumber", () => {
  it("agrees with formatNumber on ordinary values", () => {
    for (const v of [0, 2, -7, 1.5, 1.23456, 100.0001, -0.25]) {
      expect(formatRounded3(v)).toBe(formatNumber(v));
    }
  });

  it("renders a near-zero as 0, never -0", () => {
    // String(-0) is "0", which is why the old one never needed formatNumber's guard.
    expect(formatRounded3(-1e-7)).toBe("0");
    expect(formatNumber(-1e-7)).toBe("0");
  });

  // The one documented disagreement. Pinned so that unifying the two is a decision
  // someone makes on purpose rather than a diff nobody notices.
  it("differs at an exact half, which is why they are still two functions", () => {
    expect(formatRounded3(1.0005)).toBe("1.001");
    expect(formatNumber(1.0005)).toBe("1");
  });
});
