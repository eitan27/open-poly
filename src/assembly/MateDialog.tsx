// Creating or editing a mate: its type, the two connectors (a face or edge of
// each part, picked in the viewport), how they face each other, and the values
// of whatever the mate leaves free. The assembly previews the mate live while
// this is open.
import { useEffect, useRef, useState } from "react";
import { shortcutName } from "../settings/shortcuts";
import { DraggableDialog } from "../ui/DraggableDialog";
import { PickSlot } from "../ui/PickSlot";
import type { Anchor } from "./frames";
import { MateIcon } from "./MateIcon";
import { dofLabel, MATE_TYPES } from "./mateTypes";
import { MATE_DOFS } from "./solve";
import type { Dof, MateType } from "./types";
import { ExprInput } from "../ui/ExprInput";

export interface MateSlotView {
  /** "Bracket <1> · face" once picked, else null. */
  label: string | null;
  /** What the slot still needs, when it's part-filled (a width mate's
   *  second face): replaces its usual prompt. */
  noun?: string;
  armed: boolean;
  /** The anchors the picked entity offers (a cylinder: middle and both ends). */
  anchors: Anchor[];
  anchor: Anchor;
  onArm: () => void;
  onAnchor: (a: Anchor) => void;
  /** The connector moved within its own frame (mm, expressions). */
  offset: Partial<Record<"x" | "y" | "z", string>>;
  onOffset: (axis: "x" | "y" | "z", text: string) => void;
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
  /** Show the type keys on their buttons (the ? toggle). */
  showShortcuts?: boolean;
  /** Mates made since it opened (by clicking on to the next face): Cancel
   *  then reads Close, as those are kept. */
  made?: number;
}

const ANCHOR_LABELS: Record<Anchor, string> = { center: "Middle", start: "Start", end: "End" };

const selectAll = (e: React.FocusEvent<HTMLInputElement>) => e.target.select();

export function MateDialog(p: MateDialogProps) {
  const dofs = MATE_DOFS[p.type];
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && p.canConfirm) p.onConfirm();
  };
  return (
    <DraggableDialog
      className="feature-dialog asm-mate"
      // Top left of the view, under the toolbar: clear of the middle, where the
      // faces to pick usually are.
      style={{ left: 16, top: 72 }}
    >
      <div className="ed-title" data-drag-handle>
        {p.editing ? "Edit mate" : "Mate"}
        {!!p.made && <span className="asm-mate-made"> · {p.made} made</span>}
      </div>
      <MateTypePicker type={p.type} onType={p.onType} />
      {p.slots.map((s, i) => (
        <div key={i} className="asm-mate-slot">
          <PickSlot
            noun={
              s.noun ??
              (p.type === "width"
                ? `two faces of the ${i === 0 ? "first" : "second"} part`
                : `a face or edge of the ${i === 0 ? "first" : "second"} part`)
            }
            armed={s.armed}
            value={s.label}
            wide
            onArm={s.onArm}
          />
          {s.label && (
            <div
              className="asm-mate-limits asm-mate-offset"
              title="Moves this side's connector within its own frame. Leave blank for none"
            >
              <span>Offset</span>
              {(["x", "y", "z"] as const).map((k) => (
                <ExprInput
                  key={k}
                  aria-label={`${s.label} offset ${k.toUpperCase()}`}
                  placeholder={k.toUpperCase()}
                  value={s.offset[k] ?? ""}
                  onFocus={selectAll}
                  onChange={(e) => s.onOffset(k, e.target.value)}
                  onKeyDown={keys}
                />
              ))}
            </div>
          )}
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
            <ExprInput
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
              <ExprInput
                aria-label={`${dofLabel(p.type, d)} minimum`}
                placeholder="min"
                value={p.limits[d]?.min ?? ""}
                onFocus={selectAll}
                onChange={(e) => p.onLimit(d, "min", e.target.value)}
                onKeyDown={keys}
              />
              <ExprInput
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
        <button onClick={p.onCancel}>{p.made ? "Close" : "Cancel"}</button>
      </div>
    </DraggableDialog>
  );
}

/** The mate's type: one button showing it, opening a menu of all seven. The
 *  toolbar has a button per type already, so the dialog needn't show them all.
 *  A custom menu, not a <select>: on macOS a select's native popup swallows
 *  the next click on the canvas (see TransformDialog), which here is the first
 *  face pick. Esc or a click elsewhere closes it; the type keys still switch. */
function MateTypePicker({ type, onType }: { type: MateType; onType: (t: MateType) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  const current = MATE_TYPES.find((t) => t.type === type)!;
  return (
    <div
      className="mt-dropdown asm-mate-type"
      ref={wrap}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="asm-mate-type-btn"
        title={`${current.title}. Change the type (or press its key)`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MateIcon type={type} />
        <span className="asm-mate-type-name">{current.label}</span>
        <span className="asm-mate-type-caret">▾</span>
      </button>
      {open && (
        <div className="mt-menu asm-mate-types" role="menu">
          {MATE_TYPES.map((t) => (
            <button
              key={t.type}
              type="button"
              role="menuitemradio"
              aria-checked={t.type === type}
              className={t.type === type ? "active" : ""}
              title={t.title}
              onClick={() => {
                onType(t.type);
                setOpen(false);
              }}
            >
              <MateIcon type={t.type} />
              <span className="asm-mate-type-name">{t.label}</span>
              <span className="asm-mate-type-key">{shortcutName(t.key)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
