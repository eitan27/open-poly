// Creating or editing a mate: its type, the two connectors (a face or edge of
// each part, picked in the viewport), how they face each other, and the values
// of whatever the mate leaves free. The assembly previews the mate live while
// this is open.
import { DraggableDialog } from "../ui/DraggableDialog";
import { PickSlot } from "../ui/PickSlot";
import type { Anchor } from "./frames";
import { MATE_DOFS } from "./solve";
import type { Dof, MateType } from "./types";

export interface MateSlotView {
  /** "Bracket <1> · face" once picked, else null. */
  label: string | null;
  armed: boolean;
  /** The anchors the picked entity offers (a cylinder: middle and both ends). */
  anchors: Anchor[];
  anchor: Anchor;
  onArm: () => void;
  onAnchor: (a: Anchor) => void;
}

export interface MateDialogProps {
  editing: boolean;
  type: MateType;
  onType: (t: MateType) => void;
  slots: [MateSlotView, MateSlotView];
  flip: boolean;
  onFlip: () => void;
  onTurn: () => void;
  values: Partial<Record<Dof, string>>;
  onValue: (d: Dof, text: string) => void;
  limits: Partial<Record<Dof, { min?: string; max?: string }>>;
  onLimit: (d: Dof, end: "min" | "max", text: string) => void;
  message: string | null;
  canConfirm: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const TYPES: { type: MateType; label: string; title: string }[] = [
  { type: "fastened", label: "Fastened", title: "Fixed together: no motion" },
  { type: "revolute", label: "Revolute", title: "Turns about the axis: a hinge, a wheel on an axle" },
  { type: "slider", label: "Slider", title: "Slides along the axis: a drawer, a piston" },
  { type: "cylindrical", label: "Cylindrical", title: "Slides along and turns about the axis: a shaft in a bushing" },
  { type: "planar", label: "Planar", title: "Slides and turns on the plane: a part on a table" },
  { type: "ball", label: "Ball", title: "Turns any way about the point: a ball joint" },
];

const ANCHOR_LABELS: Record<Anchor, string> = { center: "Middle", start: "Start", end: "End" };

function dofLabel(type: MateType, d: Dof): string {
  if (type === "ball") return `Turn ${d[1].toUpperCase()} (°)`;
  if (d === "rz") return "Angle (°)";
  if (d === "tz") return "Distance (mm)";
  return `Offset ${d[1].toUpperCase()} (mm)`;
}

const selectAll = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

export function MateDialog(p: MateDialogProps) {
  const dofs = MATE_DOFS[p.type];
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && p.canConfirm) p.onConfirm();
  };
  return (
    <DraggableDialog
      className="feature-dialog asm-mate"
      style={{ left: "50%", top: 64 }}
      baseTransform="translateX(-50%)"
    >
      <div className="ed-title" data-drag-handle>
        {p.editing ? "Edit mate" : "Mate"}
      </div>
      <div className="ed-modes asm-mate-types">
        {TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            className={p.type === t.type ? "active" : ""}
            title={t.title}
            onClick={() => p.onType(t.type)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {p.slots.map((s, i) => (
        <div key={i} className="asm-mate-slot">
          <PickSlot
            noun={i === 0 ? "a face or edge of the first part" : "a face or edge of the second part"}
            armed={s.armed}
            value={s.label}
            wide
            onArm={s.onArm}
          />
          {s.label && s.anchors.length > 1 && (
            <div className="ed-modes">
              {s.anchors.map((a) => (
                <button key={a} className={s.anchor === a ? "active" : ""} onClick={() => s.onAnchor(a)}>
                  {ANCHOR_LABELS[a]}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <div className="ed-modes">
        <button
          className={p.flip ? "active" : ""}
          title="Face the second part the other way along the axis"
          onClick={p.onFlip}
        >
          Flip
        </button>
        <button title="Turn the second part a quarter turn about the axis" onClick={p.onTurn}>
          Rotate 90°
        </button>
      </div>
      {dofs.map((d) => (
        <div key={d} className="asm-mate-dof">
          <label className="ed-field">
            <span>{dofLabel(p.type, d)}</span>
            <input
              value={p.values[d] ?? ""}
              placeholder="0"
              onFocus={selectAll}
              onChange={(e) => p.onValue(d, e.target.value)}
              onKeyDown={keys}
            />
          </label>
          {p.type !== "ball" && (
            <div className="asm-mate-limits" title="Leave blank for no limit">
              <span>Limits</span>
              <input
                aria-label={`${dofLabel(p.type, d)} minimum`}
                placeholder="min"
                value={p.limits[d]?.min ?? ""}
                onFocus={selectAll}
                onChange={(e) => p.onLimit(d, "min", e.target.value)}
                onKeyDown={keys}
              />
              <input
                aria-label={`${dofLabel(p.type, d)} maximum`}
                placeholder="max"
                value={p.limits[d]?.max ?? ""}
                onFocus={selectAll}
                onChange={(e) => p.onLimit(d, "max", e.target.value)}
                onKeyDown={keys}
              />
            </div>
          )}
        </div>
      ))}
      {p.message && <p className="ed-warning">{p.message}</p>}
      <div className="ed-actions">
        <button className="ed-primary" onClick={p.onConfirm} disabled={!p.canConfirm}>
          {p.editing ? "Done" : "Create"}
        </button>
        <button onClick={p.onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
