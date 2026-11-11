// What the agent's assembly ops do to an assembly, as pure functions: each
// checks its op against the open assembly and its loaded parts and returns
// the assembly to commit, or why it can't. commands.ts commits the result
// through the assembly's undo setter and waits for it to solve.
//
// A mate made here is the one the Mate dialog would make from the same clicks:
// connectors are named, but carry the fingerprint a pick stores
// (connectorRefByName), so they're re-found the same way after a part edit.
import {
  addMate,
  insertInstances,
  keepSolved,
  nextMateName,
  removeInstances,
  removeMates,
  updateInstance,
} from "../assembly/assembly";
import { removeRelations } from "../assembly/relations";
import {
  anchorsOf,
  connectorRefByName,
  midplaneShape,
  type ConnectorRef,
  type ConnectorShape,
} from "../assembly/frames";
import { INSERT_GAP_MM, insertShift, meshBounds, translation } from "../assembly/placement";
import { MATE_DOFS } from "../assembly/solve";
import type { AssemblyDoc, Dof, Mate, MateConnector } from "../assembly/types";
import type { SourcePart, SourceState } from "../assembly/useAssemblySources";
import type { ShapeMeshPayload } from "../kernel/types";
import { placedBoundsOf, type AssemblyAgentState } from "./assemblySummary";
import type { ConnectorSpec, Operation } from "./operations";

type Planned<T> = T | { error: string };
const fail = (error: string) => ({ error });

/** The parts of `source` an insert places: all, or the ids asked for. */
function partsToInsert(source: SourceState, docId: string, partIds?: string[]): Planned<SourcePart[]> {
  if (source.status === "missing")
    return fail(`No part document "${docId}" — get ids (kind: part) from list_documents.`);
  if (source.status === "error") return fail(`${source.name}: ${source.message}`);
  if (source.status !== "ready") return fail(`${"name" in source ? source.name : docId} isn't built yet.`);
  if (!source.parts.length) return fail(`${source.name} has no parts to insert.`);
  if (!partIds) return source.parts;
  const unknown = partIds.filter((id) => !source.parts.some((p) => p.partId === id));
  if (unknown.length)
    return fail(
      `${source.name} has no part ${unknown.map((u) => `"${u}"`).join(", ")}; its parts are ${source.parts.map((p) => `"${p.partId}" (${p.name})`).join(", ")}.`,
    );
  return source.parts.filter((p) => partIds.includes(p.partId));
}

export function planInsert(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "insertInstance" }>,
  source: SourceState,
  genId: () => string,
): Planned<{ assembly: AssemblyDoc; ids: string[] }> {
  const parts = partsToInsert(source, op.documentId, op.partIds);
  if ("error" in parts) return parts;
  if (op.name && parts.length > 1) return fail("A name can be given only when inserting one part.");
  // Where everything is now, so the insert lands past it (as the Insert dialog
  // does), unless a position is given.
  const placed = state.assembly.instances
    .filter((i) => !i.hidden)
    .map((i) => {
      const mesh = meshOf(state, i.id);
      return mesh ? (placedBoundsOf(mesh, state.solution?.placements.get(i.id) ?? i.transform) ?? null) : null;
    });
  const transform = op.position
    ? translation(op.position)
    : translation([
        insertShift(
          placed,
          parts.map((p) => meshBounds(p.mesh)),
          INSERT_GAP_MM,
        ),
        0,
        0,
      ]);
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  let r = insertInstances(
    base,
    op.documentId,
    parts.map((p) => ({ partId: p.partId, name: p.name, transform })),
    genId,
  );
  if (op.name) r = { ...r, assembly: updateInstance(r.assembly, r.ids[0], { name: op.name }) };
  return r;
}

export function planGround(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "groundInstance" }>,
): Planned<AssemblyDoc> {
  const inst = state.assembly.instances.find((i) => i.id === op.instanceId);
  if (!inst) return fail(`No instance "${op.instanceId}" — ids are in get_scene_summary's instances.`);
  // From where the solver has it, so grounding fixes it where it's shown.
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  return updateInstance(base, inst.id, { grounded: op.grounded ?? true });
}

/** The mesh of an instance's part, if it has loaded. */
function meshOf(state: AssemblyAgentState, instanceId: string): ShapeMeshPayload | undefined {
  const inst = state.assembly.instances.find((i) => i.id === instanceId);
  const src = inst ? state.sources.get(inst.source.docId) : undefined;
  return src?.status === "ready" ? src.parts.find((p) => p.partId === inst!.source.partId)?.mesh : undefined;
}

