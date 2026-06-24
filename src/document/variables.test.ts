import { describe, expect, it } from "vitest";
import { addVariable, createDocument, validateVariableNames } from "./document";
import type { Variable } from "./types";

const v = (id: string, name: string, expression = "0"): Variable => ({ id, name, expression });

describe("validateVariableNames", () => {
  it("accepts letters-only names", () => {
    expect(validateVariableNames([v("1", "width"), v("2", "Height")])).toEqual({});
  });

  it("rejects numbers, spaces, and special characters", () => {
    const errs = validateVariableNames([
      v("1", "var1"),
      v("2", "my var"),
      v("3", "a-b"),
      v("4", ""),
    ]);
    expect(errs["1"]).toMatch(/number/i);
    expect(errs["2"]).toMatch(/space/i);
    expect(errs["3"]).toMatch(/special/i);
    expect(errs["4"]).toMatch(/empty/i);
  });

  it("rejects reserved names and duplicates", () => {
    const errs = validateVariableNames([v("1", "pi"), v("2", "sin"), v("3", "w"), v("4", "w")]);
    expect(errs["1"]).toMatch(/reserved/i);
    expect(errs["2"]).toMatch(/reserved/i);
    expect(errs["3"]).toBeUndefined(); // first "w" is fine
    expect(errs["4"]).toMatch(/duplicate/i);
  });
});

describe("addVariable", () => {
  it("generates number-free default names that pass validation", () => {
    let doc = createDocument();
    for (let i = 0; i < 30; i++) doc = addVariable(doc).doc;
    expect(validateVariableNames(doc.variables)).toEqual({});
    // No generated name contains a digit.
    expect(doc.variables.every((x) => /^[A-Za-z]+$/.test(x.name))).toBe(true);
    // Names are unique.
    expect(new Set(doc.variables.map((x) => x.name)).size).toBe(doc.variables.length);
  });
});
