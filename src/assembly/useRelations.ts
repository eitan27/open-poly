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
import { MATE_DOFS, solve } from "./solve";
import type { AssemblyDoc, Mat4, MateConnector, Relation } from "./types";

const DRAFT_ID = "__draft-relation";

export function useRelations({
  assembly,
  commit,
  frameFor,
  genId,
}: {
  assembly: AssemblyDoc | null;
  /** Commit an edit (keeping the solve, as mate edits do); edits sharing a
   *  key coalesce into one undo step. */
  commit: (a: AssemblyDoc, coalesceKey?: string) => void;
  frameFor: (a: AssemblyDoc) => (c: MateConnector) => Mat4 | string;
  genId: () => string;
}) {
  const [session, setSession] = useState<{ editingId: string | null; draft: RelationDraft } | null>(null);
  const mates = useMemo(
    () => (assembly?.mates ?? []).filter((m) => !m.suppressed && MATE_DOFS[m.type].length > 0),
    [assembly],
  );

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
    setSession({ editingId: null, draft: defaultDraft("gear", mates) });
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
    if (existing) commit(updateRelation(assembly, { ...existing, ...rel, name: existing.name }));
    else {
      // A new relation starts from the pose on screen: the driven part stays
      // put, and turns from there.
      const values = solve(assembly, frameFor(assembly)).values;
      commit(
        phaseToCurrentPose(addRelation(assembly, rel), rel.id, values, evaluateVariables(assembly.variables).scope),
      );
    }
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
          onChange: (draft: RelationDraft) => setSession((s) => (s ? { ...s, draft } : s)),
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
