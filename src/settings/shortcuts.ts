// The single source of truth for what each key does: the handler dispatches from
// this table and the toolbars read their hints from it, so a letter is written
// down exactly once.
//
// `shortcuts.test.ts` enforces that a chord is claimed once — two entries
// sharing one means the second silently never fires.
//
// A letter MAY be reused across modes. The sketch and modeling toolbars are
// mutually exclusive (you are either editing a sketch or you are not), so an
// entry's `mode` is what makes the reuse unambiguous. A "both" entry is live in
// either mode and so collides with both.
//
// `mod` means ⌘ on a Mac and Ctrl elsewhere. `anyShift` marks the entries that
// are not Shift-tested, so they fire whether or not Shift is down.

export type ShortcutMode = "modeling" | "sketch" | "both";
export type ShortcutModifier = "mod" | "shift" | "alt";

interface ShortcutDef {
  /** Stable id — what the handler dispatches on and the toolbars look up. */
  readonly id: string;
  /** A `KeyboardEvent.key` value; single characters are stored lower-cased. */
  readonly key: string;
  readonly mods?: readonly ShortcutModifier[];
  readonly mode: ShortcutMode;
  /** Human label, for the hint tooltips and for anyone reading this table. */
  readonly label: string;
  /** Fires with or without Shift held — see the note at the top of the file. */
  readonly anyShift?: boolean;
}

