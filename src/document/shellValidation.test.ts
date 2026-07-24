import { describe, it, expect } from "vitest";
import { validateShellThickness, mapShellKernelError } from "./shellValidation";

const scope = { wall: 4, gap: 0 };

describe("validateShellThickness — sync scenarios", () => {
  it("empty field: no error, no value (button disabled, nothing sent to kernel)", () => {
    expect(validateShellThickness("", scope)).toEqual({ error: null, value: null });
    expect(validateShellThickness("   ", scope)).toEqual({ error: null, value: null });
  });

  it("valid positive number resolves to a value with no error", () => {
    expect(validateShellThickness("3", scope)).toEqual({ error: null, value: 3 });
  });

  it("valid expression using a variable resolves", () => {
    expect(validateShellThickness("wall/2", scope)).toEqual({ error: null, value: 2 });
  });

  it("zero and negative are rejected", () => {
    expect(validateShellThickness("0", scope)).toEqual({
      error: "Thickness must be greater than 0.",
      value: null,
    });
    expect(validateShellThickness("-3", scope)).toEqual({
      error: "Thickness must be greater than 0.",
      value: null,
    });
  });

  it("unknown identifier is reworded name -> variable, keeping the name", () => {
    const r = validateShellThickness("asdf", scope);
    expect(r.value).toBeNull();
    expect(r.error).toBe('Unknown variable "asdf"');
  });
});

describe("mapShellKernelError — geometry failures", () => {
  it("maps an OCCT exception on a valid thickness to actionable copy", () => {
    expect(mapShellKernelError("OCCT Standard_Failure (exception 241558136)")).toBe(
      "That thickness doesn't work for this body — the walls may collide or the picked faces may be too small. Try a smaller value.",
    );
  });

  it("maps out-of-memory to its own message", () => {
    expect(mapShellKernelError("OCCT Standard_OutOfMemory (exception 42)")).toBe(
      "This operation ran out of memory — try a smaller thickness.",
    );
  });

  it("passes an already-readable non-OCCT message through unchanged", () => {
    expect(mapShellKernelError("No faces selected")).toBe("No faces selected");
  });
});
