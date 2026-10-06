import { DraggableDialog } from "./DraggableDialog";
import { PickSlot } from "./PickSlot";

export type SweepSlot = "profile" | "path";

interface Props {
  /** Resolved label for the chosen profile region, null while empty. */
  profileLabel: string | null;
  /** Resolved label for the chosen path entity, null while empty. */
  pathLabel: string | null;
  /** Which slot the next viewport click fills. */
  armed: SweepSlot | null;
  onArm: (slot: SweepSlot) => void;
  onClear: (slot: SweepSlot) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function SweepDialog({ profileLabel, pathLabel, armed, onArm, onClear, onConfirm, onCancel }: Props) {
  return (
    <DraggableDialog className="feature-dialog" style={{ left: "50%", top: 70 }} baseTransform="translateX(-50%)">
      <div className="ed-title" data-drag-handle>
        Sweep
      </div>
      <div className="ed-hint">
        Profile: a closed sketch region. Path: a sketch line, arc, or spline — it may live in another sketch.
      </div>
      <div className="bool-group-label">Profile</div>
      <PickSlot
        noun="a profile"
        armed={armed === "profile"}
        value={profileLabel}
        wide
        onArm={() => onArm("profile")}
        onClear={() => onClear("profile")}
      />
      <div className="bool-group-label">Path</div>
      <PickSlot
        noun="a path"
        armed={armed === "path"}
        value={pathLabel}
        wide
        onArm={() => onArm("path")}
        onClear={() => onClear("path")}
      />
      <div className="ed-actions">
        <button className="ed-primary" disabled={!profileLabel || !pathLabel} onClick={onConfirm}>
          Create
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
