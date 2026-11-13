// Relations: one mate's DOF driven by another's, linearly (docs/ASSEMBLY-PLAN.md,
// Motion). The driven DOF's value is its own, stored value — a phase, so gear
// teeth can be lined up — plus k times the driver's:
//
//   gear             rotation → rotation       k = −ratio (meshed gears turn opposite ways)
//   rack and pinion  rotation ↔ translation    k = r · π/180 mm per degree
//   screw            rotation ↔ translation    k = pitch / 360 mm per degree
//
// A rack or screw can be driven from either end: a translation driving a
// rotation uses 1/k. Reverse negates k.
//
// The solver applies relations once every mate's own value is known, in
// dependency order (a gear train), and a relation-driven DOF then counts as
// driven: inside a loop the loop follows it, as an expression's would. Moving
// a driven part — a drag, a typed value — moves its driver instead, so the
// relation keeps holding (routeToDriver).
import { evaluateExpression, type Scope } from "../document/expression";
import { formatValue, isDriven, isRotation, MATE_DOFS } from "./solve";
import type { AssemblyDoc, Dof, Mate, Relation, RelationType } from "./types";

export const RELATION_TYPES: {
  type: RelationType;
  label: string;
  /** What `value` is, with its unit. */
  valueLabel: string;
  title: string;
  defaultValue: string;
}[] = [
  {
    type: "gear",
    label: "Gear",
    valueLabel: "Ratio",
    title: "One rotation turns another: meshed gears, a belt. Ratio: driven turns per driver turn.",
    defaultValue: "1",
  },
  {
    type: "rack",
    label: "Rack",
    valueLabel: "Pinion radius (mm)",
    title: "Rack and pinion: a rotation moves a translation by the pinion's radius per radian.",
    defaultValue: "10",
  },
  {
    type: "screw",
    label: "Screw",
    valueLabel: "Pitch (mm per turn)",
    title: "A rotation moves a translation by the pitch per turn: a lead screw, a bolt.",
    defaultValue: "1",
  },
];

const relationsOf = (a: AssemblyDoc): Relation[] => a.relations ?? [];
const key = (mateId: string, dof: Dof) => `${mateId}:${dof}`;

/** The kinds of DOF a relation's ends must be: a gear's both rotations; a
 *  rack's or screw's one rotation and one translation, either way round. */
export function endsFit(type: RelationType, driver: Dof, driven: Dof): boolean {
  return type === "gear" ? isRotation(driver) && isRotation(driven) : isRotation(driver) !== isRotation(driven);
}

/** Driven units (mm or °) per driver unit. Throws on a bad expression or a
 *  value that can't be one (a zero radius, say). */
export function relationFactor(rel: Relation, scope: Scope): number {
  const v = evaluateExpression(rel.value, scope);
  if (!Number.isFinite(v) || v === 0) throw new Error(`${relationValueLabel(rel.type)} can't be ${v}.`);
  let perDegree: number;
  if (rel.type === "gear") perDegree = -v;
  else perDegree = rel.type === "rack" ? (v * Math.PI) / 180 : v / 360;
  // A translation driving a rotation: the other way round.
  const k = rel.type !== "gear" && !isRotation(rel.driver.dof) ? 1 / perDegree : perDegree;
  return rel.reverse ? -k : k;
}

export const relationValueLabel = (t: RelationType) => RELATION_TYPES.find((x) => x.type === t)!.valueLabel;

/** Why `rel` can't be applied, in words, or null when it can. `inUse` holds
 *  the mates the solver can use (not suppressed, both ends resolved). */
function relationProblem(
  rel: Relation,
  byId: ReadonlyMap<string, Mate>,
  inUse: (id: string) => boolean,
): string | null {
  const end = (e: Relation["driver"], what: string): string | null => {
    const m = byId.get(e.mateId);
    if (!m) return `Its ${what} mate was removed.`;
    if (!MATE_DOFS[m.type].includes(e.dof))
      return `${m.name} has no ${e.dof} to ${what === "driver" ? "drive it" : "drive"}.`;
    if (m.suppressed) return `${m.name} is suppressed.`;
    if (!inUse(m.id)) return `${m.name} isn't solved.`;
    return null;
  };
  const bad = end(rel.driver, "driver") ?? end(rel.driven, "driven");
  if (bad) return bad;
  if (rel.driver.mateId === rel.driven.mateId && rel.driver.dof === rel.driven.dof) return "It drives itself.";
  if (!endsFit(rel.type, rel.driver.dof, rel.driven.dof))
    return rel.type === "gear" ? "A gear couples two rotations." : "It couples a rotation and a translation.";
  const driven = byId.get(rel.driven.mateId)!;
  if (isDriven(driven, rel.driven.dof))
    return `${driven.name}'s ${rel.driven.dof} is set by "${driven.values![rel.driven.dof]}".`;
  return null;
}