/** One side of a mate, from its spec: the named entity resolved on the
 *  instance's part, with its fingerprint. */
function connectorOf(
  state: AssemblyAgentState,
  spec: ConnectorSpec,
  side: "a" | "b",
  width: boolean,
): Planned<MateConnector> {
  const inst = state.assembly.instances.find((i) => i.id === spec.instanceId);
  if (!inst) return fail(`${side}: no instance "${spec.instanceId}" — ids are in get_scene_summary's instances.`);
  const mesh = meshOf(state, inst.id);
  if (!mesh) return fail(`${side}: ${inst.name}'s part isn't loaded (see get_scene_summary's parts).`);
  const given = [spec.face, spec.edge, spec.vertex].filter((x) => x !== undefined).length;
  if (given !== 1) return fail(`${side}: give exactly one of face, edge or vertex.`);
  const by =
    spec.face !== undefined
      ? { face: spec.face }
      : spec.edge !== undefined
        ? { edge: spec.edge }
        : { vertex: spec.vertex! };
  const r = connectorRefByName(mesh, by);
  if (typeof r === "string") return fail(`${side}: ${r} Its names are in get_scene_summary's parts.`);
  let shape: ConnectorShape = r.shape;
  let ref2: ConnectorRef | undefined;
  if (width) {
    if (spec.face === undefined || spec.face2 === undefined)
      return fail(`${side}: a width mate needs two parallel faces on each part (face and face2).`);
    const r2 = connectorRefByName(mesh, { face: spec.face2 });
    if (typeof r2 === "string") return fail(`${side}: ${r2}`);
    const mid = r.shape.kind === "plane" && r2.shape.kind === "plane" ? midplaneShape(r.shape, r2.shape) : null;
    if (!mid) return fail(`${side}: a width mate's two faces must be flat and parallel.`);
    shape = mid;
    ref2 = r2.ref;
  } else if (spec.face2 !== undefined) return fail(`${side}: face2 is only for a width mate.`);
  const anchor = spec.anchor ?? "center";
  if (!anchorsOf(shape).includes(anchor))
    return fail(`${side}: "${anchor}" isn't an anchor here; it offers ${anchorsOf(shape).join(", ")}.`);
  const offset = Object.fromEntries(Object.entries(spec.offset ?? {}).filter(([, v]) => v !== undefined && v.trim()));
  return {
    instanceId: inst.id,
    ref: r.ref,
    ...(ref2 ? { ref2 } : {}),
    anchor,
    ...(Object.keys(offset).length ? { offset } : {}),
  };
}

export function planMate(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "addMate" }>,
  genId: () => string,
): Planned<{ assembly: AssemblyDoc; id: string }> {
  if (op.a.instanceId === op.b.instanceId) return fail("A mate joins two different instances.");
  const width = op.type === "width";
  const a = connectorOf(state, op.a, "a", width);
  if ("error" in a) return a;
  const b = connectorOf(state, op.b, "b", width);
  if ("error" in b) return b;
  const free = MATE_DOFS[op.type];
  const notFree = (rec?: Partial<Record<Dof, unknown>>) =>
    Object.keys(rec ?? {}).filter((d) => !free.includes(d as Dof));
  const bad = [...notFree(op.values), ...notFree(op.limits)];
  if (bad.length)
    return fail(
      `A ${op.type} mate leaves ${free.length ? free.join(", ") : "nothing"} free, not ${[...new Set(bad)].join(", ")}.`,
    );
  const id = genId();
  const mate: Mate = {
    id,
    name: op.name ?? nextMateName(state.assembly, op.type),
    type: op.type,
    a,
    b,
    ...(op.values && Object.keys(op.values).length ? { values: op.values } : {}),
    ...(op.limits && Object.keys(op.limits).length ? { limits: op.limits } : {}),
    ...(op.flip ? { flip: true } : {}),
    ...(op.turns ? { turns: op.turns } : {}),
  };
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  return { assembly: addMate(base, mate), id };
}

/** Delete an instance (and the mates and relations that used it), a mate (and
 *  its relations) or a relation, by id. What's left stays where it is. */
export function planDelete(state: AssemblyAgentState, id: string): Planned<AssemblyDoc> {
  const a = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  if (a.instances.some((i) => i.id === id)) return removeInstances(a, [id]);
  if (a.mates.some((m) => m.id === id)) return removeMates(a, [id]);
  if (a.relations?.some((r) => r.id === id)) return removeRelations(a, [id]);
  return fail(`No instance, mate or relation "${id}" — ids are in get_scene_summary.`);
}
