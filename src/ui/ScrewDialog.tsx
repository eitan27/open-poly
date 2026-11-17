import { useRef, useState } from "react";
import { SCREW_HEAD_LABELS, type ScrewDims, type ScrewSettings } from "../document/screw";
import type { ScrewHead, ScrewParams } from "../document/types";
import { METRIC_SIZES } from "../geom/metricFasteners";
import { DraggableDialog } from "./DraggableDialog";
import { ExprInput } from "./ExprInput";
import { PickSlot } from "./PickSlot";
import { ScrewDiagram } from "./diagram/ScrewDiagram";
import "./GearDialog.css";

interface Props {
  editing?: boolean;
  settings: ScrewSettings;
  /** Hole features to put the screws in. */
  holeOptions: { id: string; name: string; size: string }[];
  /** The size the screw really is — a metric hole's, when it sits in one. */
  effectiveSize: string;
  planeLabel: string;
  defaultPlane: boolean;
  planeArmed: boolean;
  /** The last settings that made a screw, so the diagram holds still while a
   *  field is half-typed. */
  dims: ScrewDims | null;
  /** A modelled thread's clearance, resolved (undefined when cosmetic or unreadable). */
  clearance?: number;
  error: string | null;
  onArmPlane: () => void;
  onChange: (patch: Partial<ScrewSettings>) => void;
  onParam: (name: keyof ScrewParams, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const HEADS = Object.keys(SCREW_HEAD_LABELS) as ScrewHead[];

export function ScrewDialog({
  editing,
  settings,
  holeOptions,
  effectiveSize,
  planeLabel,
  defaultPlane,
  planeArmed,
  dims,
  clearance,
  error,
  onArmPlane,
  onChange,
  onParam,
  onConfirm,
  onCancel,
}: Props) {
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>());
  const inHole = !!settings.holeId;
  const sizeFollowsHole = inHole && effectiveSize !== settings.size;

  const field = (name: keyof ScrewParams, label: string, title?: string) => (
    <label
      className="ed-field"
      title={title}
      onMouseEnter={() => setHovered(name)}
      onMouseLeave={() => setHovered(null)}
    >
      <span>{label}</span>
      <ExprInput
        ref={(el: HTMLInputElement | null) => {
          if (el) inputs.current.set(name, el);
          else inputs.current.delete(name);
        }}
        value={settings.params[name] ?? ""}
        onFocus={(e) => {
          setFocused(name);
          e.currentTarget.select();
        }}
        onBlur={() => setFocused(null)}
        onChange={(e) => onParam(name, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm();
          else if (e.key === "Escape") onCancel();
        }}
      />
    </label>
  );
  const pick = (name: string) => {
    const el = inputs.current.get(name);
    if (el && !(el as HTMLInputElement).disabled) el.focus();
  };

  return (
    <DraggableDialog className="feature-dialog gear-dialog hole-dialog" style={{ right: 16, top: 64 }} baseTransform="">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit screw" : "Screw"}
      </div>
      <div
        className="ed-modes screw-heads"
        onMouseEnter={() => setHovered("head")}
        onMouseLeave={() => setHovered(null)}
      >
        {HEADS.map((h) => (
          <button key={h} className={settings.head === h ? "active" : ""} onClick={() => onChange({ head: h })}>
            {SCREW_HEAD_LABELS[h]}
          </button>
        ))}
      </div>

      {dims && (
        <ScrewDiagram
          dims={dims}
          clearance={settings.thread === "modelled" ? clearance : undefined}
          active={focused ?? hovered}
          onPick={pick}
        />
      )}

      <div className="ed-modes">
        <button
          className={inHole ? "active" : ""}
          disabled={holeOptions.length === 0}
          title={holeOptions.length ? "One screw in every hole of a Hole feature" : "No Hole feature yet"}
          onClick={() => onChange({ holeId: holeOptions.at(-1)?.id })}
        >
          In a hole
        </button>
        <button className={!inHole ? "active" : ""} onClick={() => onChange({ holeId: undefined })}>
          On a plane
        </button>
      </div>
      {inHole ? (
        <label className="ed-field">
          <span>Hole</span>
          <select value={settings.holeId} onChange={(e) => onChange({ holeId: e.target.value })}>
            {holeOptions.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({h.size})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <PickSlot
            noun="a plane or face"
            armed={planeArmed}
            value={defaultPlane ? `${planeLabel} (default)` : planeLabel}
            wide
            title="The head sits on this plane; the shank goes in against its normal"
            clearTitle="Pick a different plane or face"
            onArm={onArmPlane}
          />
          {field("centerX", "Center X")}
          {field("centerY", "Center Y")}
        </>
      )}

      <label
        className="ed-field"
        title={sizeFollowsHole ? "Follows the hole's size" : undefined}
        onMouseEnter={() => setHovered("size")}
        onMouseLeave={() => setHovered(null)}
      >
        <span>Size</span>
        <select
          ref={(el) => {
            if (el) inputs.current.set("size", el);
          }}
          value={effectiveSize}
          disabled={sizeFollowsHole}
          onFocus={() => setFocused("size")}
          onBlur={() => setFocused(null)}
          onChange={(e) => onChange({ size: e.target.value })}
        >
          {METRIC_SIZES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      {field(
        "length",
        settings.head === "flat" ? "Length (overall)" : "Length",
        "ISO length: under the head, or overall for a countersunk head",
      )}
      <label
        className="ed-field ed-flip"
        title="Cut the real ISO thread, to 3D print (stand it on its head). Off: a plain shank, much faster to build."
      >
        <span>Model the thread</span>
        <input
          type="checkbox"
          checked={settings.thread === "modelled"}
          onChange={(e) => onChange({ thread: e.target.checked ? "modelled" : "cosmetic" })}
        />
      </label>
      {settings.thread === "modelled" &&
        field(
          "clearance",
          "Clearance",
          "Radial gap (mm) the thread is shrunk by so it fits a printed nut or tapped hole — 0.1 suits most FDM printers; 0.15–0.2 if tight; 0 for an exact ISO thread",
        )}
      <label className="ed-field ed-flip" title="Point the screw the other way">
        <span>Flip direction</span>
        <input type="checkbox" checked={settings.flip} onChange={(e) => onChange({ flip: e.target.checked })} />
      </label>

      {error && <p className="ed-warning">{error}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={!!error} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
