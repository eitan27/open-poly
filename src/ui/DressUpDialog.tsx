import { Fragment } from "react";
import { DraggableDialog } from "./DraggableDialog";
import { PickButton, PickedRow } from "./PickSlot";
import type { PickGroup } from "./pickRows";

export type DressUpOp = "chamfer" | "fillet";

interface Props {
  op: DressUpOp;
  /** Editing an existing chamfer/fillet (re-titles the dialog + primary button). */
  editing?: boolean;
  x: number;
  y: number;
  /** Rows grouped by the body they dress — see `buildDressUpGroups`. */
  groups: PickGroup[];
  /** How many bodies this one feature will dress. */
  bodyCount: number;
  /** What the picks resolve to ("5 edges + 1 face"), or null when nothing to say. */
  summary: string | null;
  /** True while the next viewport click adds to or removes from the picks. */
  arming: boolean;
  /** Whether any pick has landed yet — changes the arm button's wording. */
  hasPicks: boolean;
  size: string;
  /** Chamfer only: the bevel angle off the reference face. */
  angle: string;
  flip: boolean;
  /** Validation or geometry error to show, if any. */
  message?: string | null;
  confirmDisabled: boolean;
  onToggleArming: () => void;
  onSizeChange: (size: string) => void;
  onAngleChange: (angle: string) => void;
  onFlipChange: (flip: boolean) => void;
  onConfirm: () => void;
  /** Escape: stop arming if armed, else close. Distinct from `onCancel`, which
   *  always closes — Escape has to be able to mean "stop picking" first. */
  onEscape: () => void;
  onCancel: () => void;
}

export function DressUpDialog({
  op,
  editing,
  x,
  y,
  groups,
  bodyCount,
  summary,
  arming,
  hasPicks,
  size,
  angle,
  flip,
  message,
  confirmDisabled,
  onToggleArming,
  onSizeChange,
  onAngleChange,
  onFlipChange,
  onConfirm,
  onEscape,
  onCancel,
}: Props) {
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onConfirm();
    else if (e.key === "Escape") onEscape();
  };
  const selectAll = (e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select();

  return (
    <DraggableDialog className="feature-dialog" style={{ left: x, top: y }}>
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit " : ""}
        {op === "chamfer" ? "Chamfer" : "Fillet"}
        {!editing && bodyCount > 1 ? ` (${bodyCount} bodies)` : ""}
      </div>
      {/* An accumulating slot (see PickSlot.tsx): one PickedRow per pick, and a
          button that keeps the arming live for the next one. Clicking a listed
          edge/face in the viewport removes it. Picks on several bodies are grouped
          by body, because that is how they commit — one dress-up each. */}
      <div className="bool-group-label">Edges / faces{summary ? ` — ${summary}` : ""}</div>
      {groups.map((g) => (
        <Fragment key={g.key}>
          {groups.length > 1 && <div className="bool-group-label ed-subgroup">{g.label}</div>}
          {g.items.map((item) => (
            <PickedRow key={item.label} label={item.label} clearTitle="Remove" onClear={item.onRemove} />
          ))}
        </Fragment>
      ))}
      <PickButton noun="edges or faces" armed={arming} wide onClick={onToggleArming}>
        {arming ? "Select edges or faces (Esc to stop)" : hasPicks ? "Add more edges" : undefined}
      </PickButton>
      {bodyCount > 1 && (
        <p className="ed-hint">
          One {op} across {bodyCount} parts — a single feature, dressing each body from its own edges.
        </p>
      )}
      <label className="ed-field">
        <span>{op === "chamfer" ? "Distance" : "Radius"}</span>
        <input
          autoFocus
          onFocus={selectAll}
          value={size}
          onChange={(e) => onSizeChange(e.target.value)}
          onKeyDown={keys}
        />
      </label>
      {/* Chamfer only: the bevel angle off the reference face (45° is the
          symmetric cut), and which of the edge's two adjacent faces that
          reference is. Flip does nothing at 45°. */}
      {op === "chamfer" && (
        <>
          <label className="ed-field">
            <span>Angle (°)</span>
            <input value={angle} onFocus={selectAll} onChange={(e) => onAngleChange(e.target.value)} onKeyDown={keys} />
          </label>
          <label className="ed-field ed-flip" title="Measure the distance and angle from the edge's other face">
            <span>Flip angle</span>
            <input type="checkbox" checked={flip} onChange={(e) => onFlipChange(e.target.checked)} />
          </label>
        </>
      )}
      {message && <p className="ed-warning">{message}</p>}
      <div className="ed-actions">
        <button className="ed-primary" onClick={onConfirm} disabled={confirmDisabled}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
