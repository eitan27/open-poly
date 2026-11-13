// "What's new" for the update banner (pure, Node-tested). The list is written
// by hand in /whatsnew.json — one short user-facing line per feature, newest
// entry first — and the build bakes it into the bundle AND serves it in
// /version.json. An open tab can't know what a newer deploy added, so it reads
// the served list and shows the entries its own bundle didn't have.
//
// Bold is a separate `bold` list of phrases, not markup in the text: tabs on
// builds from before it existed render items as plain text, and would show
// "**…**" literally. They ignore the extra field and show the text unbolded.

export interface WhatsNewEntry {
  /** YYYY-MM-DD the entry was added. */
  date: string;
  items: string[];
  /** Phrases to bold wherever they appear in this entry's items. */
  bold?: string[];
}

/** One line of the banner: its text and the phrases in it to bold. */
export interface WhatsNewItem {
  text: string;
  bold: string[];
}

/** Validate /whatsnew.json at build time: a malformed file fails the build
 *  rather than shipping a banner that can't render. */
export function parseWhatsNew(raw: unknown): WhatsNewEntry[] {
  if (!Array.isArray(raw)) throw new Error("whatsnew.json must be an array of entries");
  return raw.map((e, i) => {
    const entry = e as Partial<WhatsNewEntry>;
    if (typeof entry.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      throw new Error(`whatsnew.json entry ${i}: "date" must be YYYY-MM-DD`);
    }
    if (
      !Array.isArray(entry.items) ||
      !entry.items.length ||
      entry.items.some((t) => typeof t !== "string" || !t.trim())
    ) {
      throw new Error(`whatsnew.json entry ${i}: "items" must be a non-empty list of text`);
    }
    const items = entry.items.map((t) => t.trim());
    if (entry.bold === undefined) return { date: entry.date, items };
    if (
      !Array.isArray(entry.bold) ||
      entry.bold.some((b) => typeof b !== "string" || !b.trim() || !items.some((t) => t.includes(b)))
    ) {
      throw new Error(`whatsnew.json entry ${i}: each "bold" phrase must appear in one of its items`);
    }
    return { date: entry.date, items, bold: entry.bold };
  });
}

/** An entry's identity: its date and text, not its bold (which builds from
 *  before `bold` don't see). */
export const entryKey = (e: WhatsNewEntry) => `${e.date}|${e.items.join("|")}`;
const key = entryKey;

const itemsOf = (entries: WhatsNewEntry[]): WhatsNewItem[] =>
  entries.flatMap((e) => e.items.map((text) => ({ text, bold: (e.bold ?? []).filter((b) => text.includes(b)) })));

/** The items in `served` (the deployed list) that `known` (this tab's own
 *  bundle) didn't have, newest first. Empty when a deploy added no entry —
 *  the banner then reads as it always did. */
export function newSince(served: WhatsNewEntry[], known: WhatsNewEntry[]): WhatsNewItem[] {
  const seen = new Set(known.map(key));
  return itemsOf(served.filter((e) => !seen.has(key(e))));
}

/** The day the since-last-visit record shipped (with the assemblies entry). */
export const RECORD_SINCE = "2026-11-13";

/** For a page just loaded: the items of `entries` (this build's list) the
 *  visitor hasn't seen, and the seen keys to store for next time. `seen` is
 *  what was stored, or null when nothing was. With nothing stored, a first
 *  visit shows nothing (all of it is new to them) and only records what's
 *  there now; but someone who used the app before this record existed
 *  (`returning`) last loaded a build from before `recordSince`, so they get
 *  every entry from that day on — and always the newest. */
export function sinceLastVisit(
  entries: WhatsNewEntry[],
  seen: string[] | null,
  returning = false,
  recordSince = RECORD_SINCE,
): { items: WhatsNewItem[]; seen: string[] } {
  const keys = entries.map(key);
  if (seen === null && !returning) return { items: [], seen: keys };
  const had = new Set(seen ?? entries.filter((e, i) => i > 0 && e.date < recordSince).map(key));
  return { items: itemsOf(entries.filter((e) => !had.has(key(e)))), seen: keys };
}

/** `text` cut into runs, each bold or not, for the phrases in `bold`. */
export function boldRuns(text: string, bold: string[]): { text: string; bold: boolean }[] {
  const runs: { text: string; bold: boolean }[] = [];
  let rest = text;
  while (rest) {
    // The earliest phrase next; the longer one where two start together.
    let at = -1;
    let hit = "";
    for (const b of bold) {
      const i = rest.indexOf(b);
      if (i >= 0 && (at < 0 || i < at || (i === at && b.length > hit.length))) [at, hit] = [i, b];
    }
    if (at < 0) {
      runs.push({ text: rest, bold: false });
      break;
    }
    if (at > 0) runs.push({ text: rest.slice(0, at), bold: false });
    runs.push({ text: hit, bold: true });
    rest = rest.slice(at + hit.length);
  }
  return runs;
}

/** At most `max` items for the one-line banner; the rest become "+N more". */
export function bannerItems<T>(items: T[], max = 3): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}
