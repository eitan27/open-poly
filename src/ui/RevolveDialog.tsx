import { DraggableDialog } from "./DraggableDialog";
import { PickSlot } from "./PickSlot";

export type RevolveMode = "full" | "angle";

interface Props {
  /** Editing an existing revolve (re-titles the dialog + primary button). */
  editing?: boolean;
  /** Where the dialog sits — anchored near the profile when it opened. */
  x: number;
  y: number;
  /** Resolved label for the profile (sketch region or body face), null while empty. */
  profileLabel: string | null;
  profileArmed: boolean;
  /** Resolved label for the axis (line, edge, plane or face), null while empty. */
  axisLabel: string | null;
  axisArmed: boolean;
  mode: RevolveMode;
  /** Degrees as an expression string; only read when `mode` is "angle". */
  degrees: string;
  symmetric: boolean;
  /** Why the live ghost could not be built, if it could not. */
  previewError?: string | null;
  onArmProfile: () => void;
  onClearProfile: () => void;
  onArmAxis: () => void;
  onClearAxis: () => void;
  onModeChange: (mode: RevolveMode) => void;
  onDegreesChange: (degrees: string) => void;
  onSymmetricChange: (symmetric: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const MODE_LABELS: Record<RevolveMode, string> = { full: "Full (360°)", angle: "Angle" };

export function RevolveDialog({
  editing,
  x,
  y,
  profileLabel,
  profileArmed,
  axisLabel,
  axisArmed,
  mode,
  degrees,
  symmetric,
  previewError,
  onArmProfile,
  onClearProfile,
  onArmAxis,
  onClearAxis,
  onModeChange,
  onDegreesChange,
  onSymmetricChange,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <DraggableDialog className="feature-dialog" style={{ left: x, top: y }}>
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit revolve" : "Revolve"}
      </div>
      <div className="ed-hint">
        Profile: a closed sketch region or a planar body face. Axis: a sketch line, a straight body edge, a plane, or a
        body face.
      </div>
      <div className="bool-group-label">Profile</div>
      <PickSlot
        noun="a profile"
        armed={profileArmed}
        value={profileLabel}
        wide
        onArm={onArmProfile}
        onClear={onClearProfile}
      />
      <div className="bool-group-label">Axis</div>
      <PickSlot noun="an axis" armed={axisArmed} value={axisLabel} wide onArm={onArmAxis} onClear={onClearAxis} />
      <div className="ed-modes">
        {(["full", "angle"] as const).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => onModeChange(m)}>
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      {mode === "angle" && (
        <>
          <label className="ed-field">
            <span>Angle (°)</span>
            <input
              autoFocus
              value={degrees}
              onChange={(e) => onDegreesChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onConfirm();
                else if (e.key === "Escape") onCancel();
              }}
            />
          </label>
          <label className="ed-field ed-flip">
            <span>Symmetric</span>
            <input type="checkbox" checked={symmetric} onChange={(e) => onSymmetricChange(e.target.checked)} />
          </label>
        </>
      )}
      {previewError && <p className="ed-warning">{previewError}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={!profileLabel || !axisLabel} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
