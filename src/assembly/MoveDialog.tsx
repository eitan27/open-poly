// Moving a placed instance with the transform gizmo: translate along the world
// axes, or rotate about a world axis through its centre. The gizmo is the same
// one a part's Transform uses; this is its panel. A mated instance moves only
// along what its mate leaves free (a hinge about its axis, a slider along it).
//
// Like a part's Transform panel, it reads out the numbers live while the gizmo
// is dragged and takes typed ones: how far the part has moved since it was
// selected, or, for a part one mate positions, that mate's own values. Done
// keeps the move; Cancel (or Esc) puts back what this session moved.
import { useRef, useState } from "react";
import { DraggableDialog } from "../ui/DraggableDialog";
import type { MateType } from "./types";

/** One number in the panel: shown live, typed to set. */
export interface MoveField {
  key: string;
  label: string;
  /** The current value, already formatted (live while dragging). */
  value: string;
  /** A typed value, on Enter or leaving the field. */
  onCommit: (text: string) => void;
}

export type MoveMode = "translate" | "rotate";
export type WorldAxis = "x" | "y" | "z";

interface Props {
  name: string;
  grounded: boolean;
  mode: MoveMode;
  axis: WorldAxis;
  /** The mate that positions it, if one does. */
  mate: { name: string; type: MateType } | null;
  canTranslate: boolean;
  canRotate: boolean;
  /** Why the last drag couldn't be applied. */
  message: string | null;
  fields: MoveField[];
  onMode: (mode: MoveMode) => void;
  onAxis: (axis: WorldAxis) => void;
  onUnground: () => void;
  /** Keep what this session moved, and close. */
  onDone: () => void;
  /** Put back what this session moved, and close. */
  onCancel: () => void;
}

export function MoveDialog(p: Props) {
  return (
    <DraggableDialog
      className="feature-dialog asm-move"
      // Top left of the view, like the Mate dialog: clear of the middle, where
      // the gizmo and the part are.
      style={{ left: 16, top: 72 }}
    >
      <div className="ed-title" data-drag-handle>
        {p.name}
      </div>
      {p.grounded ? (
        <>
          <p className="ed-hint">Grounded: it stays where it is.</p>
          <button className="text-btn" onClick={p.onUnground}>
            Unground to move it
          </button>
        </>
      ) : p.mate?.type === "fastened" ? (
        <p className="ed-hint">Fastened by {p.mate.name}: it moves with the part it's fastened to.</p>
      ) : (
        <>
          {p.canTranslate && p.canRotate && (
            <div className="ed-modes">
              <button className={p.mode === "translate" ? "active" : ""} onClick={() => p.onMode("translate")}>
                Move
              </button>
              <button className={p.mode === "rotate" ? "active" : ""} onClick={() => p.onMode("rotate")}>
                Rotate
              </button>
            </div>
          )}
          {p.mode === "rotate" && (!p.mate || p.mate.type === "ball") && (
            <>
              <div className="bool-group-label">About</div>
              <div className="ed-modes">
                {(["x", "y", "z"] as const).map((a) => (
                  <button key={a} className={p.axis === a ? "active" : ""} onClick={() => p.onAxis(a)}>
                    {a.toUpperCase()}
                  </button>
                ))}
              </div>
            </>
          )}
          {p.fields.map((f) => (
            <NumField key={f.key} field={f} />
          ))}
          <p className="ed-hint">
            Drag the gizmo to {p.mate ? `move it along ${p.mate.name}` : p.mode === "rotate" ? "turn it" : "move it"},
            or type exact values.
          </p>
          {p.message && <p className="ed-warning">{p.message}</p>}
          <div className="ed-actions">
            <button className="ed-primary" onClick={p.onDone}>
              Done
            </button>
            <button onClick={p.onCancel}>Cancel</button>
          </div>
        </>
      )}
    </DraggableDialog>
  );
}

/** Shows the live value until it's being typed in; Enter or leaving commits,
 *  Escape puts it back. */
function NumField({ field }: { field: MoveField }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const commit = () => {
    if (!cancelled.current && draft !== null && draft.trim() && draft !== field.value) field.onCommit(draft);
    cancelled.current = false;
    setDraft(null);
  };
  return (
    <label className="ed-field">
      <span>{field.label}</span>
      <input
        value={draft ?? field.value}
        onFocus={(e) => {
          setDraft(field.value);
          e.target.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            cancelled.current = true;
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
    </label>
  );
}
