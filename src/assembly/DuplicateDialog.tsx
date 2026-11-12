// Duplicate: how many copies of the chosen instances (copies.ts lays them out
// beside each original). Enter duplicates, Esc or a click outside cancels.
import { useState } from "react";
import { Modal, ModalHeader } from "../ui/Modal";
import { MAX_COPIES } from "./InsertDialog";
import "../ui/ConfirmDialog.css";

export function DuplicateDialog({
  what,
  onDuplicate,
  onCancel,
}: {
  /** "Bolt <1>", or "3 instances". */
  what: string;
  onDuplicate: (count: number) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("1");
  const n = Math.round(Number(text));
  const ok = Number.isFinite(n) && n >= 1 && n <= MAX_COPIES;
  const go = () => ok && onDuplicate(n);
  return (
    <Modal onClose={onCancel} ariaLabel="Duplicate" className="confirm-dialog asm-duplicate" escapeCapture>
      <ModalHeader title={`Duplicate ${what}`} onClose={onCancel} />
      <label className="ed-field">
        <span>How many copies?</span>
        <input
          className="asm-duplicate-count"
          type="number"
          min={1}
          max={MAX_COPIES}
          autoFocus
          value={text}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go()}
        />
      </label>
      <p className="ed-hint">Copies go beside the original, turned as it is, with no mates.</p>
      <div className="ed-actions">
        <button className="ed-primary asm-duplicate-go" disabled={!ok} onClick={go}>
          Duplicate
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </Modal>
  );
}
