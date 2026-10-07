import { DraggableDialog } from "./DraggableDialog";
import { PickSlot } from "./PickSlot";

/** Which half of a two-level reference control is showing. `null` is neither:
 *  nothing chosen yet, so only the segmented pair is offered. */
export type RefKind = "world" | "picked" | null;

/** One reference slot, already resolved. The two KINDS of reference are
 *  alternatives, so they are one segmented choice rather than two controls that
 *  both say "axis"; whichever is chosen reveals its own detail below. */
export interface PatternRefControl {
  kind: RefKind;
  /** Resolved label for a picked reference, null when it holds none. */
  label: string | null;
  /** True while this slot's viewport pick is in flight. */
  armed: boolean;
  /** The world direction, when the slot holds one. */
  worldAxis: "x" | "y" | "z" | null;
  onUseWorld: () => void;
  onWorldAxisChange: (axis: "x" | "y" | "z") => void;
  onArmPick: () => void;
  onClearPick: () => void;
}

interface RefControlProps {
  control: PatternRefControl;
  /** Wording for the pick half: the button, and the slot's noun. */
  pickLabel: string;
  pickNoun: string;
  /** Label on the X/Y/Z row the world half shows. */
  alongLabel: string;
  worldTitle?: string;
}

/** Buttons rather than a `<select>`, and that is load-bearing — see the Transform
 *  dialog's axis control for the whole story: on macOS a native popup menu runs its
 *  own event loop, so the first canvas click after it closes is swallowed and the
 *  pick an option arms appears to need two. */
