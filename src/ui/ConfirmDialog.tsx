// A centered question with Continue / Cancel: for an edit that would undo
// something the user set up (an assembly expression a typed value or a drag
// overrides). Esc and a click outside cancel.
//
// Neither button has the focus when it opens, the question itself does: it
// often opens from a field's Enter, and that same keypress must not answer it
// (either way) before it's been read. Tab reaches the buttons.
import { useEffect, useRef } from "react";
import { Modal, ModalHeader } from "./Modal";
import "./ConfirmDialog.css";

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Continue",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const body = useRef<HTMLParagraphElement>(null);
  useEffect(() => body.current?.focus(), []);
  return (
    <Modal onClose={onCancel} ariaLabel={title} className="confirm-dialog" escapeCapture>
      <ModalHeader title={title} onClose={onCancel} />
      <p ref={body} className="confirm-message" tabIndex={-1}>
        {/* `code` spans (an expression) as code. */}
        {message.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}
      </p>
      <div className="ed-actions">
        <button className="ed-primary confirm-continue" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button className="confirm-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
