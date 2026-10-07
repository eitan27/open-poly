import { describe, it, expect } from "vitest";
import {
  validateDressUpSize,
  validateDressUpAngle,
  validateDressUpDialog,
  mapDressUpKernelError,
} from "./dressUpValidation";

const scope = { wall: 4, gap: 0 };

describe("validateDressUpSize — sync scenarios", () => {
  it("empty field: no error, no value (button disabled, nothing sent to kernel)", () => {
    expect(validateDressUpSize("", scope, "fillet")).toEqual({ error: null, value: null });
    expect(validateDressUpSize("   ", scope, "fillet")).toEqual({ error: null, value: null });
  });

  it("valid positive number resolves to a value with no error", () => {
    expect(validateDressUpSize("3", scope, "fillet")).toEqual({ error: null, value: 3 });
  });

  it("valid expression using a variable resolves", () => {
    expect(validateDressUpSize("wall/2", scope, "chamfer")).toEqual({ error: null, value: 2 });
  });

  it("zero and negative are rejected with an op-specific message", () => {
    expect(validateDressUpSize("0", scope, "fillet")).toEqual({
      error: "Radius must be greater than 0.",
      value: null,
    });
    expect(validateDressUpSize("-3", scope, "chamfer")).toEqual({
      error: "Distance must be greater than 0.",
      value: null,
    });
  });

  it("incomplete expression keeps the parser's specific wording, no value", () => {
    const r = validateDressUpSize("4+", scope, "fillet");
    expect(r.value).toBeNull();
    expect(r.error).toBe("Unexpected end of expression");
  });

  it('"5e" keeps the specific token in the message', () => {
    const r = validateDressUpSize("5e", scope, "fillet");
    expect(r.value).toBeNull();
    expect(r.error).toBe('Unexpected "e"');
  });

  it("unknown identifier is reworded name -> variable, keeping the name", () => {
    const r = validateDressUpSize("asdf", scope, "fillet");
    expect(r.value).toBeNull();
    expect(r.error).toBe('Unknown variable "asdf"');
  });

  it("invalid character keeps the specific character", () => {
    const r = validateDressUpSize("5$", scope, "fillet");
    expect(r.value).toBeNull();
    expect(r.error).toBe('Unexpected character "$"');
  });
});

describe("validateDressUpAngle — chamfer bevel angle", () => {
  it("empty field: no error, no value (button disabled, nothing sent to kernel)", () => {
    expect(validateDressUpAngle("", scope)).toEqual({ error: null, value: null });
    expect(validateDressUpAngle("   ", scope)).toEqual({ error: null, value: null });
  });

  it("the default 45 and other in-range angles resolve", () => {
    expect(validateDressUpAngle("45", scope)).toEqual({ error: null, value: 45 });
    expect(validateDressUpAngle("30", scope)).toEqual({ error: null, value: 30 });
    expect(validateDressUpAngle("89.9", scope)).toEqual({ error: null, value: 89.9 });
  });

  it("resolves an expression against the document's variables", () => {
    expect(validateDressUpAngle("wall*10", scope)).toEqual({ error: null, value: 40 });
  });

  it("rejects angles outside the open 0..90 range (a bevel must leave both faces)", () => {
    for (const bad of ["0", "-10", "90", "120"]) {
      expect(validateDressUpAngle(bad, scope)).toEqual({
        error: "Angle must be between 0 and 90°.",
        value: null,
      });
    }
  });

  it("keeps the parser's wording for an unparseable angle", () => {
    const r = validateDressUpAngle("asdf", scope);
    expect(r.value).toBeNull();
    expect(r.error).toBe('Unknown variable "asdf"');
  });
});

describe("mapDressUpKernelError — geometry failures", () => {
  it("maps an OCCT exception on a valid size to actionable, op-specific copy", () => {
    expect(mapDressUpKernelError("OCCT Standard_Failure (exception 241558136)", "fillet")).toBe(
      "That radius is too large for the selected edge(s) — try a smaller value.",
    );
    expect(mapDressUpKernelError("OCCT exception (undecoded pointer 12345)", "chamfer")).toBe(
      "That distance is too large for the selected edge(s) — try a smaller value.",
    );
  });

  it("maps out-of-memory to its own message", () => {
    expect(mapDressUpKernelError("OCCT Standard_OutOfMemory (exception 42)", "fillet")).toBe(
      "This operation ran out of memory — try a smaller value.",
    );
  });

  it("passes an already-readable non-OCCT message through unchanged", () => {
    expect(mapDressUpKernelError("No edges selected", "fillet")).toBe("No edges selected");
  });
});

describe("validateDressUpDialog — both fields together", () => {
  const fillet = { op: "fillet" as const, size: "2", angle: "45" };
  const chamfer = { op: "chamfer" as const, size: "2", angle: "45" };

  it("passes a valid pair and hands back the SIZE's value, not the angle's", () => {
    // Callers use `value` as the resolved size, so a passing chamfer must not
    // return 45 from the angle check.
    expect(validateDressUpDialog(chamfer, scope)).toMatchObject({ value: 2, error: null });
  });

  it("reports the size first when both are wrong", () => {
    const r = validateDressUpDialog({ op: "chamfer", size: "-1", angle: "200" }, scope);
    expect(r.value).toBeNull();
    expect(r.error).toContain("Distance");
  });

  it("ignores the angle entirely for a fillet", () => {
    expect(validateDressUpDialog({ ...fillet, angle: "999" }, scope)).toMatchObject({ value: 2 });
  });

  it("rejects an out-of-range chamfer angle even when the size is fine", () => {
    expect(validateDressUpDialog({ ...chamfer, angle: "90" }, scope)).toMatchObject({
      value: null,
      error: "Angle must be between 0 and 90°.",
    });
  });

  it("stays silent on an empty size, like the single-field validators do", () => {
    expect(validateDressUpDialog({ ...chamfer, size: "" }, scope)).toMatchObject({ value: null, error: null });
  });
});
