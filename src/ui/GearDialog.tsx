import type { GearReadout } from "../document/gear";
import { GEAR_TYPE_LABELS, type GearSettings } from "../document/gear";
import type { GearFeature, GearParams, GearType } from "../document/types";
import { DraggableDialog } from "./DraggableDialog";
import { ExprInput } from "./ExprInput";
import { PickSlot } from "./PickSlot";
import "./GearDialog.css";

interface Props {
  editing?: boolean;
  settings: GearSettings;
  /** The plane slot's label; `defaultPlane` marks it as the untouched default. */
  planeLabel: string;
  defaultPlane: boolean;
  planeArmed: boolean;
  advanced: boolean;
  /** Other gears this one can take its module + pressure angle from. */
  meshOptions: Pick<GearFeature, "id" | "name">[];
  /** The partner's name when meshed, for the size line. */
  meshName?: string;
  /** Live dimensions (null when the settings don't make a gear) + its error. */
  readout: GearReadout | null;
  error: string | null;
  onArmPlane: () => void;
  onChange: (patch: Partial<GearSettings>) => void;
  onParam: (name: keyof GearParams, value: string) => void;
  onToggleAdvanced: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** The Size control's value: the sizing mode, or `mesh:<gear id>`. */
const sizeKey = (s: GearSettings) => (s.meshWith ? `mesh:${s.meshWith}` : s.sizeBy);

export function GearDialog({
  editing,
  settings,
  planeLabel,
  defaultPlane,
  planeArmed,
  advanced,
  meshOptions,
  meshName,
  readout,
  error,
  onArmPlane,
  onChange,
  onParam,
  onToggleAdvanced,
  onConfirm,
  onCancel,
}: Props) {
  const p = settings.params;
  const internal = settings.gearType === "internal";
  const meshed = !!settings.meshWith;

  /** An expression field bound to one of the gear's params. Enter confirms,
   *  Escape cancels, as in every other feature dialog. */
  const field = (name: keyof GearParams, label: string, opts: { autoFocus?: boolean; title?: string } = {}) => (
    <label className="ed-field" title={opts.title}>
      <span>{label}</span>
      <ExprInput
        autoFocus={opts.autoFocus}
        value={p[name]}
        onChange={(e) => onParam(name, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm();
          else if (e.key === "Escape") onCancel();
        }}
      />
    </label>
  );

  return (
    <DraggableDialog className="feature-dialog gear-dialog" style={{ right: 16, top: 64 }} baseTransform="">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit gear" : "Gear"}
      </div>
      <label className="ed-field">
        <span>Type</span>
        <select value={settings.gearType} onChange={(e) => onChange({ gearType: e.target.value as GearType })}>
          {(Object.keys(GEAR_TYPE_LABELS) as GearType[]).map((t) => (
            <option key={t} value={t}>
              {GEAR_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      <div className="bool-group-label">Plane or face</div>
      <PickSlot
        noun="a plane or face"
        armed={planeArmed}
        value={defaultPlane ? `${planeLabel} (default)` : planeLabel}
        wide
        title="The gear is centred on the plane's origin (offset it under Advanced)"
        clearTitle="Pick a different plane or face"
        onArm={onArmPlane}
      />

      {field("teeth", "Teeth", { autoFocus: !editing })}

      {/* One control for "how big are the teeth": a module, a pitch diameter,
          or — the case that matters for a pair — the same as another gear. A
          meshed gear takes BOTH numbers a pair must share (module and pressure
          angle) from its partner, and follows it when the partner changes. */}
      <label className="ed-field">
        <span>Size by</span>
        <select
          value={sizeKey(settings)}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("mesh:")) onChange({ meshWith: v.slice(5) });
            else onChange({ meshWith: undefined, sizeBy: v as GearSettings["sizeBy"] });
          }}
        >
          <option value="module">Module</option>
          <option value="pitchDiameter">Pitch diameter</option>
          {meshOptions.length > 0 && (
            <optgroup label="Mesh with">
              {meshOptions.map((g) => (
                <option key={g.id} value={`mesh:${g.id}`}>
                  {g.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {meshed ? (
        <p className="ed-hint gear-meshed">
          Module {readout ? fmt(readout.module) : "–"} mm, pressure angle from {meshName ?? "its partner"}
        </p>
      ) : settings.sizeBy === "module" ? (
        field("module", "Module (mm)", { title: "Pitch diameter ÷ teeth. Gears only mesh at the same module." })
      ) : (
        field("pitchDiameter", "Pitch Ø (mm)")
      )}

      {field("thickness", "Thickness")}
      <div className="ed-modes">
        <button className={settings.extent === "blind" ? "active" : ""} onClick={() => onChange({ extent: "blind" })}>
          One side
        </button>
        <button
          className={settings.extent === "symmetric" ? "active" : ""}
          onClick={() => onChange({ extent: "symmetric" })}
        >
          Symmetric
        </button>
      </div>
      {settings.extent === "blind" && (
        <label className="ed-field ed-flip">
          <span>Flip direction</span>
          <input type="checkbox" checked={settings.flip} onChange={(e) => onChange({ flip: e.target.checked })} />
        </label>
      )}

      {internal ? (
        field("rimWidth", "Rim width", { title: "How far the ring extends beyond the tooth roots" })
      ) : (
        <>
          <label className="ed-field">
            <span>Bore</span>
            <select value={settings.bore} onChange={(e) => onChange({ bore: e.target.value as GearSettings["bore"] })}>
              <option value="none">None</option>
              <option value="round">Round</option>
              <option value="dflat">D-flat</option>
            </select>
          </label>
          {settings.bore !== "none" && field("boreDiameter", "Bore Ø")}
          {settings.bore === "dflat" &&
            field("boreFlat", "Across flat", { title: "From the flat to the far side of the bore" })}
        </>
      )}

      {readout && (
        <div className="gear-readout">
          <span>Pitch Ø {fmt(readout.dims.pitchDiameter)}</span>
          <span>
            {internal ? "Inner" : "Outside"} Ø {fmt(readout.dims.tipDiameter)}
          </span>
          <span>Root Ø {fmt(readout.dims.rootDiameter)}</span>
        </div>
      )}
      {readout?.notes.map((n) => (
        <p key={n} className="ed-hint">
          {n}
        </p>
      ))}

      <button className="gear-advanced-toggle" onClick={onToggleAdvanced} aria-expanded={advanced}>
        {advanced ? "▾" : "▸"} Advanced
      </button>
      {advanced && (
        <div className="gear-advanced">
          {meshed ? (
            <p className="ed-hint">Pressure angle comes from {meshName ?? "its partner"}.</p>
          ) : (
            field("pressureAngle", "Pressure angle°", { title: "20° is standard; 14.5° and 25° also common" })
          )}
          {field("backlash", "Backlash (mm)", {
            title: "Play between meshing teeth; each tooth is thinned by half. 0.1–0.2 helps 3D-printed gears.",
          })}
          {field("profileShift", "Profile shift (×m)", {
            title: "Positive moves the teeth outward: stronger roots on small gears, no undercut.",
          })}
          {!internal && field("rootFillet", "Root fillet (×m)", { title: "0.38 × module is standard" })}
          {field("rotation", "Rotation°", { title: "Turn the teeth to line up with a partner" })}
          {field("centerX", "Centre X")}
          {field("centerY", "Centre Y")}
        </div>
      )}

      {error && <p className="ed-warning">{error}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={!!error && !editing} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
