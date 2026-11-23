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
  setSuppressed,
  updateInstance,
  updateMate,
} from "../assembly/assembly";
import {
  addRelation,
  endsFit,
  nextRelationName,
  phaseToCurrentPose,
  removeRelations,
  setMateValue,
  updateRelation,
} from "../assembly/relations";
import { evaluateVariables, setVariableByName } from "../document/document";
import {
  anchorsOf,
  connectorRefByName,
  midplaneShape,
  type ConnectorRef,
  type ConnectorShape,
} from "../assembly/frames";
import { multiply, translation } from "../assembly/placement";
import { duplicateInstances, insertLayout } from "../assembly/copies";
import { MATE_DOFS, solve, type Solution } from "../assembly/solve";
import { alignRelation, gearOfIn, gearRelationValue, rackRelationValue, type GearGeom } from "../assembly/gearMesh";
import { placeRack, RACK_PLACED_TOL, rackOffBy, rackTravelLimits, withTravelLimits } from "../assembly/rackPlace";
import { planLoopInput } from "../assembly/loopInput";
import type { AssemblyDoc, Dof, Mat4, Mate, MateConnector, Relation } from "../assembly/types";
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
  const count = op.count ?? 1;
  if (op.name && (parts.length > 1 || count > 1))
    return fail("A name can be given only when inserting one part, once.");
  // Where everything is now, so the insert lands past it (as the Insert dialog
  // does), unless a position is given.
  const placed = state.assembly.instances
    .filter((i) => !i.hidden)
    .map((i) => {
      const mesh = meshOf(state, i.id);
      return mesh ? (placedBoundsOf(mesh, state.solution?.placements.get(i.id) ?? i.transform) ?? null) : null;
    });
  // Laid out as the Insert dialog does (copies.ts); with a position, the
  // layout starts where the part was modelled and moves there.
  const picks = parts.map((p) => ({ partId: p.partId, name: p.name, mesh: p.mesh, count }));
  const layout = op.position
    ? insertLayout([], picks).map((l) => ({ ...l, transform: multiply(translation(op.position!), l.transform) }))
    : insertLayout(placed, picks);
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  let r = insertInstances(base, op.documentId, layout, genId);
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
  const bad = notFreeIn(op.type, op.values, op.limits);
  if (bad) return fail(bad);
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

export function planSetMateValue(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "setMateValue" }>,
  frameOf: (c: MateConnector) => Mat4 | string,
): Planned<AssemblyDoc> {
  const a = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  if (!a.mates.some((m) => m.id === op.mateId))
    return fail(`No mate "${op.mateId}" — ids are in get_scene_summary's mates.`);
  const scope = evaluateVariables(a.variables).scope;
  // Inside a loop group the value drives (loopInput.ts); clearing an
  // expression in its way needs clearExpressions, as the UI needs Continue.
  if (state.solution) {
    const p = planLoopInput(a, state.solution, frameOf, scope, [{ mateId: op.mateId, dof: op.dof, text: op.value }]);
    if (p && "clears" in p && !op.clearExpressions)
      return fail(`${p.message} Ask the user, then call set_mate_value again with clearExpressions: true to go ahead.`);
    if (p) return "error" in p ? p : p.next;
  }
  return setMateValue(a, op.mateId, op.dof, op.value, scope);
}

