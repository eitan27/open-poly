import { useRef, useState } from "react";
import { SCREW_HEAD_LABELS, type ScrewDims, type ScrewSettings } from "../document/screw";
import type { ScrewHead, ScrewParams } from "../document/types";
import { METRIC_SIZES } from "../geom/metricFasteners";
import { DraggableDialog } from "./DraggableDialog";
import { ExprInput } from "./ExprInput";
import { PickButton, PickedRow } from "./PickSlot";
import { ScrewDiagram } from "./diagram/ScrewDiagram";
import "./GearDialog.css";

interface Props {
  editing?: boolean;
  settings: ScrewSettings;
  /** The size the screw really is — a metric hole's, when it sits in one. */
  effectiveSize: string;
  /** No location picked: one screw at the Top plane's origin. */
  defaultLocation: boolean;
  /** The slot is listening: viewport picks add or remove locations. */
  locating: boolean;
  /** The Hole it's in, if any (for the hint and the size note). */
  holeName?: string;
  /** One row per screw, in the order its parts are numbered. */
  rows: { key: string; label: string }[];
  onRemoveRow: (index: number) => void;
  /** A row hovered (its screw lit in the viewport), or none. */
  onHoverRow: (index: number | null) => void;
  /** The last settings that made a screw, so the diagram holds still while a
   *  field is half-typed. */
  dims: ScrewDims | null;
  /** A modelled thread's clearance, resolved (undefined when cosmetic or unreadable). */
  clearance?: number;
  error: string | null;
  onArmLocations: (on: boolean) => void;
  onClearLocations: () => void;
  onChange: (patch: Partial<ScrewSettings>) => void;
  onParam: (name: keyof ScrewParams, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const HEADS = Object.keys(SCREW_HEAD_LABELS) as ScrewHead[];

export function ScrewDialog({
  editing,
  settings,
  effectiveSize,
  defaultLocation,
  locating,
  holeName,
  rows,
  onRemoveRow,
  onHoverRow,
  dims,
  clearance,
  error,
  onArmLocations,
  onClearLocations,
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

      {/* Where: an accumulating slot, as Extrude's profiles (see PickSlot.tsx)
          — one row per screw, each with its ✕, and a button that keeps the
          slot listening for more. A click on a Hole's hole puts a screw in each
          of its holes (following them); anywhere else on a face, a sketch
          point or a plane, one screw, going into it the way the cursor shows.
          With nothing picked: one on the Top plane's origin, a row whose ✕
          starts picking. Clicking a placed one in the viewport removes it. */}
      <div className="bool-group-label">Locations</div>
      {defaultLocation ? (
        !locating && <PickedRow label="Top plane (default)" clearTitle="Select locations" onClear={onClearLocations} />
      ) : (
        <div className="screw-rows" onMouseLeave={() => onHoverRow(null)}>
          {rows.map((r, i) => (
            <div key={r.key} onMouseEnter={() => onHoverRow(i)}>
              <PickedRow
                label={rows.length > 1 ? `${i + 1}. ${r.label}` : r.label}
                title={r.label}
                clearTitle="Remove"
                onClear={() => {
                  onHoverRow(null);
                  onRemoveRow(i);
                }}
              />
            </div>
          ))}
        </div>
      )}
      <PickButton noun="locations" armed={locating} wide onClick={() => onArmLocations(!locating)}>
        {locating ? "Select locations (Esc to stop)" : defaultLocation ? undefined : "Add more locations"}
      </PickButton>
      {locating && (
        <p className="ed-hint">
          {defaultLocation
            ? "Select a hole for a screw in each of its holes, or points, faces and planes for one each. Until then it stays on Top."
            : `Select more — each goes into the face it's on${inHole ? ` (screws in ${holeName ?? "the hole"} follow it)` : ""}. Select one again to remove it.`}
        </p>
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
        <span>Include thread</span>
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
