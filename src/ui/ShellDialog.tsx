import { DraggableDialog } from "./DraggableDialog";
import { PickButton, PickedRow, PickSlot } from "./PickSlot";

export interface ShellFaceRow {
  /** The persistent face name — the row's key and its tooltip. */
  name: string;
  /** The same name with its body prefix stripped, for display. */
  label: string;
}

interface Props {
  /** True once this is editing a committed shell rather than still creating one.
   *  `editId` alone is not enough: it is set the moment a Create commits, so that
   *  a retry updates that feature instead of adding another — but until it BUILDS
   *  this is still the creation the user started, and saying "Edit" would be news
   *  to them. */
  editing: boolean;
  /** Resolved body name, null while no body is picked. */
  bodyLabel: string | null;
  bodyArmed: boolean;
  faces: ShellFaceRow[];
  facesArmed: boolean;
  thickness: string;
  /** Validation or geometry error to show, if any. */
  message?: string | null;
  confirmDisabled: boolean;
  /** Hollowing a loft is seconds of OCCT work with nothing to see. */
  busy: boolean;
  onArmBody: () => void;
  onToggleFaces: () => void;
  onRemoveFace: (name: string) => void;
  onThicknessChange: (thickness: string) => void;
  onConfirm: () => void;
  /** Escape: disarm if arming, else close — in that order, or stopping a face
   *  pick would blow away the whole dialog. */
  onEscape: () => void;
  onCancel: () => void;
}

export function ShellDialog({
  editing,
  bodyLabel,
  bodyArmed,
  faces,
  facesArmed,
  thickness,
  message,
  confirmDisabled,
  busy,
  onArmBody,
  onToggleFaces,
  onRemoveFace,
  onThicknessChange,
  onConfirm,
  onEscape,
  onCancel,
}: Props) {
  return (
    <DraggableDialog className="feature-dialog" style={{ left: "50%", top: 64 }} baseTransform="translateX(-50%)">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit " : ""}Shell
      </div>
      <div className="bool-group-label">Body</div>
      <PickSlot noun="a body" armed={bodyArmed} value={bodyLabel} wide onArm={onArmBody} />
      {/* Openings are optional — no faces means a fully sealed hollow shell, which
          is the common case and so must not require a pick to get to. */}
      <div className="bool-group-label">Faces to open (optional)</div>
      {faces.map((f) => (
        <PickedRow
          key={f.name}
          label={f.label}
          title={f.name}
          clearTitle="Remove"
          onClear={() => onRemoveFace(f.name)}
        />
      ))}
      <PickButton noun="faces" armed={facesArmed} wide disabled={!bodyLabel} onClick={onToggleFaces}>
        {/* An accumulating slot: it keeps taking clicks after the first, so it
            says how to stop and how to add more. */}
        {facesArmed ? "Select faces (Esc to stop)" : faces.length ? "Add more faces" : undefined}
      </PickButton>
      <label className="ed-field">
        <span>Thickness</span>
        <input
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          value={thickness}
          onChange={(e) => onThicknessChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm();
            // The thickness field has autoFocus, so Escape almost always arrives
            // here rather than at the global handler.
            else if (e.key === "Escape") onEscape();
          }}
        />
      </label>
      {message && <p className="ed-warning">{message}</p>}
      <div className="ed-actions">
        <button className="ed-primary" onClick={onConfirm} disabled={confirmDisabled || busy}>
          {busy ? "Working…" : editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
