import { Fragment } from "react";
import type { ExtrudeExtent, ExtrudeMode } from "../document/types";
import { DraggableDialog } from "./DraggableDialog";
import { PickButton, PickedRow, PickSlot } from "./PickSlot";
import type { PickGroup } from "./pickRows";

const MODE_LABELS: Record<ExtrudeMode, string> = { new: "New", add: "Add", remove: "Remove" };
const MODES = ["new", "add", "remove"] as const;

export interface ExtrudeTargetOption {
  id: string;
  name: string;
}

interface Props {
  /** Editing an existing extrude (re-titles the dialog + primary button). */
  editing?: boolean;
  x: number;
  y: number;
  /** Picked profiles, grouped by the body or sketch each came from. */
  groups: PickGroup[];
  /** How many profiles this extrude will consume. */
  profileCount: number;
  /** True while the next viewport click adds to or removes from the profiles. */
  arming: boolean;
  /** Whether any LIVE pick has landed — stored profiles from an edit don't count,
   *  which is what decides the arm button's wording. */
  hasPicks: boolean;
  mode: ExtrudeMode;
  extent: ExtrudeExtent;
  /** Whether a target part has to be chosen explicitly. False when each profile
   *  already names the body it acts on. */
  needsTarget: boolean;
  targetId: string | null;
  targetOptions: ExtrudeTargetOption[];
  distance: string;
  flip: boolean;
  /** Resolved label for the up-to face, null while empty. */
  upToLabel: string | null;
  /** True while the next viewport click fills the up-to face slot. */
  faceArmed: boolean;
  /** Validation or ghost-build error to show, if any. */
  message?: string | null;
  confirmDisabled: boolean;
  onToggleArming: () => void;
  onModeChange: (mode: ExtrudeMode) => void;
  onTargetChange: (id: string | null) => void;
  onExtentChange: (extent: ExtrudeExtent) => void;
  onArmFace: () => void;
  onClearFace: () => void;
  onDistanceChange: (distance: string) => void;
  onFlipChange: (flip: boolean) => void;
  onConfirm: () => void;
  /** Escape: stop the face pick, else stop arming profiles, else close — in that
   *  order, which is what the global handler does too. */
  onEscape: () => void;
  onCancel: () => void;
}

export function ExtrudeDialog({
  editing,
  x,
  y,
  groups,
  profileCount,
  arming,
  hasPicks,
  mode,
  extent,
  needsTarget,
  targetId,
  targetOptions,
  distance,
  flip,
  upToLabel,
  faceArmed,
  message,
  confirmDisabled,
  onToggleArming,
  onModeChange,
  onTargetChange,
  onExtentChange,
  onArmFace,
  onClearFace,
  onDistanceChange,
  onFlipChange,
  onConfirm,
  onEscape,
  onCancel,
}: Props) {
  const upTo = extent === "upToFace" || extent === "upToNext";

  return (
    <DraggableDialog className="feature-dialog" style={{ left: x, top: y }}>
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit extrude" : "Extrude"}
        {!editing && profileCount > 1 ? ` (${profileCount} profiles)` : ""}
      </div>
      {/* An accumulating slot (see PickSlot.tsx): one row per picked profile, and
          a button that keeps the arming live for the next. Clicking a listed
          profile in the viewport removes it. Profiles taken off a part are
          grouped under it, because in Add/Remove that is the body each one acts
          on. */}
      <div className="bool-group-label">Profiles</div>
      {groups.map((g) => (
        <Fragment key={g.key}>
          {groups.length > 1 && <div className="bool-group-label ed-subgroup">{g.label}</div>}
          {g.items.map((item) => (
            <PickedRow key={item.label} label={item.label} clearTitle="Remove" onClear={item.onRemove} />
          ))}
        </Fragment>
      ))}
      <PickButton noun="a profile" armed={arming} wide onClick={onToggleArming}>
        {arming ? "Select profiles (Esc to stop)" : hasPicks ? "Add more profiles" : undefined}
      </PickButton>
      <div className="ed-modes">
        {MODES.map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => onModeChange(m)}>
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      {mode !== "new" && needsTarget && (
        <label className="ed-field">
          <span>Target</span>
          <select value={targetId ?? ""} onChange={(e) => onTargetChange(e.target.value || null)}>
            <option value="" disabled>
              Select a part…
            </option>
            {targetOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode !== "new" && !needsTarget && profileCount > 0 && (
        <p className="ed-hint">{mode === "add" ? "Added to" : "Cut from"} the part each face belongs to.</p>
      )}
      <label className="ed-field">
        <span>Extent</span>
        <select value={extent} onChange={(e) => onExtentChange(e.target.value as ExtrudeExtent)}>
          <option value="blind">Blind</option>
          <option value="symmetric">Symmetric</option>
          {/* Through All only makes sense as a cut, so it's shown for Remove only. */}
          {mode === "remove" && <option value="throughAll">Through All</option>}
          <option value="upToFace">Up to face</option>
          {/* Up to next reaches the nearest body face ahead; like Up to face it's
              offered in every mode (it errors clearly if nothing lies ahead). */}
          <option value="upToNext">Up to next</option>
        </select>
      </label>
      {extent === "upToFace" && (
        <div className="ed-field">
          <span>Face</span>
          <PickSlot noun="a face" armed={faceArmed} value={upToLabel} onArm={onArmFace} onClear={onClearFace} />
        </div>
      )}
      {!upTo && (
        <label className="ed-field">
          <span>Distance</span>
          <input
            autoFocus
            value={distance}
            onChange={(e) => onDistanceChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConfirm();
              // The field has autoFocus, so Escape almost always lands here
              // rather than at the global handler.
              else if (e.key === "Escape") onEscape();
            }}
          />
        </label>
      )}
      {extent !== "symmetric" && extent !== "upToFace" && (
        <label className="ed-field ed-flip">
          <span>Flip direction</span>
          <input type="checkbox" checked={flip} onChange={(e) => onFlipChange(e.target.checked)} />
        </label>
      )}
      {/* Synchronous distance validation first (instant, kernel-free); the async
          ghost-build failure only shows once the field is sane. An empty field
          stays silent — the button is disabled but nothing is flagged as wrong. */}
      {message && <p className="ed-warning">{message}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={confirmDisabled} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
