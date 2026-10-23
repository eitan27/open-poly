// Settings: the preferences that belong to the person rather than to a
// document. Everything here is stored in localStorage (see settings/settings.ts)
// and applies the instant it's changed — there is no Save button, and nothing
// here touches the document or the undo stack.
import type { CSSProperties } from "react";
import type { CircleDimension, MouseDragAction, Settings, ThemeChoice } from "../settings/settings";
import { colorToHex, SOLID_COLORS } from "../document/colors";
import { Modal, ModalHeader } from "./Modal";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

/** One theme's colours as the miniature paints them. Literal hexes, not tokens:
 *  a swatch has to show the theme it names, which is the one theme the
 *  surrounding stylesheet is NOT currently painting. They mirror index.css and
 *  settings/viewportTheme.ts — `bg` is the 3D viewport, `panel` the side panels,
 *  `chrome` the topbar, `line` the borders and grid. */
interface SwatchPalette {
  bg: string;
  panel: string;
  chrome: string;
  accent: string;
  line: string;
}

const DARK_SWATCH: SwatchPalette = {
  bg: "#1b1d23",
  panel: "#181a20",
  chrome: "#14161b",
  accent: "#4f8cff",
  line: "#3a3d48",
};
const LIGHT_SWATCH: SwatchPalette = {
  bg: "#e9edf3",
  panel: "#f8f9fc",
  chrome: "#ffffff",
  accent: "#2563eb",
  line: "#a9b4c6",
};

// The theme picker shows each option as a miniature of the app — topbar, side
// panel, grid and a body on it — so the choice is made by eye rather than by
// reading a word. The panels differ from the viewport by only a few units per
// channel in either theme (that's the point: they're meant to sit quietly next
// to each other), so at 50 px the regions are told apart by their separator
// lines, and the body carries the colour. See .set-theme-* in App.css.
const THEME_OPTIONS: {
  value: ThemeChoice;
  label: string;
  hint: string;
  swatch: SwatchPalette[];
}[] = [
  { value: "dark", label: "Dark", hint: "The original look", swatch: [DARK_SWATCH] },
  { value: "light", label: "Light", hint: "Like most CAD apps", swatch: [LIGHT_SWATCH] },
  { value: "system", label: "System", hint: "Follow the OS", swatch: [DARK_SWATCH, LIGHT_SWATCH] },
];

// The body sitting on the miniature's grid. NOT part of the theme — a real
// body's colour comes from the document — so both swatches show the same peach
// from the pastel palette, shaded for the three visible faces of an isometric
// cube (top lit, left in shadow) the way the viewport's lighting shades one.
const PEACH = SOLID_COLORS[1];
const BODY_VARS = {
  "--sw-body-top": "#e7a97f",
  "--sw-body-right": colorToHex(PEACH),
  "--sw-body-left": "#a6633f",
};

/** The palette handed to CSS as custom properties — the miniature's layout is
 *  all in App.css, and only the colours vary per swatch. */
const swatchVars = (s: SwatchPalette): CSSProperties =>
  ({
    ...BODY_VARS,
    "--sw-bg": s.bg,
    "--sw-panel": s.panel,
    "--sw-chrome": s.chrome,
    "--sw-accent": s.accent,
    "--sw-line": s.line,
  }) as CSSProperties;

/** The pinned colour as lowercase `#rrggbb`, or null for "random". Normalised
 *  because a settings blob could hold an uppercase hex while everything we
 *  write (colorToHex, `<input type="color">`) is lowercase. */
const pinnedColor = (v: Settings["newBodyColor"]): string | null => (v === "random" ? null : v.toLowerCase());

const MOUSE_ACTIONS: { value: MouseDragAction; label: string }[] = [
  { value: "pan", label: "Pan" },
  { value: "orbit", label: "Orbit" },
  { value: "zoom", label: "Zoom" },
];

const ON_OFF: { value: "on" | "off"; label: string }[] = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

const CIRCLE_DIMENSIONS: { value: CircleDimension; label: string }[] = [
  { value: "diameter", label: "Diameter (\u00d8)" },
  { value: "radius", label: "Radius (R)" },
];

