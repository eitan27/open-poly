// "What's new" for the update banner (pure, Node-tested). The list is written
// by hand in /whatsnew.json — one short user-facing line per feature, newest
// entry first — and the build bakes it into the bundle AND serves it in
// /version.json. An open tab can't know what a newer deploy added, so it reads
// the served list and shows the entries its own bundle didn't have.

export interface WhatsNewEntry {
  /** YYYY-MM-DD the entry was added. */
  date: string;
  items: string[];
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
    return { date: entry.date, items: entry.items.map((t) => t.trim()) };
  });
}

const key = (e: WhatsNewEntry) => `${e.date}|${e.items.join("|")}`;

/** The items in `served` (the deployed list) that `known` (this tab's own
 *  bundle) didn't have, newest first. Empty when a deploy added no entry —
 *  the banner then reads as it always did. */
export function newSince(served: WhatsNewEntry[], known: WhatsNewEntry[]): string[] {
  const seen = new Set(known.map(key));
  return served.filter((e) => !seen.has(key(e))).flatMap((e) => e.items);
}

/** At most `max` items for the one-line banner; the rest become "+N more". */
export function bannerItems(items: string[], max = 3): { shown: string[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}
