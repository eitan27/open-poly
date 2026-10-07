import { describe, expect, it } from "vitest";
import { patternDialogWarning, type PatternDraft } from "./patternValidation";

const scope = { wall: 4, zero: 0 };

const linear = (over: Partial<PatternDraft> = {}): PatternDraft => ({
  kind: "linear",
  targetId: "b1",
  count1: "3",
  spacing1: "25",
  dir2on: false,
  dir2: null,
  count2: "2",
  spacing2: "25",
  count: "6",
  mode: "full",
  angle: "90",
  ...over,
});
const circular = (over: Partial<PatternDraft> = {}): PatternDraft => linear({ kind: "circular", ...over });

describe("patternDialogWarning", () => {
  it("is null when there is no dialog", () => {
    expect(patternDialogWarning(null, scope)).toBeNull();
  });

  it("asks for a body before anything else", () => {
    // Even with other fields broken, the body comes first — it is the one thing
    // the user cannot have supplied yet when the dialog opens.
    expect(patternDialogWarning(linear({ targetId: null, count1: "1" }), scope)).toBe("Pick a body to pattern.");
  });

  describe("linear", () => {
    it("passes a well-formed pattern", () => {
      expect(patternDialogWarning(linear(), scope)).toBeNull();
    });

    it("rejects a count below two", () => {
      expect(patternDialogWarning(linear({ count1: "1" }), scope)).toBe("Count must be 2 or more.");
      expect(patternDialogWarning(linear({ count1: "" }), scope)).toBe("Count must be 2 or more.");
    });

    // Zero spacing stacks every copy on the original, which looks like nothing
    // happened rather than like an error.
    it("rejects zero or unparseable spacing", () => {
      expect(patternDialogWarning(linear({ spacing1: "0" }), scope)).toBe("Spacing must be a non-zero number.");
      expect(patternDialogWarning(linear({ spacing1: "zero" }), scope)).toBe("Spacing must be a non-zero number.");
      expect(patternDialogWarning(linear({ spacing1: "¿" }), scope)).toBe("Spacing must be a non-zero number.");
    });

    it("accepts a negative spacing and a variable expression", () => {
      expect(patternDialogWarning(linear({ spacing1: "-25" }), scope)).toBeNull();
      expect(patternDialogWarning(linear({ spacing1: "wall * 2" }), scope)).toBeNull();
    });

    it("ignores the second direction's fields while it is collapsed", () => {
      expect(patternDialogWarning(linear({ dir2on: false, count2: "1", spacing2: "0" }), scope)).toBeNull();
    });

    it("checks the second direction once it is enabled", () => {
      expect(patternDialogWarning(linear({ dir2on: true }), scope)).toBe("Pick the second direction (or collapse it).");
      expect(patternDialogWarning(linear({ dir2on: true, dir2: {}, count2: "1" }), scope)).toBe(
        "The second count must be 2 or more.",
      );
      expect(patternDialogWarning(linear({ dir2on: true, dir2: {}, spacing2: "0" }), scope)).toBe(
        "The second spacing must be a non-zero number.",
      );
    });
  });

  describe("circular", () => {
    it("passes a full turn without looking at the angle", () => {
      // 360° is implied by "full", so a nonsense angle field is irrelevant there.
      expect(patternDialogWarning(circular({ mode: "full", angle: "0" }), scope)).toBeNull();
    });

    it("rejects a count below two", () => {
      expect(patternDialogWarning(circular({ count: "1" }), scope)).toBe("Count must be 2 or more.");
    });

    it("rejects a zero or unparseable angle once one is given explicitly", () => {
      expect(patternDialogWarning(circular({ mode: "angle", angle: "0" }), scope)).toBe(
        "Angle must be a non-zero number.",
      );
      expect(patternDialogWarning(circular({ mode: "angle", angle: "nope" }), scope)).toBe(
        "Angle must be a non-zero number.",
      );
    });

    it("does not look at the linear fields", () => {
      expect(patternDialogWarning(circular({ count1: "1", spacing1: "0", dir2on: true }), scope)).toBeNull();
    });
  });
});
