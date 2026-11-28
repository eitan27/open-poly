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

const fmtMm = (n: number) => String(Math.round(n * 100) / 100);

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
  gears?: {
    label: string | null;
    problem: string | null;
    /** A pinion and a rack: how far the rack's pitch line is from where it
     *  meshes (mm), or why it can't be moved there. */
    rack?: { offBy: number | string | null };
  } | null;
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
      {gears && !gears.label && gears.problem && (
        <p className="ed-hint asm-relation-gears">Align teeth isn't available: {gears.problem}</p>
      )}
      {gears?.label && (
        <>
          <p className="ed-hint asm-relation-gears">
            {gears.label}: {draft.type === "rack" ? "radius" : "ratio"} and direction from their teeth.
          </p>
          <label
            className="ed-field ed-flip"
            title={
              draft.type === "rack"
                ? "Move the driven part (the rack sliding, or the gear turning) the least way that puts the teeth in mesh"
                : "Turn the driven gear the least way that puts its teeth in the driver's spaces"
            }
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
          {gears.rack && typeof gears.rack.offBy === "number" && Math.abs(gears.rack.offBy) >= 0.01 && (
            <label
              className="ed-field ed-flip"
              title="Shift the rack's mate connector so the rack's pitch line touches the gear's pitch circle"
            >
              <span>
                Move the rack to the gear ({fmtMm(Math.abs(gears.rack.offBy))} mm{" "}
                {gears.rack.offBy > 0 ? "too far" : "too close"})
              </span>
              <input
                type="checkbox"
                className="asm-relation-place"
                checked={!!draft.place}
                onChange={(e) => onChange({ ...draft, place: e.target.checked })}
              />
            </label>
          )}
          {gears.rack && typeof gears.rack.offBy === "string" && <p className="ed-hint">{gears.rack.offBy}</p>}
          {gears.rack && (
            <label
              className="ed-field ed-flip"
              title="Limit the driver so the gear stays at least a tooth in from either end of the rack"
            >
              <span>Limit travel to the rack</span>
              <input
                type="checkbox"
                className="asm-relation-limit"
                checked={!!draft.limit}
                onChange={(e) => onChange({ ...draft, limit: e.target.checked })}
              />
            </label>
          )}
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
