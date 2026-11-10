import { describe, expect, it } from "vitest";
import { renameIdentifier } from "./expression";
import { addVariable, createDocument, renameInFeatures, renameVariable, updateVariable } from "./document";
import type { Document } from "./types";
import { renameInMates } from "../assembly/assembly";
import type { AssemblyDoc } from "../assembly/types";

describe("renameIdentifier", () => {
  it("renames whole identifiers and keeps everything else as typed", () => {
    expect(renameIdentifier("w*2 + w2 + ww - (w)/2", "w", "width")).toBe("width*2 + w2 + ww - (width)/2");
  });
  it("leaves function calls and numbers alone", () => {
    expect(renameIdentifier("sin(sin) + sin (1) + 1.5e", "sin", "s")).toBe("sin(s) + sin (1) + 1.5e");
  });
  it("is unchanged when the name isn't there", () => {
    expect(renameIdentifier("a + 1", "b", "c")).toBe("a + 1");
  });
});

const withVars = <T extends { variables: Document["variables"] }>(doc: T, vars: [string, string][]) => {
  let d = doc;
  for (const [name, expression] of vars) {
    const r = addVariable(d);
    d = updateVariable(updateVariable(r.doc, r.id, "name", name), r.id, "expression", expression);
  }
  return d;
};

describe("renameVariable", () => {
  const part = (): Document => {
    const d = withVars(createDocument(), [
      ["w", "10"],
      ["h", "w * 2"],
    ]);
    return {
      ...d,
      features: [
        ...d.features,
        { id: "b", name: "w", type: "primitive", kind: "box", params: { width: "w", depth: "w + h", height: "3" } },
        {
          id: "s",
          name: "Sketch",
          type: "sketch",
          entities: [{ type: "text", id: "t", p: [0, 0], value: "w", height: 5, exprs: { "p.0": "w / 2" } }],
          constraints: [{ id: "c", type: "distance", entity: "l", value: 10, expr: "w" }],
        },
        { id: "e", name: "Extrude", type: "extrude", distance: "w*3", targetId: "w" },
      ] as never,
    };
  };

  it("renames the variable and its uses in variables and features", () => {
    const d = part();
    const id = d.variables[0].id;
    const r = renameVariable(d, id, "width", renameInFeatures);
    expect(r.variables.map((v) => [v.name, v.expression])).toEqual([
      ["width", "10"],
      ["h", "width * 2"],
    ]);
    const [box, sketch, ext] = r.features.slice(-3) as never as [
      { name: string; params: Record<string, string> },
      { entities: { value: string; exprs: Record<string, string> }[]; constraints: { expr: string }[] },
      { distance: string; targetId: string },
    ];
    expect(box.params).toEqual({ width: "width", depth: "width + h", height: "3" });
    expect(sketch.entities[0].exprs).toEqual({ "p.0": "width / 2" });
    expect(sketch.constraints[0].expr).toBe("width");
    expect(ext.distance).toBe("width*3");
    // Names, ids and a sketch text's words are not expressions.
    expect(box.name).toBe("w");
    expect(ext.targetId).toBe("w");
    expect(sketch.entities[0].value).toBe("w");
  });

  it("only sets the name when the new one is invalid or taken", () => {
    const d = part();
    const id = d.variables[0].id;
    for (const bad of ["", "w2", "h", "pi"]) {
      const r = renameVariable(d, id, bad, renameInFeatures);
      expect(r.variables[0].name).toBe(bad);
      expect(r.variables[1].expression).toBe("w * 2");
    }
  });

  it("renames an assembly's mate values and limits", () => {
    const a = withVars({ instances: [], mates: [], variables: [] } as AssemblyDoc, [["lift", "5"]]);
    a.mates.push({
      id: "m",
      name: "Slider 1",
      type: "slider",
      a: { instanceId: "A", ref: { kind: "face", name: "lift" }, anchor: "center" },
      b: { instanceId: "B", ref: { kind: "face", name: "f" }, anchor: "center" },
      values: { tz: "lift + 1" },
      limits: { tz: { max: "lift * 2" } },
    });
    const r = renameVariable(a, a.variables[0].id, "raise", renameInMates);
    expect(r.mates[0].values).toEqual({ tz: "raise + 1" });
    expect(r.mates[0].limits).toEqual({ tz: { max: "raise * 2" } });
    // A connector's face name is not an expression.
    expect(r.mates[0].a.ref.name).toBe("lift");
  });
});
