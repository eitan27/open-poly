import { DraggableDialog } from "./DraggableDialog";
import { PickSlot } from "./PickSlot";

interface Props {
  /** Editing an existing mirror (re-titles the dialog + primary button). */
  editing?: boolean;
  /** Resolved name of the body being mirrored, null while empty. */
  targetLabel: string | null;
  targetArmed: boolean;
  /** Resolved label for the mirror plane, null while empty. */
  planeLabel: string | null;
  planeArmed: boolean;
  onArmTarget: () => void;
  onClearTarget: () => void;
  onArmPlane: () => void;
  onClearPlane: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MirrorDialog({
  editing,
  targetLabel,
  targetArmed,
  planeLabel,
  planeArmed,
  onArmTarget,
  onClearTarget,
  onArmPlane,
  onClearPlane,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <DraggableDialog className="feature-dialog" style={{ left: "50%", top: 70 }} baseTransform="translateX(-50%)">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit mirror" : "Mirror a body"}
      </div>
      <div className="bool-group-label">Body</div>
      <PickSlot
        noun="a body"
        armed={targetArmed}
        value={targetLabel}
        wide
        onArm={onArmTarget}
        onClear={onClearTarget}
      />
      <div className="bool-group-label">Plane or face</div>
      {/* ONE slot for all three kinds of mirror plane — a datum, a reference
          plane, or a planar body face — because the viewport's plane-pick
          stream already resolves all three to a SketchPlaneRef (it is what
          the reference-plane dialog's own slots read). A dropdown of named
          planes would be a second control for the same job, and an option
          that armed a pick is the shape whose first canvas click gets
          swallowed on macOS (see the Transform dialog's axis control). */}
      <PickSlot
        noun="a plane or face"
        armed={planeArmed}
        value={planeLabel}
        wide
        title="A datum plane, a reference plane, or a flat face of a body"
        onArm={onArmPlane}
        onClear={onClearPlane}
      />
      <div className="ed-actions">
        <button className="ed-primary" onClick={onConfirm} disabled={!targetLabel || !planeLabel}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
