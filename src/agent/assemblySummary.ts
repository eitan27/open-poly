// The scene summary of an open assembly, for the agent: its parts (with the
// face and edge names a mate's connector can use, listed once per part however
// many instances use it), instances, mates with what each leaves free,
// relations, loop groups and problems. Pure: built from the assembly, its
// solution and its sources, so it's testable without the app.
import { evaluateVariables } from "../document/document";
import type { ShapeMeshPayload } from "../kernel/types";
import { dofLabel } from "../assembly/mateTypes";
import { applyPoint } from "../assembly/placement";
import { relationDriving } from "../assembly/relations";
import { isDriven, MATE_DOFS, type Solution } from "../assembly/solve";
import type { AssemblyDoc, Mat4, MateConnector } from "../assembly/types";
import type { SourceState } from "../assembly/useAssemblySources";
import type { AssemblyConnectorSummary, AssemblySummary } from "./operations";

export interface AssemblyAgentState {
  assembly: AssemblyDoc;
  /** Null until the assembly's sources have loaded enough to solve. */
  solution: Solution | null;
  sources: ReadonlyMap<string, SourceState>;
  /** Mates whose connector was re-found by fingerprint, and what to check. */
  warnings: ReadonlyMap<string, string>;
  /** Selected instance ids. */
  selection: string[];
}

export const partKey = (docId: string, partId: string) => `${docId}/${partId}`;

/** The distinct names in a mesh's face or edge groups, in order. */
const names = (groups: { name?: string }[] | undefined): string[] => [
  ...new Set((groups ?? []).map((g) => g.name).filter((n): n is string => !!n)),
];

/** World bounds of `mesh` placed at `m`: its local box's corners, moved. */
function placedBounds(mesh: ShapeMeshPayload, m: Mat4): AssemblySummary["instances"][number]["bbox"] {
  const v = mesh.faces.vertices;
  if (!v.length) return undefined;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[i + k]);
      hi[k] = Math.max(hi[k], v[i + k]);
    }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [lo[0], hi[0]])
    for (const y of [lo[1], hi[1]])
      for (const z of [lo[2], hi[2]]) {
        const p = applyPoint(m, [x, y, z]);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], p[k]);
          max[k] = Math.max(max[k], p[k]);
        }
      }
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { min: min.map(r) as typeof min, max: max.map(r) as typeof max };
}

const connector = (c: MateConnector): AssemblyConnectorSummary => ({
  instanceId: c.instanceId,
  kind: c.ref.kind,
  name: c.ref.name,
  ...(c.ref2 ? { name2: c.ref2.name } : {}),
  anchor: c.anchor,
  ...(c.offset && Object.keys(c.offset).length ? { offset: c.offset } : {}),
});

const sourceProblem = (s: SourceState | undefined, partId: string): string | undefined => {
  if (!s || s.status === "loading") return "Still loading.";
  if (s.status === "building") return "Still building.";
  if (s.status === "missing") return "Its document was deleted.";
  if (s.status === "error") return s.message;
  return s.parts.some((p) => p.partId === partId) ? undefined : `No longer a part of ${s.name}.`;
};

export function assemblySummary(state: AssemblyAgentState, info: { id: string; name: string }): AssemblySummary {
  const { assembly, solution, sources, warnings } = state;
  const resolved = evaluateVariables(assembly.variables);
  const round = (n: number) => Math.round(n * 1000) / 1000;

  const parts: AssemblySummary["parts"] = [];
  const seen = new Set<string>();
  for (const i of assembly.instances) {
    const key = partKey(i.source.docId, i.source.partId);
    if (seen.has(key)) continue;
    seen.add(key);
    const src = sources.get(i.source.docId);
    const part = src?.status === "ready" ? src.parts.find((p) => p.partId === i.source.partId) : undefined;
    const problem = sourceProblem(src, i.source.partId);
    parts.push({
      key,
      documentId: i.source.docId,
      ...(src && "name" in src ? { documentName: src.name } : {}),
      partId: i.source.partId,
      ...(part
        ? { name: part.name, faces: names(part.mesh.faces.faceGroups), edges: names(part.mesh.edges.edgeGroups) }
        : {}),
      ...(problem ? { problem } : {}),
    });
  }

  const instances: AssemblySummary["instances"] = assembly.instances.map((i) => {
    const src = sources.get(i.source.docId);
    const part = src?.status === "ready" ? src.parts.find((p) => p.partId === i.source.partId) : undefined;
    const at = solution?.placements.get(i.id) ?? i.transform;
    return {
      id: i.id,
      name: i.name,
      part: partKey(i.source.docId, i.source.partId),
      ...(i.grounded ? { grounded: true } : {}),
      ...(i.hidden ? { hidden: true } : {}),
      ...(solution?.mated.has(i.id) ? { mated: true } : {}),
      ...(part ? { bbox: placedBounds(part.mesh, at) } : {}),
    };
  });

  const mates: AssemblySummary["mates"] = assembly.mates.map((m) => {
    const values = solution?.values.get(m.id) ?? {};
    const problem = solution?.problems.get(m.id);
    const warning = warnings.get(m.id);
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      a: connector(m.a),
      b: connector(m.b),
      ...(m.flip ? { flip: true } : {}),
      ...(m.turns ? { turns: m.turns } : {}),
      free: MATE_DOFS[m.type].map((d) => {
        const lim = m.limits?.[d];
        const rel = relationDriving(assembly, m.id, d);
        return {
          dof: d,
          label: dofLabel(m.type, d),
          value: round(values[d] ?? 0),
          ...(isDriven(m, d) ? { expression: m.values![d]!.trim() } : {}),
          ...(rel ? { drivenBy: rel.id } : {}),
          ...(lim?.min?.trim() ? { min: lim.min } : {}),
          ...(lim?.max?.trim() ? { max: lim.max } : {}),
        };
      }),
      ...(m.suppressed ? { suppressed: true } : {}),
      ...(problem ? { problem } : {}),
      ...(!problem && warning ? { warning } : {}),
    };
  });

  const relations: AssemblySummary["relations"] = (assembly.relations ?? []).map((r) => {
    const problem = solution?.relationProblems.get(r.id);
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      driver: r.driver,
      driven: r.driven,
      value: r.value,
      ...(r.reverse ? { reverse: true } : {}),
      ...(r.suppressed ? { suppressed: true } : {}),
      ...(problem ? { problem } : {}),
    };
  });

  return {
    kind: "assembly",
    documentId: info.id,
    documentName: info.name,
    parts,
    instances,
    mates,
    relations,
    loops: (solution?.loops ?? []).map((l) => ({ instanceIds: [...l.free], mateIds: [...l.mateIds] })),
    variables: assembly.variables.map((v) => ({
      name: v.name,
      expression: v.expression,
      value: resolved.scope[v.name],
    })),
    selection: state.selection,
  };
}