function RefControl({ control, pickLabel, pickNoun, alongLabel, worldTitle }: RefControlProps) {
  const { kind, label, armed, worldAxis, onUseWorld, onWorldAxisChange, onArmPick, onClearPick } = control;
  return (
    <>
      <div className="ed-modes">
        <button className={kind === "world" ? "active" : ""} title={worldTitle} onClick={onUseWorld}>
          World axis
        </button>
        <button className={kind === "picked" ? "active" : ""} onClick={onArmPick}>
          {pickLabel}
        </button>
      </div>
      {kind === "picked" ? (
        <PickSlot noun={pickNoun} armed={armed} value={label} wide onArm={onArmPick} onClear={onClearPick} />
      ) : kind === "world" ? (
        <div className="ed-field">
          <span>{alongLabel}</span>
          <div className="ed-modes" style={{ width: 112 }}>
            {(["x", "y", "z"] as const).map((ax) => (
              <button key={ax} className={worldAxis === ax ? "active" : ""} onClick={() => onWorldAxisChange(ax)}>
                {ax.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

interface Props {
  /** Editing an existing pattern (re-titles the dialog + primary button). */
  editing?: boolean;
  kind: "linear" | "circular";
  /** Resolved body name, null while no body is picked. */
  targetLabel: string | null;
  targetArmed: boolean;
  /** The three reference slots, already resolved. `dir2` is only read when
   *  `dir2on`; `axis` only in circular. */
  dir1: PatternRefControl;
  dir2: PatternRefControl;
  axis: PatternRefControl;
  count1: string;
  spacing1: string;
  flip1: boolean;
  dir2on: boolean;
  count2: string;
  spacing2: string;
  flip2: boolean;
  count: string;
  mode: "full" | "angle";
  angle: string;
  symmetric: boolean;
  /** True when the circular axis is a body face, whose resolution only happens in
   *  the kernel — so there is no live preview to promise. */
  axisIsFace: boolean;
  /** Why it cannot build yet. Doubles as the primary button's disabled reason. */
  warning?: string | null;
  confirmDisabled: boolean;
  onKindChange: (kind: "linear" | "circular") => void;
  onArmTarget: () => void;
  onFieldChange: (field: PatternNumericField, value: string) => void;
  onFlagChange: (field: PatternFlagField, value: boolean) => void;
  onModeChange: (mode: "full" | "angle") => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The text fields, all expression strings. */
export type PatternNumericField = "count1" | "spacing1" | "count2" | "spacing2" | "count" | "angle";
/** The checkboxes. */
export type PatternFlagField = "flip1" | "flip2" | "dir2on" | "symmetric";

const LINEAR_REF = { pickLabel: "Sketch line", pickNoun: "a sketch line", alongLabel: "Along" } as const;

export function PatternDialog({
  editing,
  kind,
  targetLabel,
  targetArmed,
  dir1,
  dir2,
  axis,
  count1,
  spacing1,
  flip1,
  dir2on,
  count2,
  spacing2,
  flip2,
  count,
  mode,
  angle,
  symmetric,
  axisIsFace,
  warning,
  confirmDisabled,
  onKindChange,
  onArmTarget,
  onFieldChange,
  onFlagChange,
  onModeChange,
  onConfirm,
  onCancel,
}: Props) {
  /** Enter commits from any field. There is no Escape handling here: this dialog
   *  has no autoFocus on open, so Escape reaches the global handler. */
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onConfirm();
  };

  const field = (label: string, f: PatternNumericField, value: string, autoFocus = false) => (
    <label className="ed-field" key={f}>
      <span>{label}</span>
      <input autoFocus={autoFocus} value={value} onChange={(e) => onFieldChange(f, e.target.value)} onKeyDown={enter} />
    </label>
  );

  const flag = (label: string, f: PatternFlagField, value: boolean) => (
    <label className="ed-field ed-flip" key={f}>
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onFlagChange(f, e.target.checked)} />
    </label>
  );

  return (
    <DraggableDialog className="feature-dialog" style={{ left: "50%", top: 64 }} baseTransform="translateX(-50%)">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit pattern" : "Pattern"}
      </div>
      <div className="ed-modes">
        {(["linear", "circular"] as const).map((k) => (
          <button key={k} className={kind === k ? "active" : ""} onClick={() => onKindChange(k)}>
            {k === "linear" ? "Linear" : "Circular"}
          </button>
        ))}
      </div>
      <div className="bool-group-label">Body</div>
      <PickSlot noun="a body" armed={targetArmed} value={targetLabel} wide onArm={onArmTarget} />
      {kind === "linear" ? (
        <>
          <div className="bool-group-label">Direction</div>
          <RefControl control={dir1} {...LINEAR_REF} />
          {field("Count", "count1", count1, true)}
          {field("Spacing", "spacing1", spacing1)}
          {flag("Flip", "flip1", flip1)}
          {flag("Second direction", "dir2on", dir2on)}
          {dir2on && (
            <>
              <RefControl control={dir2} {...LINEAR_REF} />
              {field("Count", "count2", count2)}
              {field("Spacing", "spacing2", spacing2)}
              {flag("Flip", "flip2", flip2)}
            </>
          )}
        </>
      ) : (
        <>
          <div className="bool-group-label">Axis</div>
          <RefControl
            control={axis}
            pickLabel="Line or face"
            pickNoun="an axis"
            alongLabel="Around"
            // Unlike a linear DIRECTION (a vector, positionless), a circular axis
            // is a line — and the world one runs through the origin, which is not
            // where the body is.
            worldTitle="A world axis through the origin"
          />
          {field("Count", "count", count, true)}
          <div className="ed-modes">
            {(["full", "angle"] as const).map((m) => (
              <button key={m} className={mode === m ? "active" : ""} onClick={() => onModeChange(m)}>
                {m === "full" ? "Full (360°)" : "Angle"}
              </button>
            ))}
          </div>
          {mode === "angle" && (
            <>
              {field("Angle (°)", "angle", angle)}
              {flag("Symmetric", "symmetric", symmetric)}
            </>
          )}
          {axisIsFace && (
            <div className="ed-hint">A face axis resolves in the kernel — the preview appears after Create.</div>
          )}
        </>
      )}
      {warning && <p className="ed-warning">{warning}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={confirmDisabled} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