/** Set every relation-driven DOF in `values` (each mate's own values, already
 *  evaluated), in dependency order. Returns the DOFs it set, per mate, and the
 *  relations that couldn't be applied, with why. `values` is changed in place. */
export function applyRelations(
  assembly: AssemblyDoc,
  values: Map<string, Partial<Record<Dof, number>>>,
  scope: Scope,
): { forced: Map<string, Dof[]>; problems: Map<string, string> } {
  const forced = new Map<string, Dof[]>();
  const problems = new Map<string, string>();
  const byId = new Map(assembly.mates.map((m) => [m.id, m]));
  const live = relationsOf(assembly).filter((r) => !r.suppressed);

  // Valid relations, one per driven DOF (a second is a conflict).
  const byDriven = new Map<string, Relation>();
  for (const r of live) {
    const bad = relationProblem(r, byId, (id) => values.has(id));
    if (bad) {
      problems.set(r.id, bad);
      continue;
    }
    const k = key(r.driven.mateId, r.driven.dof);
    const other = byDriven.get(k);
    if (other) {
      problems.set(r.id, `${other.name} already drives ${byId.get(r.driven.mateId)!.name}'s ${r.driven.dof}.`);
      continue;
    }
    byDriven.set(k, r);
  }

  // Depth-first from each driven DOF to its root driver; a DOF met again on
  // the way is a cycle, and every relation on it is left out.
  const state = new Map<string, "visiting" | "done" | "cycle">();
  const visit = (k: string): boolean => {
    const r = byDriven.get(k);
    if (!r) return true; // a root: its own value
    const s = state.get(k);
    if (s === "done") return true;
    if (s === "cycle") return false;
    if (s === "visiting") return false;
    state.set(k, "visiting");
    const ok = visit(key(r.driver.mateId, r.driver.dof));
    if (!ok) {
      state.set(k, "cycle");
      problems.set(r.id, "It's part of a loop of relations, which can't be solved.");
      return false;
    }
    let factor: number;
    try {
      factor = relationFactor(r, scope);
    } catch (e) {
      problems.set(r.id, `Bad ${relationValueLabel(r.type).toLowerCase()}: ${(e as Error).message}`);
      state.set(k, "cycle");
      return false;
    }
    const driver = values.get(r.driver.mateId)?.[r.driver.dof] ?? 0;
    const own = storedValue(byId.get(r.driven.mateId)!, r.driven.dof, scope);
    const v = { ...values.get(r.driven.mateId) };
    v[r.driven.dof] = own + factor * driver;
    values.set(r.driven.mateId, v);
    forced.set(r.driven.mateId, [...(forced.get(r.driven.mateId) ?? []), r.driven.dof]);
    state.set(k, "done");
    return true;
  };
  for (const k of byDriven.keys()) visit(k);
  return { forced, problems };
}

/** `a` with relation `relId`'s phase — its driven DOF's own stored value — set
 *  so that the relation, applied, leaves the driven part where `values` (the
 *  current solve) has it: phase = where it is − k × the driver. Without this a
 *  relation made or switched back on would turn the driven part to its old
 *  phase plus k times wherever the driver now is, undoing a tooth alignment
 *  done while it was off. `a` unchanged when the relation is suppressed, its
 *  driven value is an expression, or either end has no solved value. */
