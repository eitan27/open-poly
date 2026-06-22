import { BOOLEAN_OPS, BOOLEAN_OP_LABELS } from "../document/featureDefs";
import type { BooleanOp } from "../kernel/types";
import { DraggableDialog } from "./DraggableDialog";

export interface BooleanCandidate {
  id: string;
  name: string;
}

interface Props {
  op: BooleanOp;
  operandIds: string[];
  candidates: BooleanCandidate[];
  onOpChange: (op: BooleanOp) => void;
  onRemoveOperand: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BooleanDialog({
  op,
  operandIds,
  candidates,
  onOpChange,
  onRemoveOperand,
  onConfirm,
  onCancel,
}: Props) {
  const canConfirm = operandIds.length >= 2;
  const nameOf = (id: string) => candidates.find((c) => c.id === id)?.name ?? id;

  return (
    <DraggableDialog className="extrude-dialog" style={{ left: "50%", top: 70 }} baseTransform="translateX(-50%)">
      <div className="ed-title" data-drag-handle>Boolean operation</div>
      <div className="ed-modes">
        {BOOLEAN_OPS.map((o) => (
          <button key={o} className={op === o ? "active" : ""} onClick={() => onOpChange(o)}>
            {BOOLEAN_OP_LABELS[o]}
          </button>
        ))}
      </div>
      <div className="ed-hint">
        Click parts in the viewport to add or remove them.
        {op === "subtract" && operandIds.length > 0 ? " First = base, rest = tools." : ""}
      </div>
      <div className="bool-operands">
        {operandIds.length === 0 && <p className="ed-hint">No parts chosen yet.</p>}
        {operandIds.map((id, i) => (
          <div key={id} className="bool-operand-row">
            <span className="bool-operand-ord">{i + 1}</span>
            <span className="bool-operand-name">{nameOf(id)}</span>
            <button className="bool-operand-x" title="Remove" onClick={() => onRemoveOperand(id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="ed-actions">
        <button className="ed-primary" disabled={!canConfirm} onClick={onConfirm}>
          Create
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
