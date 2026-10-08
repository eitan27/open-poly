import { describe, expect, it } from "vitest";
import { completeWith, matchVariables, trailingToken } from "./dimAutocomplete";

const vars = [
  { name: "width", value: 40 },
  { name: "widthInner", value: 30 },
  { name: "height", value: 20 },
];

describe("trailingToken", () => {
  it("ignores bare numbers and trailing operators/spaces", () => {
    expect(trailingToken("10")).toBe("");
    expect(trailingToken("width * ")).toBe("");
    expect(trailingToken("2 + ")).toBe("");
  });
  it("returns the identifier at the cursor end", () => {
    expect(trailingToken("wid")).toBe("wid");
    expect(trailingToken("2 * hei")).toBe("hei");
  });
});

describe("matchVariables", () => {
  it("suggests variables by prefix (case-insensitive), not exact full matches", () => {
    expect(matchVariables("wid", vars).map((v) => v.name)).toEqual(["width", "widthInner"]);
    expect(matchVariables("WID", vars).map((v) => v.name)).toEqual(["width", "widthInner"]);
    // A bare number offers nothing (so Enter just commits it).
    expect(matchVariables("25", vars)).toEqual([]);
    // A fully typed name isn't re-suggested as itself.
    expect(matchVariables("width", vars).map((v) => v.name)).toEqual(["widthInner"]);
  });
  it("completes within an expression", () => {
    expect(matchVariables("2 * hei", vars).map((v) => v.name)).toEqual(["height"]);
  });
});

describe("completeWith", () => {
  it("replaces only the trailing identifier", () => {
    expect(completeWith("wid", "width")).toBe("width");
    expect(completeWith("2 * hei", "height")).toBe("2 * height");
  });
});
