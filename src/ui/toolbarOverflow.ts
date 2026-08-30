// Overflow logic for the floating viewport toolbars: which buttons fit in the
// space available, and how the "…" flyout's search ranks tools. Kept free
// of React/DOM (the one React import is a type, erased at build) so both halves
// are unit-testable in node.
import type { ReactNode } from "react";

/** A choice behind a toolbar button's ▾ dropdown (New Body → Box/Cylinder/…). */
export interface ToolbarChoice {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** One button in an overflow-aware toolbar. */
export interface ToolbarItem {
  id: string;
  /** Glyph or icon element shown before the label ("⬆"). */
  icon: ReactNode;
  /** Short name: the button label AND the primary search term. */
  label: string;
  /** Single-key shortcut, shown as a hint when hints are on / in the flyout. */
  shortcut?: string;
  /** Tooltip — the long "what this does" text. */
  title: string;
  disabled?: boolean;
  /** Extra search terms that don't appear in the label ("bevel" → Chamfer). */
  keywords?: string[];
  onSelect: () => void;
  /** Choices behind a ▾ dropdown. In the bar the button opens them as a menu;
   *  in the More flyout they're flattened into their own searchable rows. */
  choices?: ToolbarChoice[];
  /** Controlled open state for `choices` (App owns it so the keyboard shortcut
   *  can toggle the same menu). */
  choicesOpen?: boolean;
  onChoicesOpenChange?: (open: boolean) => void;
}

/** A flattened, directly-invokable line in the More flyout. */
export interface ToolbarRow {
  /** Unique per row — a choice row is "<item>/<choice>". */
  id: string;
  /** The item this row came from, so the caller can tell which rows are hidden. */
  itemId: string;
  icon: ReactNode;
  label: string;
  shortcut?: string;
  title: string;
  disabled: boolean;
  keywords: string[];
  onSelect: () => void;
}

/**
 * How many of `widths` fit in `available`, laid out in a row with `gap`
 * between neighbours. The More button is always on the bar — it doubles as the
 * "find me a tool" search, so it's there even when nothing is hidden — so its
 * `moreWidth` (plus its own gap) is reserved first, and the answer is how many
 * fit *alongside* More.
 */
export function fitCount(widths: number[], gap: number, available: number, moreWidth: number): number {
  // A sub-pixel slack: widths come from getBoundingClientRect, and a total that
  // rounds to exactly the available width must not overflow by 0.0001px.
  const SLACK = 0.5;
  let used = moreWidth;
  let n = 0;
  for (const w of widths) {
    const next = used + gap + w;
    if (next > available + SLACK) break;
    used = next;
    n++;
  }
  return n;
}

/** Expands dropdown items into one row per choice; plain items pass through. */
export function toRows(items: ToolbarItem[]): ToolbarRow[] {
  const rows: ToolbarRow[] = [];
  for (const item of items) {
    if (item.choices && item.choices.length > 0) {
      for (const choice of item.choices) {
        rows.push({
          id: `${item.id}/${choice.id}`,
          itemId: item.id,
          icon: item.icon,
          // Both words are searchable: "body" and "cylinder" each hit.
          label: `${item.label} ▸ ${choice.label}`,
          title: `${item.title} — ${choice.label}`,
          disabled: !!(item.disabled || choice.disabled),
          keywords: item.keywords ?? [],
          onSelect: choice.onSelect,
        });
      }
      continue;
    }
    rows.push({
      id: item.id,
      itemId: item.id,
      icon: item.icon,
      label: item.label,
      shortcut: item.shortcut,
      title: item.title,
      disabled: !!item.disabled,
      keywords: item.keywords ?? [],
      onSelect: item.onSelect,
    });
  }
  return rows;
}

/** True when every character of `needle` appears in `hay`, in order. */
function isSubsequence(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * How well a row matches `query`: lower is better, `null` is no match.
 * The tiers are deliberately coarse — within a tier the caller's original
 * (toolbar) order breaks ties, which keeps the list stable as you type.
 */
export function matchScore(row: Pick<ToolbarRow, "label" | "keywords">, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = row.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  // A word inside the label: "cylinder" matching "Body ▸ Cylinder".
  if (label.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 1;
  if (label.includes(q)) return 2;
  const keywords = row.keywords.map((k) => k.toLowerCase());
  if (keywords.some((k) => k.startsWith(q))) return 3;
  if (keywords.some((k) => k.includes(q))) return 4;
  // Last resort so typos/abbreviations ("flt" → Fillet) still find something.
  if (isSubsequence(label, q)) return 5;
  return null;
}

/** Rows matching `query`, best first; ties keep their incoming order. */
export function searchRows(rows: ToolbarRow[], query: string): ToolbarRow[] {
  if (!query.trim()) return rows;
  return rows
    .map((row, i) => ({ row, i, score: matchScore(row, query) }))
    .filter((r): r is { row: ToolbarRow; i: number; score: number } => r.score !== null)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((r) => r.row);
}

/**
 * The next selectable row when arrowing by `step` from `from` (which may be
 * -1 for "nothing active yet"). Disabled rows are skipped and the ends wrap.
 * Returns -1 when nothing is selectable.
 */
export function nextEnabledIndex(rows: ToolbarRow[], from: number, step: number): number {
  if (rows.length === 0) return -1;
  const start = from < 0 ? (step > 0 ? -1 : 0) : from;
  for (let k = 1; k <= rows.length; k++) {
    const i = (((start + step * k) % rows.length) + rows.length) % rows.length;
    if (!rows[i].disabled) return i;
  }
  return -1;
}
