import { useRef, useState } from "react";
import { HOLE_FIT_LABELS, HOLE_TYPE_LABELS, type HoleDims, type HoleSettings } from "../document/hole";
import type { HoleParams, HoleType } from "../document/types";
import {
  METRIC,
  METRIC_SIZES,
  clearanceHoleDiameter,
  isMetricSize,
  type HoleFit,
  type MetricSize,
} from "../geom/metricFasteners";
import { DraggableDialog } from "./DraggableDialog";
import { PickButton } from "./PickSlot";
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
  /** Which slot the next viewport click fills. */
  armed: "points" | "parts" | null;
  /** Every part, for naming the picked ones. */
  partOptions: HoleOption[];
  /** The settings resolved to numbers — the last ones that made a hole, so
   *  the diagram doesn't vanish while a field is half-typed. Null only when
   *  nothing valid has been entered yet. */
  dims: HoleDims | null;
  error: string | null;
  onArm: (slot: "points" | "parts" | null) => void;
  onClearPoints: () => void;
  onAllParts: () => void;
  onChange: (patch: Partial<HoleSettings>) => void;
  onParam: (name: keyof HoleParams, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const HOLE_TYPES = Object.keys(HOLE_TYPE_LABELS) as HoleType[];
const FITS = Object.keys(HOLE_FIT_LABELS) as HoleFit[];
const fmtGap = (n: number) => String(Math.round(n * 100) / 100);

/** Which table value stands in for a param when the size is metric. */
function metricValue(settings: HoleSettings, name: keyof HoleParams): string | null {
  if (!isMetricSize(settings.size)) return null;
  const m = METRIC[settings.size];
  switch (name) {
    case "diameter":
      return String(settings.holeType === "tapped" ? m.tapDrill : clearanceHoleDiameter(m, settings.fit));
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
  armed,
  partOptions,
  dims,
  error,
  onArm,
  onClearPoints,
  onAllParts,
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
  const nPoints = settings.points?.length ?? 0;
  const nParts = settings.scope?.length ?? 0;
  // "Subset" chosen but nothing picked yet still cuts everything.
  const [subset, setSubset] = useState(nParts > 0);
  const drillPoint = Number(p.tipAngle) !== 0;

  const field = (name: keyof HoleParams, label: string, title?: string) => {
    // A modelled thread's drill is capped at the thread's minor diameter
    // (plus clearance), which depends on the clearance expression — so it is
    // read from the resolved dims rather than the table.
    const fixed =
      name === "diameter" && t === "tapped" && dims?.modelledThread
        ? String(Math.round(dims.diameter * 1000) / 1000)
        : metricValue(settings, name);
    // From the table: a value to read, not a greyed-out box to puzzle over.
    if (fixed !== null)
      return (
        <div
          className="ed-field ed-derived"
          title={`${title ? title + ". " : ""}From the ${settings.size} table — choose Custom size to type your own`}
          onMouseEnter={() => setHovered(name)}
          onMouseLeave={() => setHovered(null)}
          onClick={() => setFocused(name)}
        >
          <span>{label}</span>
          <span className="ed-derived-value">{fixed}</span>
        </div>
      );
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

  return (
    <DraggableDialog className="feature-dialog gear-dialog hole-dialog" style={{ right: 16, top: 64 }} baseTransform="">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit hole" : "Hole"}
      </div>
      <label className="ed-field">
        <span>Type</span>
        <select value={t} onChange={(e) => onChange({ holeType: e.target.value as HoleType })}>
          {HOLE_TYPES.map((h) => (
            <option key={h} value={h}>
              {HOLE_TYPE_LABELS[h]}
            </option>
          ))}
        </select>
      </label>

      {dims && <HoleDiagram dims={dims} size={settings.size} active={focused ?? hovered} onPick={pick} />}

      <div className="ed-field" title="Where the holes go: points, faces (their centre) or sketch entities">
        <span>Targets</span>
        <span className="hole-location">
          <PickButton
            noun="targets"
            armed={armed === "points"}
            onClick={() => onArm(armed === "points" ? null : "points")}
          >
            {nPoints ? `${nPoints} ${nPoints === 1 ? "target" : "targets"}` : "Select…"}
          </PickButton>
          {nPoints > 0 && (
            <button type="button" className="bool-operand-x" title="Clear the targets" onClick={onClearPoints}>
              ✕
            </button>
          )}
        </span>
      </div>
      {armed === "points" && (
        <p className="ed-hint">
          {nPoints === 0
            ? "Select points, faces (their centre) or sketch entities (centres, ends, midpoints)."
            : "Select more — each drills into the face it's on. Select one again to remove it, or from an edge's other face to drill from there."}
        </p>
      )}

      <label className="ed-field" title="The parts the holes cut: every part they reach, or only the ones you pick">
        <span>Affected parts</span>
        <select
          value={subset ? "subset" : "all"}
          onChange={(e) => {
            if (e.target.value === "subset") {
              setSubset(true);
              onArm("parts");
            } else {
              setSubset(false);
              onAllParts();
            }
          }}
        >
          <option value="all">All parts</option>
          <option value="subset">Subset</option>
        </select>
      </label>
      {subset && (
        <div className="ed-field" title="Select the parts to cut; select one again to drop it">
          <span />
          <span className="hole-location">
            <PickButton
              noun="parts"
              armed={armed === "parts"}
              onClick={() => onArm(armed === "parts" ? null : "parts")}
            >
              {nParts ? `${nParts} ${nParts === 1 ? "part" : "parts"}` : "Select…"}
            </PickButton>
          </span>
        </div>
      )}
      {subset && nParts > 0 && (
        <p className="ed-hint">
          Cuts only {(settings.scope ?? []).map((id) => partOptions.find((o) => o.id === id)?.name ?? id).join(", ")}.
        </p>
      )}

      <label
        className="ed-field"
        title={
          t === "tapped"
            ? "The thread to tap: the screw's nominal diameter × pitch. The hole drilled for it (the tap drill) is smaller — the thread's teeth are cut into its wall"
            : "The screw this hole is for. The hole itself is a little wider (its clearance), so the screw passes freely"
        }
        onMouseEnter={() => setHovered("size")}
        onMouseLeave={() => setHovered(null)}
      >
        <span>{t === "tapped" ? "Thread" : "Screw size"}</span>
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
              {t === "tapped" ? `${m} × ${METRIC[m].pitch}` : m}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </label>
      {metric && t !== "tapped" && (
        <label
          className="ed-field"
          title="How much wider than the screw the hole is: ISO 273 fine / medium / coarse, or Exact — the screw's own diameter, for a press fit or a printer that adds its own gap"
        >
          <span>Fit</span>
          <select value={settings.fit} onChange={(e) => onChange({ fit: e.target.value as HoleFit })}>
            {FITS.map((f) => (
              <option key={f} value={f}>
                {HOLE_FIT_LABELS[f]} (+
                {fmtGap(
                  clearanceHoleDiameter(METRIC[settings.size as MetricSize], f) - METRIC[settings.size as MetricSize].d,
                )}
                )
              </option>
            ))}
          </select>
        </label>
      )}

      {t === "tapped" && (
        <label
          className="ed-field ed-flip"
          title={
            metric
              ? "Cut the real ISO thread into the wall, to 3D print (grown by the clearance so a printed screw fits). Off: just the tap drill's plain bore, for a thread tapped afterwards."
              : "Modelled threads need a metric size"
          }
        >
          <span>Model the thread</span>
          <input
            type="checkbox"
            disabled={!metric}
            checked={metric && settings.thread === "modelled"}
            onChange={(e) => onChange({ thread: e.target.checked ? "modelled" : "cosmetic" })}
          />
        </label>
      )}
      {field(
        "diameter",
        t === "tapped" ? (dims?.modelledThread ? "Drill Ø" : "Tap drill Ø") : metric ? "Hole Ø" : "Diameter",
        t === "tapped"
          ? "The hole drilled before tapping: smaller than the thread, which is cut into its wall"
          : "The hole's diameter: wider than the screw, by the fit",
      )}
      {t === "counterbore" && field("counterboreDiameter", "Counterbore Ø")}
      {t === "counterbore" && field("counterboreDepth", "Counterbore depth")}
      {t === "countersink" && field("countersinkDiameter", "Countersink Ø")}
      {t === "countersink" && field("countersinkAngle", "Countersink °")}
      {t === "tapped" &&
        blind &&
        dims?.modelledThread &&
        field("threadDepth", "Thread depth", "How deep the thread runs")}
      {t === "tapped" &&
        dims?.modelledThread &&
        field(
          "clearance",
          "Clearance",
          "Radial gap (mm) the thread is grown by so a printed screw fits — 0.1 suits most FDM printers; 0.15–0.2 if tight; 0 for an exact ISO thread",
        )}

      <label
        className="ed-field"
        title="Blind: to a depth, with a flat or drill-point bottom. Up to next: through the first stretch of material each hole meets, stopping at the gap after it. Through all: through every part in its way."
      >
        <span>Extent</span>
        <select
          value={settings.extent}
          onChange={(e) => onChange({ extent: e.target.value as HoleSettings["extent"] })}
        >
          <option value="blind">Blind</option>
          <option value="upToNext">Up to next</option>
          <option value="throughAll">Through all</option>
        </select>
      </label>
      {blind && field("depth", "Depth")}
      {blind && (
        <div
          className="ed-field"
          title="The end of a blind hole: flat (an end mill, or a printed pocket), or the cone a twist drill leaves"
        >
          <span>Bottom</span>
          <div className="ed-modes ed-inline">
            <button className={!drillPoint ? "active" : ""} onClick={() => onParam("tipAngle", "0")}>
              Flat
            </button>
            <button className={drillPoint ? "active" : ""} onClick={() => !drillPoint && onParam("tipAngle", "118")}>
              Drill point
            </button>
          </div>
        </div>
      )}
      {blind &&
        drillPoint &&
        field("tipAngle", "Point angle °", "Included angle of the drill point: 118° for a standard twist drill")}
      <label className="ed-field ed-flip" title="Drill the other way (out of the sketch plane's front)">
        <span>Flip direction</span>
        <input type="checkbox" checked={settings.flip} onChange={(e) => onChange({ flip: e.target.checked })} />
      </label>

      {error && <p className="ed-warning">{error}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={!!error || nPoints === 0} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
