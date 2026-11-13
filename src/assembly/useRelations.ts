// The Relation dialog's session (RelationDialog.tsx): a new relation or one
// being edited, as a draft. The draft's problem comes from solving the
// assembly with it applied, so the dialog says what the solver would (a loop
// of relations, a DOF already driven, a bad ratio) before it's added.
import { useMemo, useState } from "react";
import { evaluateVariables } from "../document/document";
import {
  addRelation,
  defaultDraft,
  nextRelationName,
  phaseToCurrentPose,
  relationBlocker,
  removeRelations,
  updateRelation,
  type RelationDraft,
} from "./relations";
import { alignRelation, alignTurn, gearRelationValue, placeGear, relationGears, type GearGeom } from "./gearMesh";
import { MATE_DOFS, solve } from "./solve";
import type { SourceState } from "./useAssemblySources";
import type { AssemblyDoc, Mat4, MateConnector, Relation } from "./types";

const DRAFT_ID = "__draft-relation";

export function useRelations({
  assembly,
  commit,
  frameFor,
  genId,
  sources,
}: {
  assembly: AssemblyDoc | null;
  /** Commit an edit (keeping the solve, as mate edits do); edits sharing a
   *  key coalesce into one undo step. */
  commit: (a: AssemblyDoc, coalesceKey?: string) => void;
  frameFor: (a: AssemblyDoc) => (c: MateConnector) => Mat4 | string;
  genId: () => string;
  /** The part documents, for the gears a relation's mates turn. */
  sources: ReadonlyMap<string, SourceState>;
}) {
  const [session, setSession] = useState<{ editingId: string | null; draft: RelationDraft } | null>(null);
  const mates = useMemo(
    () => (assembly?.mates ?? []).filter((m) => !m.suppressed && MATE_DOFS[m.type].length > 0),
    [assembly],
  );

  // Gears: a part a Gear feature made knows its teeth, so a gear relation
  // between two of them can take its ratio and direction from them and line
  // their teeth up (gearMesh.ts).
  const gearOf = (instanceId: string): GearGeom | null => {
    const inst = assembly?.instances.find((i) => i.id === instanceId);
    const src = inst ? sources.get(inst.source.docId) : undefined;
    return src?.status === "ready" ? (src.parts.find((p) => p.partId === inst!.source.partId)?.gear ?? null) : null;
  };
  const solveAt = (a: AssemblyDoc) => solve(a, frameFor(a));
  const sameEnd = (x: RelationDraft["driver"], y: RelationDraft["driver"]) =>
    x?.mateId === y?.mateId && x?.dof === y?.dof;
  /** `d` with the ratio and Reverse its two gears call for, and Align teeth
   *  on, when its ends are two gears and just changed (or it's new). A typed
   *  ratio is left alone while the ends stay the same. */
  const suggest = (d: RelationDraft, prev?: RelationDraft): RelationDraft => {
    if (!assembly || d.type !== "gear") return { ...d, align: undefined };
    if (prev && prev.type === d.type && sameEnd(prev.driver, d.driver) && sameEnd(prev.driven, d.driven)) return d;
    const g = gearRelationValue(assembly, d, gearOf, solveAt);
    return g ? { ...d, value: g.value, reverse: g.reverse, align: true } : { ...d, align: undefined };
  };
  /** The gears the draft's ends turn, named, and why their teeth can't be
   *  lined up (if they can't) — for the dialog. */
  const gears = useMemo(() => {
    if (!session || !assembly || session.draft.type !== "gear") return null;
    const pair = relationGears(assembly, session.draft, gearOf);
    if (!pair) return null;
    const name = (g: { instanceId: string; geom: GearGeom }) =>
      `${assembly.instances.find((i) => i.id === g.instanceId)?.name ?? "?"} (${g.geom.teeth} teeth${g.geom.internal ? ", ring" : ""})`;
    let problem: string | null = null;
    if (session.draft.align) {
      const s = solveAt(assembly);
      const at = (g: { instanceId: string; geom: GearGeom }) => {
        const m = s.placements.get(g.instanceId);
        return m ? placeGear(g.geom, m) : null;
      };
      const f = at(pair.driver);
      const m = at(pair.driven);
      const t = f && m ? alignTurn(f, m) : "The gears aren't placed yet.";
      problem = typeof t === "string" ? t : null;
    }
    return { label: `${name(pair.driver)} → ${name(pair.driven)}`, problem };
    // gearOf/solveAt read the sources and frames, which don't change while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, assembly]);

  const toRelation = (d: RelationDraft, id: string, name: string): Relation | null =>
    d.driver && d.driven
      ? {
          id,
          name,
          type: d.type,
          driver: d.driver,
          driven: d.driven,
          value: d.value,
          ...(d.reverse ? { reverse: true } : {}),
        }
      : null;

  const problem = useMemo(() => {
    if (!session || !assembly) return null;
    const { draft, editingId } = session;
    if (!draft.driver || !draft.driven) return "Choose the driver and the driven mate.";
    if (!draft.value.trim())
      return `Give the ${draft.type === "gear" ? "ratio" : draft.type === "rack" ? "radius" : "pitch"}.`;
    const id = editingId ?? DRAFT_ID;
    const rel = toRelation(draft, id, "")!;
    const trial = editingId ? updateRelation(assembly, rel) : addRelation(assembly, rel);
    return solve(trial, frameFor(trial)).relationProblems.get(id) ?? null;
    // frameFor reads the sources, which don't change while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, assembly]);

  const openNew = () => {
    if (!assembly) return;
    setSession({ editingId: null, draft: suggest(defaultDraft("gear", mates)) });
  };
  const openEdit = (id: string) => {
    const r = assembly?.relations?.find((x) => x.id === id);
    if (!r) return;
    setSession({
      editingId: id,
      draft: { type: r.type, driver: r.driver, driven: r.driven, value: r.value, reverse: !!r.reverse },
    });
  };
  const close = () => setSession(null);
  const confirm = () => {
    if (!session || !assembly || problem) return;
    const existing = session.editingId ? assembly.relations?.find((r) => r.id === session.editingId) : undefined;
    const rel = toRelation(
      session.draft,
      existing?.id ?? genId(),
      existing?.name ?? nextRelationName(assembly, session.draft.type),
    );
    if (!rel) return;
    let next: AssemblyDoc;
    if (existing) next = updateRelation(assembly, { ...existing, ...rel, name: existing.name });
    else {
      // A new relation starts from the pose on screen: the driven part stays
      // put, and turns from there.
      const values = solve(assembly, frameFor(assembly)).values;
      next = phaseToCurrentPose(
        addRelation(assembly, rel),
        rel.id,
        values,
        evaluateVariables(assembly.variables).scope,
      );
    }
    // …then, for two gears, turned the least way that meshes their teeth.
    if (session.draft.align && rel.type === "gear") {
      const aligned = alignRelation(next, rel.id, gearOf, solveAt);
      if (typeof aligned !== "string") next = aligned;
    }
    commit(next);
    setSession(null);
  };
  const remove = (id: string) => {
    if (!assembly) return;
    commit(removeRelations(assembly, [id]));
    if (session?.editingId === id) setSession(null);
  };
  const rename = (id: string, name: string) => {
    const r = assembly?.relations?.find((x) => x.id === id);
    if (assembly && r) commit(updateRelation(assembly, { ...r, name }), `asm-relation-name:${id}`);
  };

  return {
    dialog: session
      ? {
          editing: session.editingId !== null,
          draft: session.draft,
          mates,
          problem,
          gears,
          onChange: (draft: RelationDraft) => setSession((s) => (s ? { ...s, draft: suggest(draft, s.draft) } : s)),
          onConfirm: confirm,
          onCancel: close,
        }
      : null,
    editingId: session?.editingId ?? null,
    /** Why no relation can be made yet, or null if one can (relationBlocker). */
    relateBlocker: relationBlocker(mates),
    openNew,
    openEdit,
    close,
    remove,
    rename,
  };
}
