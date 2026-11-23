// What a feature shortcut does when a feature dialog is already open.
//
// The toolbar settles this by disabling every tool while a dialog is up (see
// `toolsLocked` in App.tsx), but a key has no disabled state, so each feature
// shortcut used to guard only against its OWN dialog — and three feature keys in
// a row stacked three dialogs. This module is the single rule the keyboard follows
// instead, kept free of React so it can be tested on its own.
//
// The rule has one refinement over the toolbar's. Pressing the wrong feature key
// and then the right one is the common way to land here, and refusing the second
// key would make you Escape out of a dialog you never meant to open. So a dialog
// that is still UNTOUCHED — a new feature, nothing picked or changed since it
// opened — is swapped for the one asked for, exactly as if it had been cancelled
// first. Anything else (a dialog you have put work into, or one editing an existing
// feature) is left alone and the key is refused with a hint: work is never dropped
// silently.
import type { ShortcutId } from "../settings/shortcuts";

/** The feature dialog (or dialog-like session) that is on screen, as far as the
 *  shortcut guard needs to know it. */
export interface OpenFeatureDialog {
  /** The feature shortcut that opens this dialog, so pressing it again is a no-op. */
  shortcut: ShortcutId;
  /** The dialog's name as the hint spells it: "Finish or cancel the <label> dialog
   *  first". */
  label: string;
  /** True when the dialog is re-opening an existing feature rather than creating
   *  one. Such a dialog is never swapped away: closing it reverts a live edit. */
  editing: boolean;
  /** True once anything in the dialog has changed since it opened (see
   *  `DialogBaselines`). */
  touched: boolean;
}

/** What to do with a feature shortcut:
 *  - `pass`: no dialog is open, so the shortcut behaves as it always has;
 *  - `noop`: it is the open dialog's own shortcut, which is already satisfied;
 *  - `swap`: the open dialog is untouched, so it is cancelled and the requested
 *    one opened in its place;
 *  - `block`: the open dialog holds work, so the key is ignored and a hint says why. */
export type FeatureShortcutVerdict = "pass" | "noop" | "swap" | "block";

export function featureShortcutVerdict(open: OpenFeatureDialog | null, requested: ShortcutId): FeatureShortcutVerdict {
  if (!open) return "pass";
  if (open.shortcut === requested) return "noop";
  if (!open.editing && !open.touched) return "swap";
  return "block";
}

/** The banner shown when a feature shortcut is refused because of `open`. */
export function dialogBusyHint(open: Pick<OpenFeatureDialog, "label">): string {
  return `Finish or cancel the ${open.label} dialog first (Esc).`;
}

/** Top-level dialog-state fields that describe how the dialog LOOKS rather than
 *  what it will build, so changing them does not count as touching it: where it
 *  sits on screen (`x`, `y`), which slot is waiting for the next click (`arming`,
 *  `armed`), and whether a disclosure is expanded (`advanced`). Arming a slot is
 *  not work; filling it is, and that shows up in the slot's own field. */
export const DIALOG_VIEW_FIELDS: readonly string[] = ["x", "y", "arming", "armed", "advanced"];

/** A comparable summary of a dialog's state: its JSON with the view-only fields
 *  left out. Only the top level is filtered, since nested values (picked
 *  geometry, say) may legitimately carry fields with the same names. */
export function dialogFingerprint(state: object): string {
  const kept = Object.fromEntries(Object.entries(state).filter(([k]) => !DIALOG_VIEW_FIELDS.includes(k)));
  return JSON.stringify(kept);
}

/** Remembers each open dialog's state as it was when the dialog opened, so
 *  "untouched" can be answered generically — by comparing against that baseline —
 *  instead of every dialog hook keeping a dirty flag of its own.
 *
 *  `touched` is called on every render with each dialog's current state (null
 *  while closed). The first non-null state it sees becomes the baseline; null
 *  forgets it, so the next opening starts afresh. Changing something and then
 *  changing it back counts as untouched again, which is what it is.
 *
 *  `forget` drops every baseline. The swap needs it: cancelling a dialog and
 *  opening the next in one key press can reuse the same state slot without a
 *  closed render in between (Chamfer → Fillet share one dialog), and that new
 *  dialog must be measured against its own opening state, not the last one's. */
export class DialogBaselines {
  private readonly baselines = new Map<string, string>();

  touched(key: string, state: object | null | undefined): boolean {
    if (!state) {
      this.baselines.delete(key);
      return false;
    }
    const now = dialogFingerprint(state);
    const base = this.baselines.get(key);
    if (base === undefined) {
      this.baselines.set(key, now);
      return false;
    }
    return base !== now;
  }

  forget(): void {
    this.baselines.clear();
  }
}