export function phaseToCurrentPose(
  a: AssemblyDoc,
  relId: string,
  values: ReadonlyMap<string, Partial<Record<Dof, number>>>,
  scope: Scope,
): AssemblyDoc {
  const r = relationsOf(a).find((x) => x.id === relId);
  if (!r || r.suppressed) return a;
  const driven = a.mates.find((m) => m.id === r.driven.mateId);
  if (!driven || isDriven(driven, r.driven.dof)) return a;
  const here = values.get(r.driven.mateId)?.[r.driven.dof];
  const driver = values.get(r.driver.mateId)?.[r.driver.dof];
  if (here === undefined || driver === undefined) return a;
  let factor: number;
  try {
    factor = relationFactor(r, scope);
  } catch {
    return a;
  }
  const phase = formatValue(here - factor * driver, isRotation(r.driven.dof));
  if (Number(driven.values?.[r.driven.dof] ?? 0) === Number(phase)) return a;
  const next: Mate = { ...driven, values: { ...driven.values, [r.driven.dof]: phase } };
  return { ...a, mates: a.mates.map((m) => (m.id === driven.id ? next : m)) };
}

/** A DOF's own stored value, not clamped to its limits: a driven DOF's phase. */
function storedValue(mate: Mate, dof: Dof, scope: Scope): number {
  const t = mate.values?.[dof]?.trim();
  if (!t) return 0;
  try {
    return evaluateExpression(t, scope);
  } catch {
    return 0;
  }
}

/** The relation driving `mateId`'s `dof`, if one does (valid or not). */
export function relationDriving(assembly: AssemblyDoc, mateId: string, dof: Dof): Relation | undefined {
  return relationsOf(assembly).find((r) => !r.suppressed && r.driven.mateId === mateId && r.driven.dof === dof);
}

/** Where to write a value of `mateId`'s `dof`: a DOF no relation drives is
 *  itself; a driven one is its driver, at the value that puts the driven DOF
 *  at `value` — followed back to the root of a gear train. An error when the root is an expression (a drag
 *  can't change it) or a relation's value can't be evaluated. */
export function routeToDriver(
  assembly: AssemblyDoc,
  mateId: string,
  dof: Dof,
  value: number,
  scope: Scope,
): { mateId: string; dof: Dof; value: number } | { error: string } {
  const seen = new Set<string>();
  let at = { mateId, dof, value };
  for (;;) {
    const k = key(at.mateId, at.dof);
    if (seen.has(k)) return { error: "A loop of relations drives it." };
    seen.add(k);
    const r = relationDriving(assembly, at.mateId, at.dof);
    if (!r) break;
    let factor: number;
    try {
      factor = relationFactor(r, scope);
    } catch (e) {
      return { error: `${r.name}: ${(e as Error).message}` };
    }
    const driven = assembly.mates.find((m) => m.id === at.mateId);
    const own = driven ? storedValue(driven, at.dof, scope) : 0;
    at = { mateId: r.driver.mateId, dof: r.driver.dof, value: (at.value - own) / factor };
  }
  const root = assembly.mates.find((m) => m.id === at.mateId);
  if (root && at.mateId !== mateId && isDriven(root, at.dof))
    return { error: `${root.name}'s ${at.dof} is set by "${root.values![at.dof]}", which drives it.` };
  return at;
}

