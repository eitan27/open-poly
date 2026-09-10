import { describe, it, expect } from "vitest";
import {
  dimensionValueOk,
  isDimension,
  isVariableExpression,
  relinkDimensions,
  relinkedValue,
  sketchesNeedingRelink,
  type DimensionConstraint,
} from "./dimensionExpr";
import type { SketchConstraint } from "./types";

const scope = { w: 40, wall: 3, deg: 30 };

const length = (over: Record<string, unknown> = {}): DimensionConstraint =>
  ({ id: "c1", type: "distance", entity: "l1", value: 40, ...over }) as DimensionConstraint;

describe("isVariableExpression — what's worth remembering", () => {
  it("remembers text that names something", () => {
    expect(isVariableExpression("w")).toBe(true);
    expect(isVariableExpression("wall * 2")).toBe(true);
    expect(isVariableExpression("2*w + 1")).toBe(true);
  });

  it("doesn't remember arithmetic that can never change", () => {
    expect(isVariableExpression("40")).toBe(false);
    expect(isVariableExpression("12.5")).toBe(false);
    expect(isVariableExpression("12 * 2 + 1")).toBe(false);
  });
});

describe("isDimension — only constraints with a value can be driven", () => {
  it("accepts the four dimensional kinds", () => {
    expect(isDimension(length())).toBe(true);
    expect(isDimension({ id: "c", type: "radius", entity: "e", value: 5 })).toBe(true);
    expect(isDimension({ id: "c", type: "angle", a: "a", b: "b", value: 30 })).toBe(true);
    expect(
      isDimension({
        id: "c",
        type: "distanceBetween",
        a: { on: "line", entity: "a" },
        b: { on: "line", entity: "b" },
        value: 10,
      }),
    ).toBe(true);
  });

  it("rejects the geometric ones", () => {
    expect(isDimension({ id: "c", type: "parallel", a: "a", b: "b" })).toBe(false);
    expect(isDimension({ id: "c", type: "horizontal", entity: "l" })).toBe(false);
  });
});

describe("relinkedValue — re-evaluating one dimension", () => {
  it("follows a plain variable", () => {
    expect(relinkedValue(length({ value: 10, expr: "w" }), scope)).toBe(40);
  });

  it("follows an expression over variables", () => {
    expect(relinkedValue(length({ value: 10, expr: "w - wall * 2" }), scope)).toBe(34);
  });

  it("leaves an un-linked dimension alone", () => {
    expect(relinkedValue(length({ value: 40 }), scope)).toBeNull();
  });

  it("keeps the last good value when the variable is gone or half-typed", () => {
    expect(relinkedValue(length({ value: 40, expr: "gone" }), scope)).toBeNull();
    expect(relinkedValue(length({ value: 40, expr: "w *" }), scope)).toBeNull();
  });

  it("refuses a value that would collapse or invert the geometry", () => {
    // A length driven by a variable that dips to 0 or below keeps its last good
    // value rather than destroying the sketch.
    expect(relinkedValue(length({ value: 40, expr: "w" }), { w: 0 })).toBeNull();
    expect(relinkedValue(length({ value: 40, expr: "w" }), { w: -5 })).toBeNull();
  });

  it("applies the angle range, not the length range", () => {
    const angle = { id: "a1", type: "angle", a: "l1", b: "l2", value: 30, expr: "deg" } as SketchConstraint;
    expect(relinkedValue(angle, { deg: 0 })).toBe(0); // 0° is a legal angle
    expect(relinkedValue(angle, { deg: 180 })).toBeNull(); // 180° is not
    expect(relinkedValue(angle, { deg: 95 })).toBe(95);
  });
});

describe("dimensionValueOk", () => {
  it("lengths must be positive and finite", () => {
    expect(dimensionValueOk(length(), 5)).toBe(true);
    expect(dimensionValueOk(length(), 0)).toBe(false);
    expect(dimensionValueOk(length(), NaN)).toBe(false);
    expect(dimensionValueOk(length(), Infinity)).toBe(false);
  });
});

describe("relinkDimensions — a whole sketch's constraints", () => {
  const constraints: SketchConstraint[] = [
    { id: "c1", type: "distance", entity: "l1", value: 10, expr: "w" },
    { id: "c2", type: "radius", entity: "c1", value: 3 },
    { id: "c3", type: "parallel", a: "l1", b: "l2" },
  ];

  it("updates only the linked ones, leaving the rest identical", () => {
    const next = relinkDimensions(constraints, scope)!;
    expect(next).not.toBeNull();
    expect((next[0] as { value: number }).value).toBe(40);
    expect((next[0] as { expr?: string }).expr).toBe("w"); // the link survives the update
    expect(next[1]).toBe(constraints[1]); // untouched, same reference
    expect(next[2]).toBe(constraints[2]);
  });

  it("returns null when nothing moved — the signal to skip a re-solve", () => {
    expect(relinkDimensions([{ id: "c", type: "distance", entity: "l", value: 40, expr: "w" }], scope)).toBeNull();
    expect(relinkDimensions(constraints, { w: 10 })).toBeNull();
  });

  it("is idempotent: re-running on its own output changes nothing", () => {
    const once = relinkDimensions(constraints, scope)!;
    expect(relinkDimensions(once, scope)).toBeNull();
  });
});

describe("sketchesNeedingRelink", () => {
  const features = [
    { id: "s1", type: "sketch", constraints: [{ id: "c", type: "distance", entity: "l", value: 10, expr: "w" }] },
    { id: "s2", type: "sketch", constraints: [{ id: "c", type: "distance", entity: "l", value: 40, expr: "w" }] },
    { id: "s3", type: "sketch", constraints: [{ id: "c", type: "distance", entity: "l", value: 7 }] },
    { id: "b1", type: "primitive" },
  ] as Parameters<typeof sketchesNeedingRelink>[0];

  it("names only the sketches that would actually move", () => {
    // s2 already reads 40, s3 has no link, b1 isn't a sketch.
    expect(sketchesNeedingRelink(features, scope)).toEqual(["s1"]);
  });

  it("is empty when the variables haven't moved anything", () => {
    expect(sketchesNeedingRelink(features, { w: 10 })).toEqual(["s2"]);
    expect(sketchesNeedingRelink([], scope)).toEqual([]);
  });
});
