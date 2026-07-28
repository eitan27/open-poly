// Settings: the preferences that belong to the person rather than to a
// document. Everything here is stored in localStorage (see settings/settings.ts)
// and applies the instant it's changed — there is no Save button, and nothing
// here touches the document or the undo stack.
import { useEffect } from "react";
import type { Settings, ThemeChoice } from "../settings/settings";

interface Props {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

// The theme picker shows each option as a miniature of the app — two panes and a
// toolbar — so the choice is made by eye rather than by reading a word. Colours
// are literal (not tokens): a swatch has to show the theme it names, which is
// the one theme the surrounding stylesheet is NOT currently painting.
const THEME_OPTIONS: {
  value: ThemeChoice;
  label: string;
  hint: string;
  swatch: { bg: string; panel: string; chrome: string; accent: string; line: string }[];
}[] = [
  {
    value: "dark",
    label: "Dark",
    hint: "The original look",
    swatch: [{ bg: "#1b1d23", panel: "#181a20", chrome: "#14161b", accent: "#4f8cff", line: "#3a3d48" }],
  },
  {
    value: "light",
    label: "Light",
    hint: "Bright rooms, printing",
    swatch: [{ bg: "#e9edf3", panel: "#f8f9fc", chrome: "#ffffff", accent: "#2563eb", line: "#a9b4c6" }],
  },
  {
    value: "system",
    label: "System",
    hint: "Follow the OS",
    swatch: [
      { bg: "#1b1d23", panel: "#181a20", chrome: "#14161b", accent: "#4f8cff", line: "#3a3d48" },
      { bg: "#e9edf3", panel: "#f8f9fc", chrome: "#ffffff", accent: "#2563eb", line: "#a9b4c6" },
    ],
  },
];

/** One row: a label + description on the left, a checkbox on the right. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="set-toggle">
      <span className="set-toggle-text">
        <span className="set-toggle-label">{label}</span>
        <span className="set-toggle-hint">{hint}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function SettingsDialog({ settings, onChange, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-dialog" role="dialog" aria-label="Settings">
        <div className="report-header">
          <span>Settings</span>
          <button className="row-icon" title="Close (Esc)" onClick={onClose}>✕</button>
        </div>

        <section className="set-section">
          <h3>Colour theme</h3>
          <div className="set-themes" role="radiogroup" aria-label="Colour theme">
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
                    // to its side — so "System" reads as literally both themes.
                    <span
                      key={i}
                      className="set-theme-half"
                      style={{ background: s.bg, clipPath: o.swatch.length > 1 ? (i === 0 ? "polygon(0 0, 100% 0, 0 100%)" : "polygon(100% 0, 100% 100%, 0 100%)") : undefined }}
                    >
                      <span className="set-theme-chrome" style={{ background: s.chrome }} />
                      <span className="set-theme-panel" style={{ background: s.panel }} />
                      <span className="set-theme-line" style={{ background: s.line }} />
                      <span className="set-theme-accent" style={{ background: s.accent }} />
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
          <h3>Viewport</h3>
          <Toggle
            label="Ground grid"
            hint="The 240 mm reference grid on the XY plane"
            checked={settings.showGrid}
            onChange={(showGrid) => onChange({ showGrid })}
          />
          <Toggle
            label="Origin axes"
            hint="The red / green / blue triad at the world origin"
            checked={settings.showAxes}
            onChange={(showAxes) => onChange({ showAxes })}
          />
          <Toggle
            label="Navigation cube"
            hint="The orientation cube in the top-right corner"
            checked={settings.showViewCube}
            onChange={(showViewCube) => onChange({ showViewCube })}
          />
        </section>

        <section className="set-section">
          <h3>Interface</h3>
          <Toggle
            label="Keyboard shortcuts on buttons"
            hint="Show each tool's key as a cap in its label (?)"
            checked={settings.showShortcuts}
            onChange={(showShortcuts) => onChange({ showShortcuts })}
          />
          <Toggle
            label="Confirm before deleting a document"
            hint="Deleting a document cannot be undone"
            checked={settings.confirmDelete}
            onChange={(confirmDelete) => onChange({ confirmDelete })}
          />
        </section>

        <p className="report-note">
          Settings are saved in this browser only — they travel with neither your documents nor your account.
        </p>
      </div>
    </div>
  );
}
