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
});
