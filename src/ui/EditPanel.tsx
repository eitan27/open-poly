import { useEffect, useState, type ReactNode } from "react";
import { DraggableDialog } from "./DraggableDialog";

interface Props {
  /** What the panel is editing ("Extrude", "Sketch") — shown in the title bar. */
  title: string;
  /** Identity of the thing being edited. Changing it re-opens the panel after a
   *  manual ✕, so dismissing is "hide this one", not "turn the panel off". */
  targetKey: string;
  /** If given, the ✕ calls this (e.g. to close the params panel) instead of the
   *  default "hide until the next selection" behaviour. */
  onClose?: () => void;
  children: ReactNode;
}

/** The active-edit panel: the constraints of the sketch being edited and/or the
 *  parameters of the selected feature, in a movable dialog anchored to the
 *  viewport's top-left. Floating it there (like the feature mini-dialogs) puts
 *  it where the eye already is: down in the left sidebar under the Parts list,
 *  the thing you are actually editing is easy to miss. Shows only while
 *  something is being edited. */
export function EditPanel({ title, targetKey, onClose, children }: Props) {
  const [closed, setClosed] = useState(false);
  // A new selection is a new intent — bring the panel back.
  useEffect(() => setClosed(false), [targetKey]);

  if (closed) return null;

  return (
    // Anchor comes from .edit-panel in CSS; baseTransform="" drops the base
    // dialog's translate so drag deltas apply from that anchor.
    <DraggableDialog className="feature-dialog edit-panel" baseTransform="">
      <div className="ep-titlebar">
        <span className="ed-title" data-drag-handle>
          {title}
        </span>
        <button
          className="ep-close"
          title={onClose ? "Close" : "Hide (returns on the next selection)"}
          onClick={() => (onClose ? onClose() : setClosed(true))}
        >
          ✕
        </button>
      </div>
      {children}
    </DraggableDialog>
  );
}
