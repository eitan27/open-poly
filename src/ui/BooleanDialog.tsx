import { BOOLEAN_OPS, BOOLEAN_OP_LABELS } from "../document/featureDefs";
import type { BooleanOp } from "../kernel/types";

export interface BooleanCandidate {
  id: string;
  name: string;
}

interface Props {
  op: BooleanOp;
  operandIds: string[];
  candidates: BooleanCandidate[];
  onOpChange: (op: BooleanOp) => void;
  onToggleOperand: (id: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function BooleanDialog({
  op,
  operandIds,
  candidates,
  onOpChange,
  onToggleOperand,
  onConfirm,
  onCancel,
}: Props) {
  const canConfirm = operandIds.length >= 2;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Boolean operation</h3>
        <div className="modal-op-row">
          {BOOLEAN_OPS.map((o) => (
            <button
              key={o}
              type="button"
              className={"modal-op-btn" + (op === o ? " active" : "")}
              onClick={() => onOpChange(o)}
            >
              {BOOLEAN_OP_LABELS[o]}
            </button>
          ))}
        </div>
        <p className="modal-hint">Select at least two solids.</p>
        <div className="modal-list">
          {candidates.length === 0 && <p className="hint">No solids available yet.</p>}
          {candidates.map((c) => (
            <label key={c.id} className="modal-list-row">
              <input
                type="checkbox"
                checked={operandIds.includes(c.id)}
                onChange={() => onToggleOperand(c.id)}
              />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" disabled={!canConfirm} onClick={onConfirm}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
