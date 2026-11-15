import { useRef, useState } from "react";
import { HOLE_FIT_LABELS, HOLE_TYPE_LABELS, holeReadout, type HoleDims, type HoleSettings } from "../document/hole";
import type { HoleParams, HoleType, ThreadMode } from "../document/types";
import { METRIC, METRIC_SIZES, isMetricSize, type HoleFit } from "../geom/metricFasteners";
import { DraggableDialog } from "./DraggableDialog";
import { ExprInput } from "./ExprInput";
import { HoleDiagram } from "./diagram/HoleDiagram";
import "./GearDialog.css";

export interface HoleOption {
  id: string;
  name: string;
}

interface Props {
  editing?: boolean;
  settings: HoleSettings;
  sketchId: string | null;
  /** Sketches with at least one point or circle, newest last. */
  sketchOptions: (HoleOption & { points: number })[];
  targetId: string | null;
  targetOptions: HoleOption[];
  /** The settings resolved to numbers — the last ones that made a hole, so
   *  the diagram doesn't vanish while a field is half-typed. Null only when
   *  nothing valid has been entered yet. */
  dims: HoleDims | null;
  error: string | null;
  onSketchChange: (id: string) => void;
  onTargetChange: (id: string) => void;
  onChange: (patch: Partial<HoleSettings>) => void;
  onParam: (name: keyof HoleParams, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const HOLE_TYPES = Object.keys(HOLE_TYPE_LABELS) as HoleType[];
const FITS = Object.keys(HOLE_FIT_LABELS) as HoleFit[];

/** Which table value stands in for a param when the size is metric. */
function metricValue(settings: HoleSettings, name: keyof HoleParams): string | null {
  if (!isMetricSize(settings.size)) return null;
  const m = METRIC[settings.size];
  switch (name) {
    case "diameter":
      return String(settings.holeType === "tapped" ? m.tapDrill : m.clearance[settings.fit]);
    case "counterboreDiameter":
      return String(m.counterbore.diameter);
    case "counterboreDepth":
      return String(m.counterbore.depth);
    case "countersinkDiameter":
      return String(m.countersink.diameter);
    case "countersinkAngle":
      return String(m.countersink.angle);
    default:
      return null;
  }
}

export function HoleDialog({
  editing,
  settings,
  sketchId,
  sketchOptions,
  targetId,
  targetOptions,
  dims,
  error,
  onSketchChange,
  onTargetChange,
  onChange,
  onParam,
  onConfirm,
  onCancel,
}: Props) {
  // The dimension to light up in the diagram: whatever field has focus, or
  // the one under the pointer.
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement | HTMLSelectElement>());
  const p = settings.params;
  const t = settings.holeType;
  const blind = settings.extent === "blind";
  const metric = isMetricSize(settings.size);

  const field = (name: keyof HoleParams, label: string, title?: string) => {
    // A modelled thread's drill is capped at the thread's minor diameter
    // (plus clearance), which depends on the clearance expression — so it is
    // read from the resolved dims rather than the table.
    const fixed =
      name === "diameter" && t === "tapped" && dims?.modelledThread
        ? String(Math.round(dims.diameter * 1000) / 1000)
        : metricValue(settings, name);
    return (
      <label
        className="ed-field"
        title={fixed !== null ? `From the ${settings.size} table — choose Custom size to type your own` : title}
        onMouseEnter={() => setHovered(name)}
        onMouseLeave={() => setHovered(null)}
      >
        <span>{label}</span>
        <ExprInput
          ref={(el: HTMLInputElement | null) => {
            if (el) inputs.current.set(name, el);
          }}
          value={fixed ?? p[name] ?? ""}
          disabled={fixed !== null}
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
  };

  // A dimension clicked in the diagram focuses its field; a table-driven one
  // has nothing to type into, so it focuses the Size picker instead.
  const pick = (name: string) => {
    const el = inputs.current.get(name);
    if (el && !(el as HTMLInputElement).disabled) el.focus();
    else inputs.current.get("size")?.focus();
  };

  const seg = <T extends string>(value: T, options: T[], labels: Record<T, string>, set: (v: T) => void) => (
    <div className="ed-modes">
      {options.map((o) => (
        <button key={o} className={value === o ? "active" : ""} onClick={() => set(o)}>
          {labels[o]}
        </button>
      ))}
    </div>
  );

  return (
    <DraggableDialog className="feature-dialog gear-dialog hole-dialog" style={{ right: 16, top: 64 }} baseTransform="">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit hole" : "Hole"}
      </div>
      {seg(t, HOLE_TYPES, HOLE_TYPE_LABELS, (holeType) => onChange({ holeType }))}

      {dims && <HoleDiagram dims={dims} size={settings.size} active={focused ?? hovered} onPick={pick} />}

      <label className="ed-field">
        <span>Sketch</span>
        <select value={sketchId ?? ""} onChange={(e) => onSketchChange(e.target.value)}>
          <option value="" disabled>
            {sketchOptions.length ? "Select a sketch…" : "No sketch with points"}
          </option>
          {sketchOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.points} {s.points === 1 ? "hole" : "holes"})
            </option>
          ))}
        </select>
      </label>
      <label className="ed-field">
        <span>Body</span>
        <select value={targetId ?? ""} onChange={(e) => onTargetChange(e.target.value)}>
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

      <label className="ed-field" onMouseEnter={() => setHovered("size")} onMouseLeave={() => setHovered(null)}>
        <span>Size</span>
        <select
          ref={(el) => {
            if (el) inputs.current.set("size", el);
          }}
          value={settings.size}
          onFocus={() => setFocused("size")}
          onBlur={() => setFocused(null)}
          onChange={(e) => onChange({ size: e.target.value })}
        >
          {METRIC_SIZES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {metric && t !== "tapped" && (
        <div title="Clearance for the screw: ISO 273 fine / medium / coarse">
          {seg(settings.fit, FITS, HOLE_FIT_LABELS, (fit) => onChange({ fit }))}
        </div>
      )}

      {t === "tapped" && (
        <div
          title={
            metric
              ? "Modelled: a real ISO thread you can 3D print (grown by the clearance so a printed screw fits). Cosmetic: just the tap drill, for a thread tapped after."
              : "Modelled threads need a metric size"
          }
        >
          {seg(
            metric ? (settings.thread ?? "cosmetic") : "cosmetic",
            ["modelled", "cosmetic"] as const as ThreadMode[],
            { modelled: "Modelled thread", cosmetic: "Cosmetic" },
            (thread) => metric && onChange({ thread }),
          )}
        </div>
      )}
      {field("diameter", t === "tapped" ? (dims?.modelledThread ? "Drill Ø" : "Tap drill Ø") : "Diameter")}
      {t === "counterbore" && field("counterboreDiameter", "Counterbore Ø")}
      {t === "counterbore" && field("counterboreDepth", "Counterbore depth")}
      {t === "countersink" && field("countersinkDiameter", "Countersink Ø")}
      {t === "countersink" && field("countersinkAngle", "Countersink °")}
      {t === "tapped" && blind && field("threadDepth", "Thread depth", "How deep the thread runs")}
      {t === "tapped" &&
        dims?.modelledThread &&
        field(
          "clearance",
          "Clearance",
          "Radial gap (mm) the thread is grown by so a printed screw fits — 0.1 suits most FDM printers; 0.15–0.2 if tight; 0 for an exact ISO thread",
        )}

      {seg(
        settings.extent,
        ["blind", "throughAll"] as const as ("blind" | "throughAll")[],
        { blind: "Blind", throughAll: "Through all" },
        (extent) => onChange({ extent }),
      )}
      {blind && field("depth", "Depth")}
      {blind && field("tipAngle", "Tip angle °", "Included angle of the drill point; 0 for a flat bottom")}
      <label className="ed-field ed-flip" title="Drill the other way (out of the sketch plane's front)">
        <span>Flip direction</span>
        <input type="checkbox" checked={settings.flip} onChange={(e) => onChange({ flip: e.target.checked })} />
      </label>

      {dims && !error && <div className="gear-readout">{holeReadout(dims, settings.size)}</div>}
      {error && <p className="ed-warning">{error}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={!!error || !sketchId || !targetId} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
