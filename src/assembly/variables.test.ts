// An assembly's variables: the part document's helpers on an AssemblyDoc, and
// mate values and limits that name them, in the tree, in a loop and dragged.
import { describe, expect, it } from "vitest";
import { addVariable, evaluateVariables, removeVariable, updateVariable } from "../document/document";
import { dragAssembly } from "./drag";
import { defaultX, frameMatrix } from "./frames";
import { applyPoint, IDENTITY, translation, type Vec3 } from "./placement";
import { solve } from "./solve";
import type { AssemblyDoc, Instance, Mat4, Mate, MateConnector } from "./types";

const frame = (origin: Vec3, z: Vec3): Mat4 => frameMatrix({ origin, z, x: defaultX(z) });
const FRAMES: Record<string, Mat4> = {
  top: frame([10, 10, 20], [0, 0, 1]),
  bottom: frame([10, 10, 0], [0, 0, -1]),
};
const frameOf = (c: MateConnector): Mat4 | string => FRAMES[c.ref.name] ?? `No ${c.ref.name}`;
const inst = (id: string, extra: Partial<Instance> = {}): Instance => ({
  id,
  name: id,
  source: { docId: "d", partId: "p" },
  transform: IDENTITY,
  ...extra,
});
const conn = (instanceId: string, name: string): MateConnector => ({
  instanceId,
  ref: { kind: "face", name },
  anchor: "center",
});
const slider = (extra: Partial<Mate> = {}): Mate => ({
  id: "m",
  name: "Slider 1",
  type: "slider",
  a: conn("A", "top"),
  b: conn("B", "bottom"),
  ...extra,
});
const withVars = (mate: Mate, vars: [string, string][]): AssemblyDoc => {
  let a: AssemblyDoc = { instances: [inst("A", { grounded: true }), inst("B")], mates: [mate], variables: [] };
  for (const [name, expression] of vars) {
    const r = addVariable(a);
    a = updateVariable(updateVariable(r.doc, r.id, "name", name), r.id, "expression", expression);
  }
  return a;
};
const bottomZ = (s: ReturnType<typeof solve>) => applyPoint(s.placements.get("B")!, [10, 10, 0])[2];

describe("assembly variables", () => {
  it("are added, edited and removed by the part document's helpers", () => {
    const a = withVars(slider(), [["lift", "12"]]);
    expect(a.variables.map((v) => [v.name, v.expression])).toEqual([["lift", "12"]]);
    expect(evaluateVariables(a.variables).scope).toEqual({ lift: 12 });
    expect(removeVariable(a, a.variables[0].id).variables).toEqual([]);
    // The rest of the assembly is carried through untouched.
    expect(removeVariable(a, a.variables[0].id).mates).toBe(a.mates);
  });

  it("drive a mate's value, through other variables too", () => {
    const a = withVars(slider({ values: { tz: "lift" } }), [
      ["base", "5"],
      ["lift", "base * 2 + 2"],
    ]);
    const s = solve(a, frameOf);
    expect(s.problems.size).toBe(0);
    expect(bottomZ(s)).toBeCloseTo(20 + 12, 9);
  });

  it("bound a mate's limits", () => {
    const a = withVars(slider({ values: { tz: "50" }, limits: { tz: { max: "stroke" } } }), [["stroke", "30"]]);
    expect(bottomZ(solve(a, frameOf))).toBeCloseTo(20 + 30, 9);
  });

  it("are flagged on the mate when one it names is missing", () => {
    const a = withVars(slider({ values: { tz: "nope" } }), []);
    expect(solve(a, frameOf).problems.get("m")).toMatch(/Bad value/);
  });

  it("drive a mate inside a loop group", () => {
    // A second slider alongside the first makes A–B a loop group; the
    // variable still sets where B sits.
    const a = withVars(slider({ values: { tz: "lift" } }), [["lift", "7"]]);
    a.mates.push({ ...slider(), id: "m2", name: "Slider 2" });
    const s = solve(a, frameOf);
    expect(s.loops).toHaveLength(1);
    expect(s.problems.size).toBe(0);
    expect(bottomZ(s)).toBeCloseTo(20 + 7, 6);
  });

  it("clamp a drag at a limit that names one", () => {
    const a = withVars(slider({ values: { tz: "0" }, limits: { tz: { max: "stroke" } } }), [["stroke", "8"]]);
    const before = solve(a, frameOf);
    const { next } = dragAssembly(a, before, frameOf, "B", translation([0, 0, 25]));
    expect(next!.mates[0].values?.tz).toBe("8");
  });
});
