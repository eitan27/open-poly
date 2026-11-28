import type { GearReadout } from "../document/gear";
import { GEAR_TYPE_LABELS, type GearSettings } from "../document/gear";
import type { GearFeature, GearParams, GearType } from "../document/types";
import { DraggableDialog } from "./DraggableDialog";
import { ExprInput } from "./ExprInput";
import { PickSlot } from "./PickSlot";
import { GearDiagram } from "./diagram/GearDiagram";
import { RackDiagram } from "./diagram/RackDiagram";
import { useRef, useState } from "react";
import "./GearDialog.css";

interface Props {
  editing?: boolean;
  settings: GearSettings;
  /** Where it is, as the Location slot names it; `defaultLocation` marks the
   *  untouched default (the Top plane's origin). */
  locationLabel: string;
  defaultLocation: boolean;
  /** The slot is listening: the next viewport pick places the gear. */
  locating: boolean;
  advanced: boolean;
  /** Other gears this one can take its module + pressure angle from. */
  meshOptions: Pick<GearFeature, "id" | "name">[];
  /** The partner's name when meshed, for the size line. */
  meshName?: string;
  /** Live dimensions (null when the settings don't make a gear) + its error. */
  readout: GearReadout | null;
  error: string | null;
  onArmLocation: () => void;
  onChange: (patch: Partial<GearSettings>) => void;
  /** Size by its own module / pitch diameter (unlinking a meshed gear in place). */
  onSizeBy: (sizeBy: GearSettings["sizeBy"]) => void;
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
  locationLabel,
  defaultLocation,
  locating,
  advanced,
  meshOptions,
  meshName,
  readout,
  error,
  onArmLocation,
  onChange,
  onSizeBy,
  onParam,
  onToggleAdvanced,
  onConfirm,
  onCancel,
}: Props) {
  const p = settings.params;
  const internal = settings.gearType === "internal";
  const rack = settings.gearType === "rack";
  // The diagram lights the dimension of whichever field has focus (or is
  // hovered); a click on a dimension focuses its field, opening Advanced
  // first when that's where the field lives.
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  // A rack's rotation is its Direction, a main field.
  const ADVANCED = new Set([
    "pressureAngle",
    "backlash",
    "profileShift",
    "rootFillet",
    "normalOffset",
    ...(rack ? [] : ["rotation"]),
  ]);
  const pickDim = (name: string) => {
    const focus = () => inputs.current.get(name)?.focus();
    if (ADVANCED.has(name) && !advanced) {
      onToggleAdvanced();
      setTimeout(focus, 0);
    } else focus();
  };
  const meshed = !!settings.meshWith;
  const placed = meshed && !!settings.placeBeside;

  /** An expression field bound to one of the gear's params. Enter confirms,
   *  Escape cancels, as in every other feature dialog. */
  const field = (name: keyof GearParams, label: string, opts: { autoFocus?: boolean; title?: string } = {}) => (
    <label
      className="ed-field"
      title={opts.title}
      onMouseEnter={() => setHovered(name)}
      onMouseLeave={() => setHovered(null)}
    >
      <span>{label}</span>
      <ExprInput
        ref={(el: HTMLInputElement | null) => {
          if (el) inputs.current.set(name, el);
          else inputs.current.delete(name);
        }}
        autoFocus={opts.autoFocus}
        onFocus={() => setFocused(name)}
        onBlur={() => setFocused(null)}
        value={p[name] ?? ""}
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
        {editing ? (rack ? "Edit rack" : "Edit gear") : "Gear"}
      </div>
      <label className="ed-field">
        <span>Type</span>
        <select
          value={settings.gearType}
          onChange={(e) => {
            const gearType = e.target.value as GearType;
            // A rack has no pitch diameter: it's sized by module (or its pinion).
            onChange(
              gearType === "rack" && settings.sizeBy === "pitchDiameter"
                ? { gearType, sizeBy: "module" }
                : { gearType },
            );
          }}
        >
          {(Object.keys(GEAR_TYPE_LABELS) as GearType[]).map((t) => (
            <option key={t} value={t}>
              {GEAR_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      {readout?.rack ? (
        <RackDiagram readout={readout} active={focused ?? hovered} onPick={pickDim} />
      ) : (
        readout && <GearDiagram readout={readout} bore={settings.bore} active={focused ?? hovered} onPick={pickDim} />
      )}

      <div className="bool-group-label">Location</div>
      <PickSlot
        noun="a location"
        armed={locating}
        value={defaultLocation ? `${locationLabel} (default)` : locationLabel}
        wide
        title={
          rack
            ? "Where the middle of the rack's pitch line goes: a plane's origin, a point, or a spot on a face"
            : "Where the gear's center goes: a plane's origin, a point, or a spot on a face"
        }
        clearTitle="Select a different location"
        onArm={onArmLocation}
      />
      {locating && (
        <p className="ed-hint">
          {placed
            ? `It goes beside ${meshName ?? "its partner"}; a pick sets only the plane it's on.`
            : `Click a plane, a face, or a point to center it on. Until then it stays on ${locationLabel}.`}
        </p>
      )}

      {field("teeth", "Teeth", {
        autoFocus: !editing,
        title: rack ? "The rack's length in tooth pitches (teeth × π × module), so how far it can travel" : undefined,
      })}

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
            // Meshing with a gear places it beside that gear unless asked not to.
            if (v.startsWith("mesh:")) onChange({ meshWith: v.slice(5), placeBeside: settings.placeBeside ?? true });
            else onSizeBy(v as GearSettings["sizeBy"]);
          }}
        >
          <option value="module">Module</option>
          {!rack && <option value="pitchDiameter">Pitch diameter</option>}
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
        <>
          {/* What the pair shares, short enough not to wrap mid-phrase: each
              figure is a span that wraps whole. The pressure angle is under
              Advanced. */}
          <div className="gear-readout gear-meshed">
            <span>Module {readout ? fmt(readout.module) : "–"} mm</span>
            {readout?.centerDistance !== undefined &&
              (rack ? (
                <span
                  className="gear-center-distance"
                  title={`How far ${meshName ?? "the pinion"}'s center is from the rack's pitch line, to mesh`}
                >
                  Pinion center to pitch line {fmt(readout.centerDistance)} mm
                </span>
              ) : (
                <span
                  className="gear-center-distance"
                  title={`How far this gear's center is from ${meshName ?? "its partner"}'s, to mesh`}
                >
                  Center distance between gears {fmt(readout.centerDistance)} mm
                </span>
              ))}
          </div>
          <label
            className="ed-field ed-flip"
            title={`Put it at the meshing distance from ${meshName ?? "its partner"}, teeth in mesh, and keep it there`}
          >
            <span>Place beside {meshName ?? "it"}</span>
            <input
              type="checkbox"
              className="gear-place-beside"
              checked={!!settings.placeBeside}
              onChange={(e) => onChange({ placeBeside: e.target.checked })}
            />
          </label>
          {placed &&
            field("placeAngle", "Angle°", {
              title: rack
                ? `Which side of ${meshName ?? "the pinion"}: the direction from its center to the rack, from the plane's X`
                : `Which side of ${meshName ?? "its partner"}: the direction from its center to this one's, from the plane's X`,
            })}
          {placed &&
            rack &&
            field("slide", "Slide (teeth)", {
              title: "Slide the rack along by this many tooth pitches; whole numbers keep it in mesh",
            })}
        </>
      ) : settings.sizeBy === "module" || rack ? (
        field("module", "Module (mm)", { title: "Pitch diameter ÷ teeth. Gears only mesh at the same module." })
      ) : (
        field("pitchDiameter", "Pitch Ø (mm)")
      )}

      {field("thickness", "Thickness")}
      <label className="ed-field ed-flip">
        <span>Flip direction</span>
        <input type="checkbox" checked={settings.flip} onChange={(e) => onChange({ flip: e.target.checked })} />
      </label>

      {rack &&
        !placed &&
        field("rotation", "Direction°", {
          title: "The way the rack runs, from the plane's X; its teeth face 90° counter-clockwise of it",
        })}

      {rack ? (
        <>
          {field("rackHeight", "Height", {
            title:
              "From the back of the rack to its pitch line. A meshed pinion's center sits its pitch radius above the pitch line.",
          })}
          {field("endMargin", "End margin", {
            title:
              "Plain bar past the teeth at each end, for mounting. 0 ends the rack mid-space, so racks laid end to end keep the pitch.",
          })}
        </>
      ) : internal ? (
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

      {readout?.rack && (
        <div className="gear-readout gear-rack-readout">
          <span>Length {fmt(readout.rack.length)} mm</span>
          <span>Pitch {fmt(readout.rack.pitch)} mm</span>
          <span>Total height {fmt(readout.rack.totalHeight)} mm</span>
        </div>
      )}
      {readout?.dims && (
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
          {!rack &&
            field("profileShift", "Profile shift (×m)", {
              title: "Positive moves the teeth outward: stronger roots on small gears, no undercut.",
            })}
          {!internal && field("rootFillet", "Root fillet (×m)", { title: "0.38 × module is standard" })}
          {rack
            ? null
            : placed
              ? field("rotation", "Extra rotation°", { title: "Added to the angle that meshes its teeth" })
              : field("rotation", "Rotation°", { title: "Turn the teeth to line up with a partner" })}
          {field("normalOffset", "Normal offset", {
            title: `Move it along its plane's normal. −(thickness)/2${
              /^\d+(\.\d+)?$/.test(p.thickness.trim()) ? ` (−${Number(p.thickness) / 2} here)` : ""
            } centers it on the plane${settings.flip ? "; flipped, +(thickness)/2" : ""}.`,
          })}
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