export function planAddRelation(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "addRelation" }>,
  genId: () => string,
  frameOf: (c: MateConnector) => Mat4 | string,
): Planned<{ assembly: AssemblyDoc; id: string; note?: string }> {
  const bad = relationEndsProblem(state.assembly, op.type, op.driver, op.driven);
  if (bad) return fail(bad);
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  const gearOf = gearOfIn(base, state.sources);
  const solveAt = (a: AssemblyDoc) => solve(a, frameOf);
  const ends = { driver: op.driver, driven: op.driven };
  const notes: string[] = [];

  // The value and direction from gear parts, when there are some.
  let value = op.value === undefined ? undefined : String(op.value);
  let reverse = op.reverse;
  const fromTeeth =
    op.type === "gear"
      ? gearRelationValue(base, ends, gearOf, solveAt)
      : op.type === "rack"
        ? rackRelationValue(base, ends, gearOf, solveAt)
        : null;
  if (fromTeeth) {
    if (value === undefined) {
      value = fromTeeth.value;
      notes.push(`${op.type === "gear" ? "Ratio" : "Pinion radius"} ${value} from the teeth.`);
    }
    if (reverse === undefined) reverse = fromTeeth.reverse;
  }
  if (value === undefined || !value.trim())
    return fail(
      `Give a value: the ${op.type === "gear" ? "ratio" : op.type === "rack" ? "pinion radius" : "pitch"} — it comes from the teeth only when both ends move Gear feature parts${op.type === "rack" ? " (a spur gear on the turning mate, a rack on the sliding one)" : ""}.`,
    );

  const id = genId();
  const rel: Relation = {
    id,
    name: op.name ?? nextRelationName(state.assembly, op.type),
    type: op.type,
    driver: op.driver,
    driven: op.driven,
    value,
    ...(reverse ? { reverse: true } : {}),
  };
  const r = meshRelation(base, rel, "add", op, !!fromTeeth, gearOf, solveAt, state.solution !== null);
  if ("error" in r) return r;
  notes.push(...r.notes);
  return { assembly: r.assembly, id, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

/** Add (or put back, edited) `rel`, with what a gear pair's dialog does:
 *  for a rack, move it to the pinion first; start from the pose on screen;
 *  align the teeth; for a rack, limit the driver to its teeth. Each step
 *  defaults on for a new relation between gear parts (`gearParts`), and only
 *  when asked for an edited one. Steps that can't happen say why in `notes`. */
function meshRelation(
  base: AssemblyDoc,
  rel: Relation,
  how: "add" | "edit",
  op: { alignTeeth?: boolean; placeRack?: boolean; limitToRack?: boolean },
  gearParts: boolean,
  gearOf: (instanceId: string) => GearGeom | null,
  solveAt: (a: AssemblyDoc) => Solution,
  solved: boolean,
): Planned<{ assembly: AssemblyDoc; notes: string[] }> {
  const notes: string[] = [];
  const dflt = how === "add" && gearParts;
  const rack = rel.type === "rack";
  let a = base;
  if (rack && (op.placeRack ?? dflt)) {
    const off = rackOffBy(a, rel, gearOf, solveAt);
    if (typeof off === "number" && Math.abs(off) >= RACK_PLACED_TOL) {
      const placed = placeRack(a, rel, gearOf, solveAt);
      if (typeof placed === "string") notes.push(`Not placed: ${placed}`);
      else {
        a = placed;
        notes.push(
          `Moved the rack ${Math.abs(off).toFixed(2)} mm to the gear's pitch distance (its mate's connector offset).`,
        );
      }
    } else if (typeof off === "string") notes.push(`Not placed: ${off}`);
  }
  if (how === "add") {
    const added = addRelation(a, rel);
    // It starts from the pose the parts are in (as the dialog's does).
    a = solved ? phaseToCurrentPose(added, rel.id, solveAt(a).values, evaluateVariables(a.variables).scope) : added;
  } else a = updateRelation(a, rel);
  if (rel.type !== "screw" && (op.alignTeeth ?? dflt)) {
    const aligned = alignRelation(a, rel.id, gearOf, solveAt);
    if (typeof aligned === "string") notes.push(`Teeth not aligned: ${aligned}`);
    else a = aligned;
  }
  if (rack) {
    const driverLimited = !!a.mates.find((m) => m.id === rel.driver.mateId)?.limits?.[rel.driver.dof];
    if (op.limitToRack ?? (dflt && !driverLimited)) {
      const lim = rackTravelLimits(a, rel.id, gearOf, solveAt);
      if (typeof lim === "string") notes.push(`No travel limits: ${lim}`);
      else {
        a = withTravelLimits(a, lim);
        notes.push(`Limited the driver to ${lim.min}…${lim.max} so the gear stays on the rack.`);
      }
    }
  }
  return { assembly: a, notes };
}

export function planSetVariable(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "setVariable" }>,
): Planned<{ assembly: AssemblyDoc; id: string }> {
  const r = setVariableByName(state.assembly, op.name, op.expression);
  return "error" in r ? r : { assembly: r.doc, id: r.id };
}

/** Why `values`/`limits` name a DOF a mate of `type` doesn't leave free, or
 *  null when they don't. */
function notFreeIn(type: Mate["type"], ...recs: (Partial<Record<Dof, unknown>> | undefined)[]): string | null {
  const free = MATE_DOFS[type];
  const bad = [...new Set(recs.flatMap((r) => Object.keys(r ?? {})).filter((d) => !free.includes(d as Dof)))];
  return bad.length
    ? `A ${type} mate leaves ${free.length ? free.join(", ") : "nothing"} free, not ${bad.join(", ")}.`
    : null;
}

/** Why a relation of `type` can't join these ends, or null when it can. */
function relationEndsProblem(
  a: AssemblyDoc,
  type: Relation["type"],
  driver: Relation["driver"],
  driven: Relation["driven"],
): string | null {
  for (const [role, end] of [
    ["driver", driver],
    ["driven", driven],
  ] as const) {
    const m = a.mates.find((x) => x.id === end.mateId);
    if (!m) return `${role}: no mate "${end.mateId}" — ids are in get_scene_summary's mates.`;
    if (!MATE_DOFS[m.type].includes(end.dof))
      return `${role}: ${m.name} is ${m.type}; it leaves ${MATE_DOFS[m.type].join(", ") || "nothing"} free, not ${end.dof}.`;
  }
  if (!endsFit(type, driver.dof, driven.dof))
    return type === "gear"
      ? "A gear couples two rotations (rx/ry/rz)."
      : `A ${type} couples a rotation and a translation (rz with tz, say).`;
  return null;
}

/** `rec` with `patch` merged in, keeping only the DOFs in `keep`: a key the
 *  patch sets to null (or, for a string, to "") is removed. Undefined when
 *  nothing is left. */
function merged<V>(
  rec: Partial<Record<Dof, V>> | undefined,
  patch: Partial<Record<Dof, V | null>> | undefined,
  keep: readonly Dof[],
): Partial<Record<Dof, V>> | undefined {
  const out: Partial<Record<Dof, V>> = {};
  for (const [d, v] of Object.entries({ ...rec, ...patch }) as [Dof, V | null | undefined][]) {
    if (v === null || v === undefined || (typeof v === "string" && !v.trim())) continue;
    if (keep.includes(d)) out[d] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function planEditMate(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "editMate" }>,
): Planned<{ assembly: AssemblyDoc; dropped: Dof[] }> {
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  const old = base.mates.find((m) => m.id === op.mateId);
  if (!old) return fail(`No mate "${op.mateId}" — ids are in get_scene_summary's mates.`);
  const type = op.type ?? old.type;
  const width = type === "width";
  // A side given again is resolved as add_mate's are; a side kept must still
  // suit the type: a width mate needs its second face, any other drops it.
  const side = (spec: ConnectorSpec | undefined, cur: MateConnector, which: "a" | "b"): Planned<MateConnector> => {
    if (spec) return connectorOf(state, spec, which, width);
    if (width && !cur.ref2)
      return fail(
        `${which}: a width mate needs two parallel faces on each part — give ${which} again with face and face2.`,
      );
    if (!width && cur.ref2) {
      const { ref2: _ref2, ...rest } = cur;
      return rest;
    }
    return cur;
  };
  const a = side(op.a, old.a, "a");
  if ("error" in a) return a;
  const b = side(op.b, old.b, "b");
  if ("error" in b) return b;
  if (a.instanceId === b.instanceId) return fail("A mate joins two different instances.");
  // Values and limits given must be the new type's; old ones it lacks go.
  const bad = notFreeIn(type, op.values, op.limits);
  if (bad) return fail(bad);
  const free = MATE_DOFS[type];
  const dropped = [...new Set([...Object.keys(old.values ?? {}), ...Object.keys(old.limits ?? {})] as Dof[])].filter(
    (d) => !free.includes(d),
  );
  const values = merged(old.values, op.values, free);
  const limits = merged(old.limits, op.limits, free);
  const flip = op.flip ?? !!old.flip;
  const turns = op.turns ?? old.turns ?? 0;
  const { values: _v, limits: _l, flip: _f, turns: _t, ...rest } = old;
  const mate: Mate = {
    ...rest,
    type,
    name: op.name ?? old.name,
    a,
    b,
    ...(values ? { values } : {}),
    ...(limits ? { limits } : {}),
    ...(flip ? { flip: true } : {}),
    ...(turns ? { turns } : {}),
  };
  return { assembly: updateMate(base, mate), dropped };
}

export function planEditRelation(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "editRelation" }>,
  frameOf: (c: MateConnector) => Mat4 | string,
): Planned<{ assembly: AssemblyDoc; note?: string }> {
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  const old = base.relations?.find((r) => r.id === op.relationId);
  if (!old) return fail(`No relation "${op.relationId}" — ids are in get_scene_summary's relations.`);
  const type = op.type ?? old.type;
  const driver = op.driver ?? old.driver;
  const driven = op.driven ?? old.driven;
  const bad = relationEndsProblem(base, type, driver, driven);
  if (bad) return fail(bad);
  const value = op.value === undefined ? old.value : String(op.value);
  if (!value.trim()) return fail("A relation needs a value: its ratio, radius or pitch.");
  const reverse = op.reverse ?? !!old.reverse;
  const { reverse: _r, ...rest } = old;
  const rel: Relation = {
    ...rest,
    type,
    name: op.name ?? old.name,
    driver,
    driven,
    value,
    ...(reverse ? { reverse: true } : {}),
  };
  const gearOf = gearOfIn(base, state.sources);
  const r = meshRelation(base, rel, "edit", op, false, gearOf, (a) => solve(a, frameOf), state.solution !== null);
  if ("error" in r) return r;
  return { assembly: r.assembly, ...(r.notes.length ? { note: r.notes.join(" ") } : {}) };
}

export function planSuppress(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "setSuppressed" }>,
): Planned<AssemblyDoc> {
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  const next = setSuppressed(base, op.id, op.suppressed ?? true);
  if (!next) return fail(`No mate or relation "${op.id}" — ids are in get_scene_summary's mates and relations.`);
  // A relation switched back on starts from the pose on screen.
  const wasOff = state.assembly.relations?.find((r) => r.id === op.id)?.suppressed;
  return wasOff && op.suppressed === false && state.solution
    ? phaseToCurrentPose(next, op.id, state.solution.values, evaluateVariables(next.variables).scope)
    : next;
}

export function planDuplicate(
  state: AssemblyAgentState,
  op: Extract<Operation, { op: "duplicateInstance" }>,
  genId: () => string,
): Planned<{ assembly: AssemblyDoc; ids: string[] }> {
  const missing = op.instanceIds.filter((id) => !state.assembly.instances.some((i) => i.id === id));
  if (missing.length)
    return fail(`No instance ${missing.map((m) => `"${m}"`).join(", ")} — ids are in get_scene_summary's instances.`);
  const base = state.solution ? keepSolved(state.assembly, state.solution) : state.assembly;
  const r = duplicateInstances(
    base,
    op.instanceIds,
    op.count ?? 1,
    (id) => base.instances.find((i) => i.id === id)!.transform,
    (id) => meshOf(state, id),
    genId,
  );
  return r.ids.length ? r : fail("Nothing to duplicate: the instances' parts haven't loaded.");
}