/** "Gear 2": the type and the lowest number not taken. */
export function nextRelationName(a: AssemblyDoc, type: RelationType): string {
  const base = type === "rack" ? "Rack" : type === "gear" ? "Gear" : "Screw";
  const used = new Set(relationsOf(a).map((r) => r.name));
  for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function addRelation(a: AssemblyDoc, rel: Relation): AssemblyDoc {
  return { ...a, relations: [...relationsOf(a), rel] };
}

export function updateRelation(a: AssemblyDoc, rel: Relation): AssemblyDoc {
  if (!relationsOf(a).some((r) => r.id === rel.id)) return a;
  return { ...a, relations: relationsOf(a).map((r) => (r.id === rel.id ? rel : r)) };
}

export function removeRelations(a: AssemblyDoc, ids: string[]): AssemblyDoc {
  const drop = new Set(ids);
  const relations = relationsOf(a).filter((r) => !drop.has(r.id));
  return withRelations(a, relations);
}

/** `a` without the relations whose mates are gone: what removing mates or
 *  instances leaves. */
export function dropOrphanRelations(a: AssemblyDoc): AssemblyDoc {
  if (!a.relations) return a;
  const ids = new Set(a.mates.map((m) => m.id));
  const relations = a.relations.filter((r) => ids.has(r.driver.mateId) && ids.has(r.driven.mateId));
  return relations.length === a.relations.length ? a : withRelations(a, relations);
}

function withRelations(a: AssemblyDoc, relations: Relation[]): AssemblyDoc {
  if (relations.length) return { ...a, relations };
  const { relations: _drop, ...rest } = a;
  return rest;
}

/** The DOFs of `mate` a relation can use as `role`: any free one. */
export const relationDofs = (mate: Mate): Dof[] => MATE_DOFS[mate.type];

/** A relation being made or edited (RelationDialog): its ends may not be chosen yet. */
export interface RelationDraft {
  type: RelationType;
  driver: { mateId: string; dof: Dof } | null;
  driven: { mateId: string; dof: Dof } | null;
  value: string;
  reverse: boolean;
}

/** Why no relation can be made among `mates` (the movable, unsuppressed ones),
 *  or null if one can. A gear needs two mates that turn; a rack one that turns
 *  and another that slides; a screw the same, or one cylindrical mate on its
 *  own (its turn drives its slide). */
export function relationBlocker(mates: Mate[]): string | null {
  const turns = mates.filter((m) => MATE_DOFS[m.type].some(isRotation));
  const slides = mates.filter((m) => MATE_DOFS[m.type].some((d) => !isRotation(d)));
  if (turns.length >= 2) return null;
  if (mates.some((m) => m.type === "cylindrical")) return null;
  if (turns.length === 1 && slides.some((m) => m.id !== turns[0].id)) return null;
  if (mates.length === 0)
    return "Add two moving mates (e.g. revolute, slider) to enable the creation of a relation between them.";
  if (turns.length === 0) return "Relations need a mate that turns (revolute, cylindrical…) to drive or be driven.";
  return "Add a second mate that moves to relate it to the first.";
}

/** The draft a new relation of `type` starts as: the first two mates whose
 *  DOFs fit, or for a screw, a cylindrical mate's own turn and slide. */
export function defaultDraft(type: RelationType, mates: Mate[]): RelationDraft {
  const value = RELATION_TYPES.find((t) => t.type === type)!.defaultValue;
  const ends = mates.flatMap((m) => MATE_DOFS[m.type].map((d) => ({ mateId: m.id, dof: d })));
  if (type === "screw") {
    const c = mates.find((m) => m.type === "cylindrical");
    if (c)
      return { type, driver: { mateId: c.id, dof: "rz" }, driven: { mateId: c.id, dof: "tz" }, value, reverse: false };
  }
  for (const a of ends)
    for (const b of ends)
      if (a.mateId !== b.mateId && endsFit(type, a.dof, b.dof) && (type === "gear" || isRotation(a.dof)))
        return { type, driver: a, driven: b, value, reverse: false };
  return { type, driver: null, driven: null, value, reverse: false };
}

/** `a` with `mateId`'s `dof` set to `text` (empty: back to 0), as typing it
 *  in the Move panel does. A DOF a relation drives can't take its own value
 *  (that's its phase): its driver, followed back to the root of a gear train,
 *  is set to what puts it at the typed number instead — so the text must be a
 *  number there, not an expression. Why it can't be set, if it can't. */
export function setMateValue(
  a: AssemblyDoc,
  mateId: string,
  dof: Dof,
  text: string,
  scope: Scope,
): AssemblyDoc | { error: string } {
  const m = a.mates.find((x) => x.id === mateId);
  if (!m) return { error: `No mate "${mateId}".` };
  if (!MATE_DOFS[m.type].includes(dof))
    return {
      error: `${m.name} is ${m.type}: it leaves ${MATE_DOFS[m.type].join(", ") || "nothing"} free, not ${dof}.`,
    };
  const update = (mate: Mate, d: Dof, t: string): AssemblyDoc => {
    const values = { ...mate.values };
    if (t.trim()) values[d] = t;
    else delete values[d];
    const { values: _drop, ...rest } = mate;
    const next = Object.keys(values).length ? { ...rest, values } : rest;
    return { ...a, mates: a.mates.map((x) => (x.id === mate.id ? next : x)) };
  };
  if (!relationDriving(a, mateId, dof)) return update(m, dof, text);
  let v: number;
  try {
    v = text.trim() ? evaluateExpression(text, scope) : 0;
  } catch (e) {
    return { error: `Not a number: ${(e as Error).message}` };
  }
  const r = routeToDriver(a, mateId, dof, v, scope);
  if ("error" in r) return r;
  const root = a.mates.find((x) => x.id === r.mateId);
  if (!root) return { error: `No mate "${r.mateId}".` };
  return update(root, r.dof, formatValue(r.value, isRotation(r.dof)));
}
