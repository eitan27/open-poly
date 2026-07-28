// User preferences: the handful of choices that belong to the PERSON, not to a
// document. They live in localStorage (not IndexedDB alongside documents) so
// they survive deleting every document, and so the very first paint can read
// them synchronously — a theme fetched asynchronously is a flash of the wrong
// one. Storage is best-effort: private browsing can throw on both read and
// write, and the app must work fine with the defaults when it does.

/** What the user picked. "system" defers to the OS light/dark preference. */
export type ThemeChoice = "dark" | "light" | "system";
/** What that choice resolves to right now — the only two things we can paint. */
export type ResolvedTheme = "dark" | "light";

export interface Settings {
  /** Color theme. Dark is the original (and still the default) look. */
  theme: ThemeChoice;
  /** Show keyboard-shortcut key caps inside toolbar button labels. Not in the
   *  Settings dialog — it's the "?" button in the topbar (and the "?" key); it
   *  lives here only so the choice survives a reload. */
  showShortcuts: boolean;
  /** Color given to a newly created body: "random" (a fresh pick from the
   *  pastel palette each time, so bodies stay easy to tell apart) or a
   *  `#rrggbb` string to pin every new body to one colour. Either way it's only
   *  the starting value — the Parts list can recolour any body afterwards. */
  newBodyColor: "random" | string;
  /** What dragging with the middle / right mouse button does in the viewport.
   *  The LEFT button is not configurable: it carries selection, sketch drawing
   *  and entity dragging as well as orbit, so rebinding it would break them. */
  mouseMiddle: MouseDragAction;
  mouseRight: MouseDragAction;
}

export type MouseDragAction = "pan" | "orbit" | "zoom";
const MOUSE_ACTIONS: MouseDragAction[] = ["pan", "orbit", "zoom"];

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  showShortcuts: false,
  newBodyColor: "random",
  mouseMiddle: "pan",
  mouseRight: "pan",
};

const KEY = "openpoly.settings";

/** Coerce whatever was in storage into a valid Settings. Unknown keys are
 *  dropped and wrong-typed values fall back per-field, so a settings blob
 *  written by an older (or newer) build can never wedge the app. */
function coerce(raw: unknown): Settings {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  if (o.theme === "dark" || o.theme === "light" || o.theme === "system") out.theme = o.theme;
  if (typeof o.showShortcuts === "boolean") out.showShortcuts = o.showShortcuts;
  // Validated here rather than at the point of use: a bad value would otherwise
  // reach a document as NaN, which survives a save.
  if (o.newBodyColor === "random" || (typeof o.newBodyColor === "string" && /^#[0-9a-f]{6}$/i.test(o.newBodyColor))) {
    out.newBodyColor = o.newBodyColor;
  }
  for (const k of ["mouseMiddle", "mouseRight"] as const) {
    if (MOUSE_ACTIONS.includes(o[k] as MouseDragAction)) out[k] = o[k] as MouseDragAction;
  }
  return out;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? coerce(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* best-effort — private browsing / blocked storage */
  }
}

/** The OS preference, used when `theme` is "system". Defaults to dark when the
 *  browser can't tell us (matchMedia missing, or no preference expressed) —
 *  dark is this app's own default, so "system" never downgrades a user who
 *  never picked. */
export function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

/** Paint the resolved theme onto <html>. Every colour in the stylesheet reads
 *  from custom properties keyed off this attribute, and `color-scheme` gets the
 *  browser's own chrome (scrollbars, form controls, the canvas behind the app)
 *  to match — without it a light app keeps dark scrollbars. */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
  // Mobile browsers tint their own chrome (the address bar, the task switcher
  // card) from this. Values match --bg-chrome in index.css.
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = theme === "light" ? "#ffffff" : "#1b1d23";
}

/** Subscribe to OS light/dark changes. Returns an unsubscribe function; a
 *  no-op where matchMedia isn't available. */
export function watchSystemTheme(onChange: (theme: ResolvedTheme) => void): () => void {
  let mq: MediaQueryList | undefined;
  try {
    mq = window.matchMedia?.("(prefers-color-scheme: light)");
  } catch {
    return () => {};
  }
  if (!mq) return () => {};
  const handler = (e: MediaQueryListEvent) => onChange(e.matches ? "light" : "dark");
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
