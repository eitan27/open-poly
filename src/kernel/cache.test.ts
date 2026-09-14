import { describe, expect, it } from "vitest";
import { builderKey, contentKey, hashKey } from "./cache";
import type { ResolvedFeature } from "./types";

const primitive = {
  id: "f1",
  type: "primitive",
  kind: "box",
  params: { width: 10, depth: 10, height: 10 },
} as unknown as ResolvedFeature;

/** A transform rotating about a body EDGE — the case whose dependency set is
 *  larger than the obvious target. */
const transformOnEdge: ResolvedFeature = {
  id: "t1",
  type: "transform",
  targetId: "b1",
  tx: 0,
  ty: 0,
  tz: 0,
  angle: 0.5,
  axisEdge: { sourceId: "b2", edgeName: "top|front" },
  scale: 1,
  pivot: [0, 0, 0],
  copy: false,
};

describe("hashKey", () => {
  it("is deterministic", () => {
    expect(hashKey("hello")).toBe(hashKey("hello"));
  });

  it("differs for different input", () => {
    expect(hashKey("hello")).not.toBe(hashKey("world"));
  });

  it("differs for near-identical input (avalanche)", () => {
    expect(hashKey("hello")).not.toBe(hashKey("hellp"));
    expect(hashKey("ab")).not.toBe(hashKey("ba"));
  });

  it("returns a short base36 key for the empty string", () => {
    expect(hashKey("")).toMatch(/^[0-9a-z]+$/);
  });

  it("stays short however long the input — the reason it is hashed at all", () => {
    // Keys combine down a feature chain; without a hash they would grow without
    // bound. 200 stacked keys must still produce a ~10-character key.
    const long = Array.from({ length: 200 }, (_, i) => hashKey(String(i))).join("|");
    expect(long.length).toBeGreaterThan(2000);
    expect(hashKey(long).length).toBeLessThanOrEqual(11);
  });

  it("never emits the character contentKey joins on", () => {
    // Why the "|" separator is unambiguous in practice: every key fed back into
    // contentKey is itself a hashKey output, and base36 has no "|".
    const keys = Array.from({ length: 500 }, (_, i) => hashKey(`body-${i}`));
    expect(keys.every((k) => /^[0-9a-z]+$/.test(k))).toBe(true);
  });
});

describe("builderKey", () => {
  it("is deterministic for the same feature", () => {
    expect(builderKey(primitive)).toBe(builderKey(primitive));
  });

  it("changes when the feature's params change", () => {
    const other = { ...primitive, params: { width: 20, depth: 10, height: 10 } } as unknown as ResolvedFeature;
    expect(builderKey(primitive)).not.toBe(builderKey(other));
  });

  it("keys on the field ORDER too, so a reshuffled feature misses rather than hits", () => {
    // JSON.stringify is insertion-ordered, so the same fields in a different
    // order key differently. That costs a needless rebuild — the safe direction.
    // The unsafe direction (two different features sharing a key) is what must
    // never happen, and does not.
    const a = { id: "f1", type: "box", w: 1 } as unknown as ResolvedFeature;
    const b = { w: 1, type: "box", id: "f1" } as unknown as ResolvedFeature;
    expect(builderKey(a)).not.toBe(builderKey(b));
  });
});

describe("contentKey", () => {
  it("is deterministic for the same feature + input keys", () => {
    expect(contentKey(primitive, ["a", "b"])).toBe(contentKey(primitive, ["a", "b"]));
  });

  it("changes when an input key changes", () => {
    expect(contentKey(primitive, ["a", "b"])).not.toBe(contentKey(primitive, ["a", "c"]));
  });

  it("changes when input key ORDER changes", () => {
    expect(contentKey(primitive, ["a", "b"])).not.toBe(contentKey(primitive, ["b", "a"]));
  });

  it("changes when an input key is ADDED — a fold that misses a dependency serves a stale body", () => {
    // The transform-on-a-body-edge case: the axis body's key is folded in
    // alongside the target's. If that extra input did not move the key, moving
    // the edge's own body would return yesterday's transform.
    const targetOnly = contentKey(transformOnEdge, ["target-key"]);
    const withAxisBody = contentKey(transformOnEdge, ["target-key", "axis-body-key"]);
    expect(targetOnly).not.toBe(withAxisBody);
  });

  it("tracks each dependency independently — moving only the axis body re-keys", () => {
    const before = contentKey(transformOnEdge, ["target-key", "axis-v1"]);
    const after = contentKey(transformOnEdge, ["target-key", "axis-v2"]);
    expect(before).not.toBe(after);
  });

  it("differs from builderKey (no input keys) for the same feature", () => {
    expect(contentKey(primitive, [])).not.toBe(builderKey(primitive));
  });

  it("separates the feature from its inputs, so a feature change alone re-keys", () => {
    const other = { ...primitive, id: "f2" } as unknown as ResolvedFeature;
    expect(contentKey(primitive, ["a"])).not.toBe(contentKey(other, ["a"]));
  });
});
