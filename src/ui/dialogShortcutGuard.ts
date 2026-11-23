// What a feature shortcut does when a feature dialog is already open.
//
// The toolbar settles this by disabling every tool while a dialog is up (see
// `toolsLocked` in App.tsx), but a key has no disabled state, so each feature
// shortcut used to guard only against its OWN dialog — and three feature keys in
// a row stacked three dialogs. This module is the single rule the keyboard follows
// instead, kept free of React so it can be tested on its own.
import type { ShortcutId } from "../settings/shortcuts";

/** The feature dialog (or dialog-like session) that is on screen, as far as the
 *  shortcut guard needs to know it. */
export interface OpenFeatureDialog {
  /** The feature shortcut that opens this dialog, so pressing it again is a no-op. */
  shortcut: ShortcutId;
  /** The dialog's name as the hint spells it: "Finish or cancel the <label> dialog
   *  first". */
  label: string;
}

/** What to do with a feature shortcut:
 *  - `pass`: no dialog is open, so the shortcut behaves as it always has;
 *  - `noop`: it is the open dialog's own shortcut, which is already satisfied;
 *  - `block`: another dialog is open, so the key is ignored and a hint says why. */
export type FeatureShortcutVerdict = "pass" | "noop" | "block";

export function featureShortcutVerdict(open: OpenFeatureDialog | null, requested: ShortcutId): FeatureShortcutVerdict {
  if (!open) return "pass";
  if (open.shortcut === requested) return "noop";
  return "block";
}

/** The banner shown when a feature shortcut is refused because of `open`. */
export function dialogBusyHint(open: OpenFeatureDialog): string {
  return `Finish or cancel the ${open.label} dialog first (Esc).`;
}