/** One row: a label + description on the left, a `<select>` on the right. */
function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="set-toggle">
      <span className="set-toggle-text">
        <span className="set-toggle-label">{label}</span>
        <span className="set-toggle-hint">{hint}</span>
      </span>
      <select className="set-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SettingsDialog({ settings, onChange, onClose }: Props) {
  const pinned = pinnedColor(settings.newBodyColor);
  // A pinned colour outside the ten palette swatches — the custom picker owns
  // the selected state in that case.
  const custom = pinned !== null && !SOLID_COLORS.some((c) => colorToHex(c) === pinned);

  return (
    <Modal onClose={onClose} ariaLabel="Settings" className="settings-dialog">
      <ModalHeader title="Settings" onClose={onClose} />

      <section className="set-section">
        <h3>Color Theme</h3>
        <div className="set-themes" role="radiogroup" aria-label="Color theme">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.value}
              role="radio"
              aria-checked={settings.theme === o.value}
              className={"set-theme" + (settings.theme === o.value ? " active" : "")}
              onClick={() => onChange({ theme: o.value })}
            >
              <span className="set-theme-swatch">
                {o.swatch.map((s, i) => (
                  // Each half of the System swatch is a full miniature, clipped
                  // to its side of the diagonal — so "System" reads as literally
                  // both themes, and the body straddling the split lines up
                  // because both halves lay out identically.
                  <span
                    key={i}
                    className="set-theme-half"
                    style={{
                      ...swatchVars(s),
                      clipPath:
                        o.swatch.length > 1
                          ? i === 0
                            ? "polygon(0 0, 100% 0, 0 100%)"
                            : "polygon(100% 0, 100% 100%, 0 100%)"
                          : undefined,
                    }}
                  >
                    <span className="set-theme-grid" />
                    <span className="set-theme-body" />
                    <span className="set-theme-panel" />
                    <span className="set-theme-chrome" />
                  </span>
                ))}
              </span>
              <span className="set-theme-label">{o.label}</span>
              <span className="set-theme-hint">{o.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="set-section">
        <h3>New Body Color</h3>
        <div className="set-swatches" role="radiogroup" aria-label="New body color">
          <button
            role="radio"
            aria-checked={pinned === null}
            className={"set-swatch set-swatch-random" + (pinned === null ? " active" : "")}
            title="A different color for each new body"
            onClick={() => onChange({ newBodyColor: "random" })}
          >
            <span aria-hidden>🎲</span>
          </button>
          {SOLID_COLORS.map((c) => {
            const hex = colorToHex(c);
            return (
              <button
                key={hex}
                role="radio"
                aria-checked={pinned === hex}
                className={"set-swatch" + (pinned === hex ? " active" : "")}
                style={{ background: hex }}
                title={`Every new body starts ${hex}`}
                aria-label={hex}
                onClick={() => onChange({ newBodyColor: hex })}
              />
            );
          })}
          {/* Anything outside the ten. Sits last so the palette reads as the
                common case and this as the escape hatch. */}
          <label
            className={"set-swatch set-swatch-custom" + (custom ? " active" : "")}
            title="Pick any color"
            style={custom ? { background: pinned! } : undefined}
          >
            <span aria-hidden>⋯</span>
            <input
              type="color"
              value={pinned ?? colorToHex(SOLID_COLORS[0])}
              onChange={(e) => onChange({ newBodyColor: e.target.value })}
            />
          </label>
        </div>
        <p className="set-note">Only the starting color — any body can be recolored from the Parts list afterwards.</p>
      </section>

      <section className="set-section">
        <h3>Sketch</h3>
        <Choice
          label="Dimension circles as"
          hint="Default: diameter"
          value={settings.circleDimension}
          options={CIRCLE_DIMENSIONS}
          onChange={(circleDimension) => onChange({ circleDimension })}
        />
        <p className="set-note">
          The starting measure for a new circle dimension — an existing one keeps whichever it was made with, and arcs
          are always dimensioned by radius.
        </p>
      </section>

      <section className="set-section">
        <h3>Mouse</h3>
        <Choice
          label="Middle button drag"
          hint="Default: pan"
          value={settings.mouseMiddle}
          options={MOUSE_ACTIONS}
          onChange={(mouseMiddle) => onChange({ mouseMiddle })}
        />
        <Choice
          label="Right button drag"
          hint="Default: pan — set to Orbit for SolidWorks / Onshape habits"
          value={settings.mouseRight}
          options={MOUSE_ACTIONS}
          onChange={(mouseRight) => onChange({ mouseRight })}
        />
        <Choice
          label="Camera inertia"
          hint="Default: on — orbit and pan glide to a stop after you let go"
          value={settings.cameraInertia ? "on" : "off"}
          options={ON_OFF}
          onChange={(v) => onChange({ cameraInertia: v === "on" })}
        />
        <p className="set-note">
          Left drag always orbits, and also does selecting and sketching, so it isn't rebindable. The scroll wheel
          always zooms.
        </p>
      </section>

      <p className="report-note">
        Settings are saved in this browser only — they travel with neither your documents nor your account.
      </p>

      {/* The notices the download is required to carry. A plain link to the
          generated text file, not a viewer: the file is emitted into `dist/`
          beside the bundles it describes (see scripts/third-party-licenses.ts),
          so it is served from the same origin at the site root. Absolute
          because the app is served from `/` and this dialog can be open over
          any route. */}
      <p className="set-legal">
        Open Poly is free software under the GNU GPL, version 3 or later.{" "}
        <a href="/third-party-licenses.txt" target="_blank" rel="noreferrer">
          Third-party licenses
        </a>
      </p>
    </Modal>
  );
}
