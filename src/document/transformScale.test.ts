import { describe, it, expect } from "vitest";
import { addTransform, createDocument, migrateDocument, resolveDocument, setTransform, updateParam } from "./document";
import type { Document, TransformFeature } from "./types";

/** A document holding one transform on a (notional) body, plus its feature. */
function withTransform(opts: Parameters<typeof addTransform>[3] = {}) {
  const { doc, id } = addTransform(createDocument(), "b1", [10, 0, 0], opts);
  return { doc, id, feature: doc.features.find((f) => f.id === id) as TransformFeature };
}

const resolvedTransform = (doc: Document, id: string) =>
  resolveDocument(doc).features.find((f) => f.id === id) as Extract<
    ReturnType<typeof resolveDocument>["features"][number],
    { type: "transform" }
  >;

describe("transform scale", () => {
  it("defaults to 1 — a new transform only moves", () => {
    expect(withTransform().feature.scale).toBe("1");
  });

  it("takes a factor at creation and resolves it to a number", () => {
    const { doc, id } = withTransform({ scale: "2.5" });
    expect(resolvedTransform(doc, id).scale).toBe(2.5);
  });

  it("resolves an expression against the document's variables", () => {
    const { doc, id } = withTransform({ scale: "k * 2" });
    const withVar: Document = { ...doc, variables: [{ id: "v1", name: "k", expression: "1.5" }] };
    expect(resolvedTransform(withVar, id).scale).toBe(3);
  });

  it("is editable through updateParam and setTransform", () => {
    const { doc, id } = withTransform();
    expect((updateParam(doc, id, "scale", "3").features[0] as TransformFeature).scale).toBe("3");
    expect((setTransform(doc, id, { scale: "0.5" }).features[0] as TransformFeature).scale).toBe("0.5");
  });

  it("rejects a factor that isn't greater than zero", () => {
    for (const bad of ["0", "-2", ""]) {
      const { doc, id } = withTransform({ scale: bad });
      const res = resolveDocument(doc);
      expect(res.features.find((f) => f.id === id)).toBeUndefined();
      expect(res.errors[id]).toBeTruthy();
    }
  });

  it("backfills scale = 1 on a document saved before it existed", () => {
    const legacy = {
      features: [
        {
          id: "t1",
          type: "transform",
          name: "Transform 1",
          suppressed: false,
          targetId: "b1",
          tx: "5",
          ty: "0",
          tz: "0",
          angle: "0",
          axis: "z",
          pivot: [0, 0, 0],
          copy: false,
          color: 0x123456,
          opacity: 1,
        },
      ],
      rollbackIndex: 1,
      variables: [],
    } as unknown as Document;
    const migrated = migrateDocument(legacy).features[0] as TransformFeature;
    expect(migrated.scale).toBe("1");
    expect(migrated.color).toBe(0x123456); // untouched by the backfill
  });
});