export const SHORTCUTS = [
  // ---- Always live, in either mode ----
  // Escape is matched before the "don't fire while typing" guard, on purpose:
  // it has to back you out of a dialog whose input has the focus.
  {
    id: "app.cancel",
    key: "Escape",
    mode: "both",
    anyShift: true,
    label: "Cancel the current pick, dialog or draft (a spline commits its points; otherwise leaves sketch edit)",
  },
  { id: "app.toggleHints", key: "?", mode: "both", anyShift: true, label: "Show or hide the shortcut hints" },
  { id: "app.toolSearch", key: "/", mode: "both", anyShift: true, label: "Search the live toolbar's tools" },
  { id: "app.delete", key: "Delete", mode: "both", anyShift: true, label: "Delete the selection" },
  { id: "app.deleteBack", key: "Backspace", mode: "both", anyShift: true, label: "Delete the selection" },
  { id: "app.undo", key: "z", mods: ["mod"], mode: "both", label: "Undo" },
  { id: "app.redo", key: "z", mods: ["mod", "shift"], mode: "both", label: "Redo" },
  { id: "app.importStep", key: "i", mods: ["mod"], mode: "both", anyShift: true, label: "Import a STEP file" },

  // ---- Standard views (1-7, in this order — do not renumber) ----
  { id: "view.top", key: "1", mode: "both", anyShift: true, label: "Top view" },
  { id: "view.front", key: "2", mode: "both", anyShift: true, label: "Front view" },
  { id: "view.right", key: "3", mode: "both", anyShift: true, label: "Right view" },
  { id: "view.back", key: "4", mode: "both", anyShift: true, label: "Back view" },
  { id: "view.left", key: "5", mode: "both", anyShift: true, label: "Left view" },
  { id: "view.bottom", key: "6", mode: "both", anyShift: true, label: "Bottom view" },
  { id: "view.iso", key: "7", mode: "both", anyShift: true, label: "Isometric view" },

  // ---- Modeling toolbar (only while NOT editing a sketch) ----
  { id: "view.home", key: "h", mode: "modeling", anyShift: true, label: "Home view — fit everything" },
  {
    id: "feature.moveUp",
    key: "ArrowUp",
    mods: ["alt"],
    mode: "modeling",
    anyShift: true,
    label: "Move the selected feature earlier in the timeline",
  },
  {
    id: "feature.moveDown",
    key: "ArrowDown",
    mods: ["alt"],
    mode: "modeling",
    anyShift: true,
    label: "Move the selected feature later in the timeline",
  },
  { id: "model.sketch", key: "s", mode: "modeling", anyShift: true, label: "Sketch — pick a plane or face" },
  { id: "model.newBody", key: "n", mode: "modeling", anyShift: true, label: "New Body" },
  { id: "model.plane", key: "p", mode: "modeling", anyShift: true, label: "Reference plane" },
  { id: "model.extrude", key: "e", mode: "modeling", anyShift: true, label: "Extrude" },
  { id: "model.revolve", key: "r", mode: "modeling", anyShift: true, label: "Revolve" },
  { id: "model.sweep", key: "w", mode: "modeling", anyShift: true, label: "Sweep" },
  { id: "model.loft", key: "l", mode: "modeling", anyShift: true, label: "Loft" },
  { id: "model.chamfer", key: "c", mode: "modeling", anyShift: true, label: "Chamfer" },
  { id: "model.fillet", key: "f", mode: "modeling", anyShift: true, label: "Fillet" },
  { id: "model.shell", key: "g", mode: "modeling", anyShift: true, label: "Shell" },
  { id: "model.boolean", key: "b", mode: "modeling", anyShift: true, label: "Boolean" },
  { id: "model.transform", key: "t", mode: "modeling", anyShift: true, label: "Transform" },
  { id: "model.mirror", key: "m", mode: "modeling", anyShift: true, label: "Mirror a body" },
  { id: "model.pattern", key: "x", mode: "modeling", anyShift: true, label: "Pattern a body" },

  // Enter commits the sketch tools that preview before they commit — the
  // Mirror, Project/Convert and Pattern sessions. It is a "both" entry rather
  // than a sketch one because what gates it is the live session, not the mode:
  // those sessions are started in sketch mode but the Finish-sketch button does
  // not clear all of them, so the handler asks the session refs, exactly as it
  // always has. Nothing else claims Enter, so the mode makes no difference to
  // the collision test either way.
  {
    id: "sketch.commitSession",
    key: "Enter",
    mode: "both",
    anyShift: true,
    label: "Commit the previewing mirror / project / pattern",
  },

  // ---- Sketch toolbar (only while editing a sketch) ----
  { id: "sketch.select", key: "s", mode: "sketch", label: "Select" },
  { id: "sketch.line", key: "l", mode: "sketch", label: "Line" },
  { id: "sketch.rectCorner", key: "r", mode: "sketch", label: "Rectangle: 2 corners" },
  { id: "sketch.rectCenter", key: "r", mods: ["shift"], mode: "sketch", label: "Rectangle: center + corner" },
  { id: "sketch.circleCenter", key: "c", mode: "sketch", label: "Circle: center + radius" },
  { id: "sketch.circle3p", key: "c", mods: ["shift"], mode: "sketch", label: "Circle: 3 points" },
  { id: "sketch.polygon", key: "p", mode: "sketch", label: "Regular polygon" },
  { id: "sketch.arc", key: "a", mode: "sketch", label: "Arc: 3 points" },
  { id: "sketch.spline", key: "s", mods: ["shift"], mode: "sketch", label: "Spline" },
  { id: "sketch.offset", key: "o", mode: "sketch", label: "Offset" },
  { id: "sketch.mirror", key: "m", mode: "sketch", label: "Mirror entities" },
  { id: "sketch.patternLinear", key: "x", mode: "sketch", label: "Linear pattern" },
  { id: "sketch.patternCircular", key: "x", mods: ["shift"], mode: "sketch", label: "Circular pattern" },
  { id: "sketch.project", key: "u", mode: "sketch", label: "Project / Convert existing geometry" },
  { id: "sketch.text", key: "t", mode: "sketch", label: "Text" },
  { id: "sketch.trim", key: "k", mode: "sketch", label: "Trim" },
  { id: "sketch.extend", key: "k", mods: ["shift"], mode: "sketch", label: "Extend" },
  { id: "sketch.dimension", key: "d", mode: "sketch", anyShift: true, label: "Dimension the selection" },
  { id: "sketch.construction", key: "q", mode: "sketch", label: "Construction geometry" },
  { id: "sketch.horizontal", key: "h", mode: "sketch", label: "Horizontal constraint" },
  { id: "sketch.vertical", key: "v", mode: "sketch", label: "Vertical constraint" },
  { id: "sketch.parallel", key: "p", mods: ["shift"], mode: "sketch", label: "Parallel constraint" },
  { id: "sketch.perpendicular", key: "n", mode: "sketch", label: "Perpendicular constraint" },
  { id: "sketch.equal", key: "=", mode: "sketch", anyShift: true, label: "Equal constraint" },
] as const satisfies readonly ShortcutDef[];

