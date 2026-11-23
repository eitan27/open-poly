import { describe, expect, it } from "vitest";
import { SOLID_COLORS } from "../document/colors";
import { hiddenDashColor } from "./ghostContrast";
import { GHOST_COLOR } from "./Viewport";

describe("hiddenDashColor", () => {
  it("keeps the ghost's own colour behind bodies that differ from it", () => {
    expect(hiddenDashColor(GHOST_COLOR, [])).toBe(GHOST_COLOR);
    for (const c of [0xd66679, 0xd68b66, 0xd6ba66, 0x9566d6, 0x6688d6])
      expect(hiddenDashColor(GHOST_COLOR, [c])).toBe(GHOST_COLOR);
  });
  it("switches behind a body nearly the ghost's colour — sky, turquoise, mint", () => {
    for (const c of [0x66b5d6, 0x66d6cd, 0x66d69e, 0x4fb8e8])
      expect(hiddenDashColor(GHOST_COLOR, [c])).not.toBe(GHOST_COLOR);
  });
  it("leaves most of the palette alone", () => {
    const switched = SOLID_COLORS.filter((c) => hiddenDashColor(GHOST_COLOR, [c]) !== GHOST_COLOR);
    expect(switched.length).toBeLessThanOrEqual(3);
  });
  it("one similar body among several is enough", () => {
    expect(hiddenDashColor(GHOST_COLOR, [0xd68b66, 0x66b5d6])).not.toBe(GHOST_COLOR);
  });
});
