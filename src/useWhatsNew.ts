import { useState } from "react";
import { entryKey, sinceLastVisit, type WhatsNewEntry, type WhatsNewItem } from "./whatsNew";

// "What's new since your last visit": the update banner (useVersionCheck.ts)
// only reaches a tab that was open when a new version deployed. Anyone who
// loads the page fresh gets the same entries here, once: the browser keeps the
// keys of the entries it has shown (or that were there on a first visit, which
// shows nothing), so each is seen once and only by someone it's new to.
// Per-browser convenience, so localStorage, and a page that can't read or
// write it simply shows nothing.

const STORAGE_KEY = "openpoly.whatsNewSeen";

function readSeen(): string[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.every((k) => typeof k === "string") ? v : null;
  } catch {
    return null;
  }
}

function writeSeen(keys: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Private mode, storage blocked: the line just shows again next time.
  }
}

/** Whether this browser used the app before the seen record existed: it has
 *  the open document's id from a past visit. Read on the first render, before
 *  this visit's boot sets it. */
function usedBefore(): boolean {
  try {
    return localStorage.getItem("openpoly.activeDocId") !== null;
  } catch {
    return false;
  }
}

/** Record `entries` as seen, so a page loaded later doesn't repeat them — the
 *  update banner calls this for what it showed, as Refresh then loads them. */
export function markWhatsNewSeen(entries: WhatsNewEntry[]) {
  const seen = new Set(readSeen() ?? __WHATS_NEW__.map(entryKey));
  for (const e of entries) seen.add(entryKey(e));
  writeSeen([...seen]);
}

/** The items this build has that the visitor hasn't seen, worked out once on
 *  load (and recorded as seen right away), and a way to hide the line. */
export function useWhatsNewSinceLastVisit(): { items: WhatsNewItem[]; dismiss: () => void } {
  const [items, setItems] = useState<WhatsNewItem[]>(() => {
    const { items, seen } = sinceLastVisit(__WHATS_NEW__, readSeen(), usedBefore());
    writeSeen(seen);
    return items;
  });
  return { items, dismiss: () => setItems([]) };
}
