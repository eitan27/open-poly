import { describe, expect, it } from "vitest";
import { shiftIntoView } from "./dialogFit";

const box = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });

describe("shiftIntoView", () => {
  it("leaves a box that already fits where it is", () => {
    expect(shiftIntoView(box(100, 100, 190, 200), 1280, 800)).toEqual({ x: 0, y: 0 });
  });

  it("pulls a box hanging off the right and bottom back inside the margin", () => {
    // 375 × 667 phone, dialog opened at a tap near the bottom-right corner.
    expect(shiftIntoView(box(300, 600, 190, 200), 375, 667)).toEqual({ x: -123, y: -141 });
  });

  it("pushes a box off the left and top back inside the margin", () => {
    expect(shiftIntoView(box(-40, -100, 190, 200), 375, 667)).toEqual({ x: 48, y: 108 });
  });

  it("pins a box bigger than the window by its top-left corner", () => {
    expect(shiftIntoView(box(50, 50, 500, 900), 375, 667)).toEqual({ x: -42, y: -42 });
  });

  it("is stable: a box it has already moved needs no further move", () => {
    const r = box(300, 600, 190, 200);
    const s = shiftIntoView(r, 375, 667);
    const moved = { left: r.left + s.x, top: r.top + s.y, right: r.right + s.x, bottom: r.bottom + s.y };
    expect(shiftIntoView(moved, 375, 667)).toEqual({ x: 0, y: 0 });
  });
});
