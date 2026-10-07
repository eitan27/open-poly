import type { PlaneMethod } from "../document/types";
import { DraggableDialog } from "./DraggableDialog";
import { PickSlot } from "./PickSlot";

const METHOD_LABELS: Record<PlaneMethod, string> = {
  offset: "Offset",
  midplane: "Midplane",
  angle: "At angle",
  through: "Through 3 points",
};
const METHODS = ["offset", "midplane", "angle", "through"] as const;

/** How many points "Through 3 points" needs before it can build a frame. */
const POINTS_NEEDED = 3;

interface Props {
  /** Editing an existing reference plane (re-titles the dialog + primary button). */
  editing?: boolean;
  method: PlaneMethod;
  /** Resolved label for the base plane/face, null while empty. Doubles as the
   *  slot's tooltip, since a plane reference can be longer than the slot. */
  baseLabel: string | null;
  baseArmed: boolean;
  /** Midplane's second reference. */
  refBLabel: string | null;
  refBArmed: boolean;
  offset: string;
  angleAxis: "u" | "v";
  angle: string;
  /** How many of the three points have been clicked so far. */
  pointCount: number;
  pointsArmed: boolean;
  onMethodChange: (method: PlaneMethod) => void;
  onArmBase: () => void;
  onClearBase: () => void;
  onArmRefB: () => void;
  onClearRefB: () => void;
  onOffsetChange: (offset: string) => void;
  onAngleAxisChange: (axis: "u" | "v") => void;
  onAngleChange: (angle: string) => void;
  onArmPoints: () => void;
  onClearPoints: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PlaneDialog({
  editing,
  method,
  baseLabel,
  baseArmed,
  refBLabel,
  refBArmed,
  offset,
  angleAxis,
  angle,
  pointCount,
  pointsArmed,
  onMethodChange,
  onArmBase,
  onClearBase,
  onArmRefB,
  onClearRefB,
  onOffsetChange,
  onAngleAxisChange,
  onAngleChange,
  onArmPoints,
  onClearPoints,
  onConfirm,
  onCancel,
}: Props) {
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onConfirm();
    else if (e.key === "Escape") onCancel();
  };

  const canConfirm =
    method === "through"
      ? pointCount === POINTS_NEEDED
      : method === "midplane"
        ? !!baseLabel && !!refBLabel
        : !!baseLabel;

  return (
    <DraggableDialog className="feature-dialog" style={{ left: "50%", top: 64 }} baseTransform="translateX(-50%)">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit plane" : "Reference plane"}
      </div>
      <label className="ed-field">
        <span>Method</span>
        {/* NB this is the `<select>`-arming-a-pick shape the Transform dialog's
            axis control was deliberately built to avoid: on macOS the popup is a
            native menu running its own event loop, and the first canvas click
            after it closes is swallowed, so the pick this arms can appear to need
            two clicks. Left as it was — changing the control is a behaviour fix,
            not part of moving the markup — but it is the next thing to look at
            if someone reports plane picking needing a double click. */}
        <select value={method} onChange={(e) => onMethodChange(e.target.value as PlaneMethod)}>
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {METHOD_LABELS[m]}
            </option>
          ))}
        </select>
      </label>

      {method !== "through" && (
        <div className="ed-field">
          <span>{method === "midplane" ? "First" : "Base"}</span>
          <PickSlot
            noun="a plane or face"
            armed={baseArmed}
            value={baseLabel}
            title={baseLabel ?? undefined}
            onArm={onArmBase}
            onClear={onClearBase}
          />
        </div>
      )}

      {method === "offset" && (
        <label className="ed-field">
          <span>Offset</span>
          <input value={offset} onChange={(e) => onOffsetChange(e.target.value)} onKeyDown={keys} />
        </label>
      )}

      {method === "midplane" && (
        <div className="ed-field">
          <span>Second</span>
          <PickSlot
            noun="a plane or face"
            armed={refBArmed}
            value={refBLabel}
            title={refBLabel ?? undefined}
            onArm={onArmRefB}
            onClear={onClearRefB}
          />
        </div>
      )}

      {method === "angle" && (
        <>
          <div className="ed-field">
            <span>Hinge</span>
            <div className="ed-modes" style={{ width: 112 }}>
              {(["u", "v"] as const).map((ax) => (
                <button key={ax} className={angleAxis === ax ? "active" : ""} onClick={() => onAngleAxisChange(ax)}>
                  {ax.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <label className="ed-field">
            <span>Angle°</span>
            <input value={angle} onChange={(e) => onAngleChange(e.target.value)} onKeyDown={keys} />
          </label>
        </>
      )}

      {method === "through" && (
        <div className="ed-field">
          <span>Points</span>
          {/* A counting slot: it takes three clicks, so the button carries the
              tally alongside the imperative, and it only reads as FILLED at 3/3 —
              where it stops taking clicks and ✕ starts the three over. */}
          <PickSlot
            noun="points"
            armed={pointsArmed && pointCount < POINTS_NEEDED}
            value={pointCount === POINTS_NEEDED ? `${POINTS_NEEDED}/${POINTS_NEEDED} picked` : null}
            clearTitle="Clear the points and pick again"
            onArm={onArmPoints}
            onClear={onClearPoints}
          >
            {`Select points (${pointCount}/${POINTS_NEEDED})`}
          </PickSlot>
        </div>
      )}

      <div className="ed-actions">
        <button className="ed-primary" disabled={!canConfirm} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
