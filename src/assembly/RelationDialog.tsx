// Making or editing a relation (relations.ts): its type, the mate DOF that
// drives and the one driven, the ratio, radius or pitch, and Reverse. The
// mates are chosen from lists rather than picked in the view: a relation
// joins mates, which the view doesn't show.
import { useMemo } from "react";
import { DraggableDialog } from "../ui/DraggableDialog";
import { ExprInput } from "../ui/ExprInput";
import { RelationIcon } from "./MateIcon";
import { dofLabel } from "./mateTypes";
import { defaultDraft, endsFit, RELATION_TYPES, type RelationDraft } from "./relations";
import { isRotation, MATE_DOFS } from "./solve";
import type { Dof, Mate } from "./types";

/** Every (mate, DOF) a relation can use, as "mateId:dof". */
const option = (m: Mate, d: Dof) => `${m.id}:${d}`;
const parse = (s: string): { mateId: string; dof: Dof } | null => {
  const i = s.lastIndexOf(":");
  return i > 0 ? { mateId: s.slice(0, i), dof: s.slice(i + 1) as Dof } : null;
};
const dofName = (m: Mate, d: Dof) =>
  MATE_DOFS[m.type].length > 1 ? `${m.name} · ${dofLabel(m.type, d).replace(/ \(.*\)$/, "")}` : m.name;

export function RelationDialog({
  editing,
  draft,
  mates,
  problem,
  gears,
  onChange,
  onConfirm,
  onCancel,
}: {
  editing: boolean;
  draft: RelationDraft;
  /** The mates with free DOFs. */
  mates: Mate[];
  /** Why the draft can't be made, or null. */
  problem: string | null;
  /** When both ends turn gear parts: which, and why their teeth can't be
   *  lined up (if they can't). The ratio and Reverse are filled from them. */
  gears?: { label: string; problem: string | null } | null;
  onChange: (d: RelationDraft) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const meta = RELATION_TYPES.find((t) => t.type === draft.type)!;
  const ends = useMemo(() => mates.flatMap((m) => MATE_DOFS[m.type].map((d) => ({ m, d }))), [mates]);
  // The driven list holds only DOFs of the kind the driver needs.
  const drivenEnds = draft.driver ? ends.filter(({ d }) => endsFit(draft.type, draft.driver!.dof, d)) : ends;
  const driverEnds = ends.filter(({ d }) => (draft.type === "gear" ? isRotation(d) : true));
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !problem) onConfirm();
  };
  const select = (
    label: string,
    cls: string,
    value: RelationDraft["driver"],
    list: typeof ends,
    set: (v: RelationDraft["driver"]) => void,
  ) => (
    <label className="ed-field">
      <span>{label}</span>
      <select
        className={cls}
        value={value ? `${value.mateId}:${value.dof}` : ""}
        onChange={(e) => set(parse(e.target.value))}
      >
        {!value && <option value="">Choose a mate</option>}
        {list.map(({ m, d }) => (
          <option key={option(m, d)} value={option(m, d)}>
            {dofName(m, d)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <DraggableDialog className="feature-dialog asm-relation" style={{ left: 16, top: 72 }}>
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit relation" : "Relation"}
      </div>
      <div className="ed-modes">
        {RELATION_TYPES.map((t) => (
          <button
            key={t.type}
            className={draft.type === t.type ? "active" : ""}
            title={t.title}
            onClick={() => {
              if (t.type === draft.type) return;
              const next = defaultDraft(t.type, mates);
              // Keep the ends that still fit the new type.
              const keep =
                draft.driver && draft.driven && endsFit(t.type, draft.driver.dof, draft.driven.dof)
                  ? { driver: draft.driver, driven: draft.driven }
                  : {};
              onChange({ ...next, ...keep, reverse: draft.reverse });
            }}
          >
            <RelationIcon type={t.type} /> {t.label}
          </button>
        ))}
      </div>
      {select("Driver", "asm-relation-driver", draft.driver, driverEnds, (driver) => {
        const driven =
          driver && draft.driven && endsFit(draft.type, driver.dof, draft.driven.dof) ? draft.driven : null;
        onChange({ ...draft, driver, driven });
      })}
      {select("Driven", "asm-relation-driven", draft.driven, drivenEnds, (driven) => onChange({ ...draft, driven }))}
      <label className="ed-field">
        <span>{meta.valueLabel}</span>
        <ExprInput
          className="asm-relation-value"
          value={draft.value}
          onChange={(e) => onChange({ ...draft, value: e.target.value })}
          onKeyDown={keys}
        />
      </label>
      <label className="ed-field ed-flip">
        <span>Reverse</span>
        <input
          type="checkbox"
          checked={draft.reverse}
          onChange={(e) => onChange({ ...draft, reverse: e.target.checked })}
        />
      </label>
      {gears && (
        <>
          <p className="ed-hint asm-relation-gears">{gears.label}: ratio and direction from their teeth.</p>
          <label
            className="ed-field ed-flip"
            title="Turn the driven gear the least way that puts its teeth in the driver's spaces"
          >
            <span>Align teeth</span>
            <input
              type="checkbox"
              className="asm-relation-align"
              checked={!!draft.align}
              onChange={(e) => onChange({ ...draft, align: e.target.checked })}
            />
          </label>
          {draft.align && gears.problem && <p className="ed-hint">Can't align: {gears.problem}</p>}
        </>
      )}
      <p className="ed-hint">{meta.title}</p>
      {problem && <p className="ed-warning">{problem}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={!!problem} onClick={onConfirm}>
          {editing ? "Done" : "Add"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
