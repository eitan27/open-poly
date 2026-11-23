import { BOOLEAN_OPS, BOOLEAN_OP_LABELS } from "../document/featureDefs";
import type { BooleanOp } from "../kernel/types";
import { DraggableDialog } from "./DraggableDialog";
import { PickButton, PickedRow, PickSlot } from "./PickSlot";
import { ExprInput } from "./ExprInput";

export interface BooleanCandidate {
  id: string;
  name: string;
}

interface Props {
  op: BooleanOp;
  /** Editing an existing boolean (re-titles the dialog + primary button). */
  editing?: boolean;
  candidates: BooleanCandidate[];
  /** The name of an operand that isn't a candidate: editing a boolean, its
   *  own operands are consumed by it, so they're no longer parts. */
  nameOf: (id: string) => string;
  /** Operands for union / intersect (a flat list). */
  operandIds: string[];
  /** Subtract: the single base part and the accumulating tool parts. */
  base: string | null;
  tools: string[];
  /** Subtract: which slot the next viewport click fills. */
  armed: "base" | "tools" | null;
  /** Subtract: clearance around every tool (expression, mm; blank = none). */
  offset: string;
  /** Subtract: the tools survive the cut. */
  keepTools: boolean;
  /** Parse error for `offset`, if any (blocks Confirm). */
  offsetError?: string | null;
  onOffsetChange: (offset: string) => void;
  onKeepToolsChange: (keep: boolean) => void;
  onOpChange: (op: BooleanOp) => void;
  onArm: (slot: "base" | "tools") => void;
  onRemoveOperand: (id: string) => void;
  onClearBase: () => void;
  onRemoveTool: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BooleanDialog({
  op,
  editing,
  candidates,
  nameOf: nameOfOther,
  operandIds,
  base,
  tools,
  armed,
  offset,
  keepTools,
  offsetError,
  onOffsetChange,
  onKeepToolsChange,
  onOpChange,
  onArm,
  onRemoveOperand,
  onClearBase,
  onRemoveTool,
  onConfirm,
  onCancel,
}: Props) {
  const nameOf = (id: string) => candidates.find((c) => c.id === id)?.name ?? nameOfOther(id);
  const canConfirm = op === "subtract" ? !!base && tools.length >= 1 && !offsetError : operandIds.length >= 2;
  // The tool opens whatever the document holds (every modeling button does), so
  // it has to say why there is nothing to pick rather than arriving inert.
  const tooFewBodies = candidates.length < 2;

  const row = (id: string, onRemove: () => void) => (
    <PickedRow key={id} label={nameOf(id)} clearTitle="Remove" onClear={onRemove} />
  );

  return (
    <DraggableDialog
      className="feature-dialog boolean-dialog"
      style={{ left: "50%", top: 70 }}
      baseTransform="translateX(-50%)"
    >
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit boolean" : "Boolean operation"}
      </div>
      <div className="ed-modes">
        {BOOLEAN_OPS.map((o) => (
          <button key={o} className={op === o ? "active" : ""} onClick={() => onOpChange(o)}>
            {BOOLEAN_OP_LABELS[o]}
          </button>
        ))}
      </div>
      {tooFewBodies && (
        <p className="ed-warning">A boolean combines two solid bodies — this document has {candidates.length}.</p>
      )}

      {op === "subtract" ? (
        <>
          <div className="ed-hint">Pick the base part, then the tool part(s) to cut from it.</div>
          <div className="bool-group-label">Base</div>
          <PickSlot
            noun="a base part"
            armed={armed === "base"}
            value={base && nameOf(base)}
            clearTitle="Clear"
            wide
            onArm={() => onArm("base")}
            onClear={onClearBase}
          />
          <div className="bool-group-label">Tools</div>
          {/* The arm button is only needed until the first tool lands; after that
              the slot stays armed, so more parts add on click without it. */}
          {tools.length === 0 && (
            <PickButton noun="tool parts" armed={armed === "tools"} wide onClick={() => onArm("tools")} />
          )}
          {tools.length > 0 && (
            <div className="bool-operands">{tools.map((id) => row(id, () => onRemoveTool(id)))}</div>
          )}
          <label
            className="ed-field"
            title="Grow every tool by this much before cutting, so the pocket is looser than the part (negative: tighter)"
          >
            <span>Offset (clearance)</span>
            <ExprInput
              value={offset}
              placeholder="0"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => onOffsetChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) onConfirm();
              }}
            />
          </label>
          <label className="ed-field ed-flip" title="Leave the tool bodies in place after the cut">
            <span>Keep tools</span>
            <input type="checkbox" checked={keepTools} onChange={(e) => onKeepToolsChange(e.target.checked)} />
          </label>
          {offsetError && <p className="ed-warning">{offsetError}</p>}
        </>
      ) : (
        <>
          <div className="ed-hint">Select parts in the viewport to add or remove them.</div>
          {operandIds.length === 0 ? (
            <p className="ed-hint">No parts chosen yet.</p>
          ) : (
            <div className="bool-operands">{operandIds.map((id) => row(id, () => onRemoveOperand(id)))}</div>
          )}
        </>
      )}

      <div className="ed-actions">
        <button className="ed-primary" disabled={!canConfirm} onClick={onConfirm}>
          {editing ? "Done" : "Confirm"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
