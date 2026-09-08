import { describe, it, expect } from "vitest";
import { resolveDocument } from "./document";
import type { Document, DressUpFeature, PrimitiveFeature } from "./types";

// Lowering a DressUpFeature: the chamfer angle is optional, so an unangled
// chamfer must resolve to exactly the shape it had before the field existed
// (the kernel content-keys the resolved feature, so a stray `angle: undefined`
// would be fine but a stray `angle: 45` would not be for legacy documents).

const box: PrimitiveFeature = {
  id: "box",
  type: "primitive",
  kind: "box",
  name: "Box 1",
  suppressed: false,
  params: { width: "10", depth: "10", height: "10", x: "0", y: "0", z: "0" },
  color: 0,
  opacity: 1,
};

const mkDoc = (dress: Partial<DressUpFeature>, variables: Document["variables"] = []): Document => ({
  features: [
    box,
    {
      id: "ch",
      type: "dressup",
      name: "Chamfer 1",
      suppressed: false,
      op: "chamfer",
      targets: [{ targetId: "box", edges: ["box/+x∩box/+z"] }],
      size: "2",
      ...dress,
    } as DressUpFeature,
  ],
  variables,
  rollbackIndex: 2,
});

const resolved = (doc: Document) => {
  const res = resolveDocument(doc);
  const f = res.features.find((x) => x.id === "ch");
  if (f && f.type !== "dressup") throw new Error("expected a resolved dressup");
  return { res, f };
};

describe("resolveDocument — chamfer angle", () => {
  it("a chamfer with no angle carries no angle/flip keys", () => {
    const { res, f } = resolved(mkDoc({}));
    expect(res.errors.ch).toBeUndefined();
    expect(f).toEqual({
      id: "ch",
      type: "dressup",
      op: "chamfer",
      targets: [{ targetId: "box", edges: ["box/+x∩box/+z"], edgeRefs: undefined }],
      size: 2,
    });
    expect("angle" in f!).toBe(false);
  });

  it("an angled chamfer lowers the angle to a number, and flip only when set", () => {
    expect(resolved(mkDoc({ angle: "30" })).f).toMatchObject({ size: 2, angle: 30 });
    expect("flip" in resolved(mkDoc({ angle: "30" })).f!).toBe(false);
    expect(resolved(mkDoc({ angle: "30", flip: true })).f).toMatchObject({ angle: 30, flip: true });
  });

  it("the angle is an expression, evaluated against the document's variables", () => {
    const doc = mkDoc({ angle: "draft" }, [{ id: "v", name: "draft", expression: "20" }]);
    expect(resolved(doc).f).toMatchObject({ angle: 20 });
  });

  it("an angle outside 0..90 fails the feature with a readable error", () => {
    for (const bad of ["0", "90", "135"]) {
      const { res, f } = resolved(mkDoc({ angle: bad }));
      expect(res.errors.ch).toBe("Chamfer angle must be between 0 and 90°.");
      expect(f).toBeUndefined();
    }
  });

  it("a fillet ignores a stored angle (it has no bevel to tilt)", () => {
    const { f } = resolved(mkDoc({ op: "fillet", angle: "30", flip: true }));
    expect("angle" in f!).toBe(false);
    expect("flip" in f!).toBe(false);
  });
});