export type Shortcut = (typeof SHORTCUTS)[number];
export type ShortcutId = Shortcut["id"];

const BY_ID = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

// `Shortcut` is a union of the literal entry types, and the optional fields are
// absent (not `undefined`) on the entries that omit them — hence the `in`
// narrowing rather than a plain property read.

/** `mods`, widened off the `as const` literal so `.includes()` is usable. */
export function modsOf(s: Shortcut): readonly ShortcutModifier[] {
  return "mods" in s ? s.mods : [];
}

/** Whether this entry fires with or without Shift. */
export function firesWithAnyShift(s: Shortcut): boolean {
  return "anyShift" in s && s.anyShift;
}

/** The entry for `id`. Ids are a closed union, so this always finds one. */
export function shortcut(id: ShortcutId): Shortcut {
  return BY_ID.get(id)!;
}

/** How a named key is drawn in a hint; anything else is shown upper-cased. */
const KEY_GLYPH: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "⏎",
  Escape: "Esc",
  Delete: "Del",
  Backspace: "⌫",
};

/** The hint a toolbar button wears, e.g. "R", "⇧K", "=". */
export function shortcutHint(id: ShortcutId): string {
  const s = shortcut(id);
  const mods = modsOf(s);
  const prefix =
    (mods.includes("mod") ? "⌘" : "") + (mods.includes("alt") ? "⌥" : "") + (mods.includes("shift") ? "⇧" : "");
  return prefix + (KEY_GLYPH[s.key] ?? s.key.toUpperCase());
}

/**
 * The same key spelled out for prose, e.g. "R", "Shift+K", "=". The tooltips
 * name their key mid-sentence ("Trim (K): click the piece…"), where a glyph
 * like ⇧ reads worse than the word.
 */
export function shortcutName(id: ShortcutId): string {
  const s = shortcut(id);
  const mods = modsOf(s);
  const prefix =
    (mods.includes("mod") ? "Cmd+" : "") +
    (mods.includes("alt") ? "Alt+" : "") +
    (mods.includes("shift") ? "Shift+" : "");
  return prefix + (KEY_GLYPH[s.key] ?? s.key.toUpperCase());
}

/**
 * Whether a keystroke is this entry, ignoring which mode it belongs to. "mod"
 * and Alt are only tested for entries that ask for them, and Shift only for
 * entries that are not `anyShift` — all three reproduce what the hand-written
 * handler did before this table existed. Stray ⌘/Ctrl chords are dropped by the
 * handler, not here; see the header.
 */
function matches(e: KeyboardEvent, s: Shortcut): boolean {
  const eventKey = s.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (eventKey !== s.key) return false;
  const mods = modsOf(s);
  if (mods.includes("mod") && !(e.metaKey || e.ctrlKey)) return false;
  if (mods.includes("alt") && !e.altKey) return false;
  if (!firesWithAnyShift(s) && mods.includes("shift") !== e.shiftKey) return false;
  return true;
}

/**
 * The entry a keystroke fires in `mode`, if any. "both" entries are candidates
 * in either mode.
 */
export function matchShortcut(e: KeyboardEvent, mode: "modeling" | "sketch"): Shortcut | undefined {
  return SHORTCUTS.find((s) => (s.mode === "both" || s.mode === mode) && matches(e, s));
}

/** Whether a keystroke is this one particular shortcut, mode notwithstanding. */
export function isShortcut(e: KeyboardEvent, id: ShortcutId): boolean {
  return matches(e, shortcut(id));
}
