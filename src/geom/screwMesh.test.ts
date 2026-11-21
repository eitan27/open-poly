import { describe, expect, it } from "vitest";
import { newell, polyMeshEdgeProblems, polyMeshVolume, type PolyMesh } from "./polyMesh";
import { screwMesh } from "./screwMesh";
import { METRIC_SIZES } from "./metricFasteners";
import type { ScrewHead } from "../document/types";
import { DEFAULT_SCREW_SETTINGS, screwDims, screwProfile } from "../document/screw";
import { addScrew, createDocument, resolveDocument } from "../document/document";

/** Max distance of any vertex of a face (holes included) from its plane. */
function maxNonPlanarity(m: PolyMesh): number {
  let worst = 0;
  for (const f of m.faces) {
    const n = newell(m.vertices, f.loop);
    const len = Math.hypot(...n);
    const p = m.vertices[f.loop[0]];
    for (const loop of [f.loop, ...(f.holes ?? [])])
      for (const i of loop) {
        const q = m.vertices[i];
        worst = Math.max(worst, Math.abs(((q[0] - p[0]) * n[0] + (q[1] - p[1]) * n[1] + (q[2] - p[2]) * n[2]) / len));
      }
  }
  return worst;
}

const HEADS: ScrewHead[] = ["socket", "button", "flat", "hex", "set", "none"];

/** The resolved screw for a head/size/mode, through the document resolver. */
function resolved(head: ScrewHead, size: string, thread: "modelled" | "cosmetic", length = 12) {
  const settings = {
    ...DEFAULT_SCREW_SETTINGS,
    head,
    thread,
    size,
    params: { ...DEFAULT_SCREW_SETTINGS.params, length: String(length) },
  };
  const { doc, id } = addScrew(createDocument(), settings);
  const res = resolveDocument(doc);
  if (res.errors[id]) throw new Error(res.errors[id]);
  const r = res.features.find((f) => f.id === id);
  if (r?.type !== "screw") throw new Error("not a screw");
  return r;
}

describe("screwMesh", () => {
  for (const head of HEADS)
    for (const thread of ["modelled", "cosmetic"] as const)
      it(`${head}, ${thread}: every size is closed, outward and planar`, () => {
        for (const size of METRIC_SIZES) {
          const r = resolved(head, size, thread);
          const m = screwMesh(r);
          expect(polyMeshEdgeProblems(m), size).toBe(0);
          expect(maxNonPlanarity(m), size).toBeLessThan(1e-9);
          const v = polyMeshVolume(m);
          expect(v, size).toBeGreaterThan(0);
          // No more than a solid cylinder round the head plus one round the shank.
          const d = screwDims(head, size, 12);
          const R = Math.max(d.headDiameter / 2, d.d / 2) * 1.2;
          expect(v, size).toBeLessThan(Math.PI * R * R * (12 + d.headHeight + 1));
        }
      });

  it("a modelled screw's volume sits between its core and its cosmetic twin", () => {
    for (const head of HEADS) {
      const mod = polyMeshVolume(screwMesh(resolved(head, "M6", "modelled", 20)));
      const cos = polyMeshVolume(screwMesh(resolved(head, "M6", "cosmetic", 20)));
      expect(mod, head).toBeLessThan(cos);
      expect(mod, head).toBeGreaterThan(cos * 0.6);
    }
  });

  it("the socket is a hole in the top face, the thread a hole in the head's underside", () => {
    const m = screwMesh(resolved("socket", "M5", "modelled"));
    const top = m.faces.find((f) => f.name === "s0");
    expect(top?.holes?.length).toBe(1);
    expect(top?.holes?.[0].length).toBe(6);
    const seat = m.faces.find((f) => f.name === "seat");
    expect(seat?.holes?.length).toBe(1);
    expect(m.faces.some((f) => f.name === "threadStart")).toBe(false);
  });

  it("a set screw's socket goes into the thread's own end; a bare stud has none", () => {
    const set = screwMesh(resolved("set", "M4", "modelled"));
    expect(set.faces.find((f) => f.name === "threadStart")?.holes?.length).toBe(1);
    expect(set.faces.filter((f) => f.name.startsWith("socket/")).length).toBe(7);
    const stud = screwMesh(resolved("none", "M4", "modelled"));
    expect(stud.faces.find((f) => f.name === "threadStart")?.holes ?? []).toEqual([]);
    expect(stud.faces.some((f) => f.name.startsWith("socket/"))).toBe(false);
  });

  it("a button head is flat where the socket goes", () => {
    const p = screwProfile(screwDims("button", "M4", 10));
    expect(p[0][0]).toBe(0);
    expect(p[1][1]).toBe(p[0][1]);
  });
});
