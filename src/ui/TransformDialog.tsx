import type { TransformMode } from "../viewport/types";
import { DraggableDialog } from "./DraggableDialog";
import { PickSlot } from "./PickSlot";

const MODE_LABELS: Record<TransformMode, string> = { translate: "Move", rotate: "Rotate", scale: "Scale" };
const MODES = ["translate", "rotate", "scale"] as const;

/** Where a transform panel sits: anchored to the body when its screen position is
 *  known, else centred at the top. Shared by both dialogs below so an arming
 *  panel and the gizmo panel that replaces it appear in the same place. */
export interface TransformPanelXY {
  x: number;
  y: number;
}

const panelStyle = (at: TransformPanelXY | null) => ({ left: at?.x ?? "50%", top: at?.y ?? 64 });
const panelTransform = (at: TransformPanelXY | null) => (at ? undefined : "translateX(-50%)");

/** The field a keystroke edits. `axis` here is the world direction, not a picked
 *  reference — those go through `onArmAxis`. */
export type TransformField = "tx" | "ty" | "tz" | "scale" | "angle" | "axis" | "copy";

interface Props {
  /** The feature's display name, for the title. */
  name: string;
  at: TransformPanelXY | null;
  mode: TransformMode;
  /** Already-resolved display strings — the gizmo's live numbers while dragging,
   *  the feature's own expressions otherwise. */
  values: { tx: string; ty: string; tz: string; scale: string; angle: string };
  /** Whether the axis is a picked reference (or about to be), which decides which
   *  half of the axis control shows. */
  pickedAxis: boolean;
  axisArmed: boolean;
  axisLabel: string | null;
  /** The world direction, when the axis is one. */
  worldAxis: "x" | "y" | "z" | null;
  copy: boolean;
  onModeChange: (mode: TransformMode) => void;
  onParamChange: (field: TransformField, value: string) => void;
  /** Switch the axis back to a world direction (also drops an armed pick). */
  onUseWorldAxis: () => void;
  onArmAxis: () => void;
  onClearAxis: () => void;
  onCopyChange: (copy: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function TransformDialog({
  name,
  at,
  mode,
  values,
  pickedAxis,
  axisArmed,
  axisLabel,
  worldAxis,
  copy,
  onModeChange,
  onParamChange,
  onUseWorldAxis,
  onArmAxis,
  onClearAxis,
  onCopyChange,
  onConfirm,
  onCancel,
}: Props) {
  /** Enter commits, Escape abandons — on every numeric field in here. */
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onConfirm();
    else if (e.key === "Escape") onCancel();
  };

  const field = (label: string, f: TransformField, value: string) => (
    <label className="ed-field" key={f}>
      <span>{label}</span>
      <input value={value} onChange={(e) => onParamChange(f, e.target.value)} onKeyDown={keys} />
    </label>
  );

  return (
    <DraggableDialog className="feature-dialog" style={panelStyle(at)} baseTransform={panelTransform(at)}>
      <div className="ed-title" data-drag-handle>
        Transform · {name}
      </div>
      <div className="ed-modes">
        {MODES.map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => onModeChange(m)}>
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      {mode === "translate" ? (
        (["tx", "ty", "tz"] as const).map((k) => field(`Move ${k[1].toUpperCase()}`, k, values[k]))
      ) : mode === "scale" ? (
        field("Factor", "scale", values.scale)
      ) : (
        <>
          {/* ONE axis control, in two levels. The two KINDS of axis are
              alternatives, so they're one segmented choice rather than two
              controls that both say "axis"; whichever is chosen then reveals its
              own detail below (X/Y/Z, or the pick slot). "Body center" rather
              than "World X/Y/Z" because the world wording reads as "through the
              origin" — which is what it means in the Pattern dialog, and is NOT
              what happens here: the direction is world-aligned but the axis runs
              through the body's own center, so the body spins on the spot.

              Buttons, NOT a <select>, and that part is load-bearing: on macOS a
              select's popup is a native menu running its own event loop, and
              after choosing from it the first click on the canvas is swallowed —
              so the pick this option arms needs two clicks, the first appearing
              to do nothing. (It reproduces only in a real browser; neither
              headless nor headed Chromium under automation shows it, with or
              without the select focused.) Buttons have no popup, and they match
              the Move/Rotate/Scale row above. NB the Pattern dialog arms its
              picks from a <select> the same way and is likely to have the same
              fault. */}
          <div className="bool-group-label">Axis</div>
          <div className="ed-modes">
            <button className={pickedAxis ? "" : "active"} onClick={onUseWorldAxis}>
              Body center
            </button>
            <button className={pickedAxis ? "active" : ""} onClick={onArmAxis}>
              Line or edge
            </button>
          </div>
          {pickedAxis ? (
            <PickSlot
              noun="an axis"
              armed={axisArmed}
              value={axisLabel}
              wide
              title="A straight body edge or a sketch line to swing the body around"
              onArm={onArmAxis}
              onClear={onClearAxis}
            />
          ) : (
            <div className="ed-field">
              <span>Along</span>
              <div className="ed-modes" style={{ width: 112 }}>
                {(["x", "y", "z"] as const).map((ax) => (
                  <button
                    key={ax}
                    className={worldAxis === ax ? "active" : ""}
                    onClick={() => onParamChange("axis", ax)}
                  >
                    {ax.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          )}
          {field("Angle°", "angle", values.angle)}
        </>
      )}
      <label className="ed-field ed-flip">
        <span>Keep original (copy)</span>
        <input type="checkbox" checked={copy} onChange={(e) => onCopyChange(e.target.checked)} />
      </label>
      <div className="ed-hint">
        {mode === "scale"
          ? "Uniform scale about the body's center — drag a corner of the box out to grow, in to shrink."
          : mode === "rotate"
            ? "An axis through the body's center spins it on the spot; a picked line or edge hinges it around that line. Drag the ring, or type an angle."
            : "Drag the gizmo, or type exact values."}
      </div>
      <div className="ed-actions">
        <button className="ed-primary" onClick={onConfirm}>
          Done
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}

interface ArmingProps {
  at: TransformPanelXY | null;
  mode: TransformMode;
  onModeChange: (mode: TransformMode) => void;
  onCancel: () => void;
}

/** The panel shown while Transform is waiting for a body. It offers the mode up
 *  front so the choice survives into the gizmo panel that replaces it, and its
 *  body slot is permanently armed — there is nothing to arm or clear, which is
 *  why it has no handlers. */
export function TransformArmingDialog({ at, mode, onModeChange, onCancel }: ArmingProps) {
  return (
    <DraggableDialog className="feature-dialog" style={panelStyle(at)} baseTransform={panelTransform(at)}>
      <div className="ed-title" data-drag-handle>
        Transform
      </div>
      <div className="ed-modes">
        {MODES.map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => onModeChange(m)}>
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <PickSlot noun="a body" armed value={null} wide onArm={() => {}} />
      <div className="ed-actions">
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
