// Shared chrome for centered modal dialogs (Settings/Documents/Report): the
// overlay backdrop that closes on an outside click, and Escape-to-close.
// DraggableDialog is the separate primitive for panels the user can drag
// around the viewport (Boolean, Edit) — a centered modal never moves, so it
// doesn't need that machinery.
import { useEffect, type DragEventHandler, type ReactNode } from "react";

interface ModalProps {
  onClose: () => void;
  ariaLabel: string;
  /** className for the inner dialog panel (the overlay itself is fixed). */
  className: string;
  children: ReactNode;
  /** Handle Escape on the capture phase and stop it from propagating, so the
   *  app's own global Escape handling (e.g. cancelling a sketch draft) doesn't
   *  also fire underneath this modal. Off by default (bubble phase). */
  escapeCapture?: boolean;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
}

export function Modal({ onClose, ariaLabel, className, children, escapeCapture, onDragOver, onDrop }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escapeCapture) e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, escapeCapture);
    return () => window.removeEventListener("keydown", onKey, escapeCapture);
  }, [onClose, escapeCapture]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={className} role="dialog" aria-label={ariaLabel} onDragOver={onDragOver} onDrop={onDrop}>
        {children}
      </div>
    </div>
  );
}

/** The title-bar + close-button pattern shared by Settings and Report. Extra
 *  header content (e.g. Documents' Import button) can go in `children`,
 *  rendered between the title and the close button. */
export function ModalHeader({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="report-header">
      <span>{title}</span>
      {children}
      <button className="row-icon" title="Close (Esc)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
