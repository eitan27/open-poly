import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bannerItems, boldRuns, newSince, parseWhatsNew, type WhatsNewEntry } from "./whatsNew";

const nov: WhatsNewEntry = {
  date: "2026-11-05",
  items: ["Sync documents with Google Drive", "Improved mobile device support"],
};
const oct: WhatsNewEntry = { date: "2026-10-23", items: ["Work offline after your first visit"] };

describe("whatsNew", () => {
  it("the repo's whatsnew.json is valid", () => {
    expect(() => parseWhatsNew(JSON.parse(readFileSync("whatsnew.json", "utf8")))).not.toThrow();
  });

  it("rejects malformed entries", () => {
    expect(() => parseWhatsNew({})).toThrow(/array/);
    expect(() => parseWhatsNew([{ date: "5 Nov", items: ["x"] }])).toThrow(/YYYY-MM-DD/);
    expect(() => parseWhatsNew([{ date: "2026-11-05", items: [] }])).toThrow(/non-empty/);
    expect(() => parseWhatsNew([{ date: "2026-11-05", items: ["  "] }])).toThrow(/non-empty/);
  });

  it("shows only what this tab's bundle didn't have, newest first", () => {
    const texts = (a: WhatsNewEntry[], b: WhatsNewEntry[]) => newSince(a, b).map((i) => i.text);
    expect(texts([nov, oct], [oct])).toEqual(nov.items);
    expect(texts([nov, oct], [])).toEqual([...nov.items, ...oct.items]);
  });

  it("a deploy with no new entry has nothing to show (the plain banner)", () => {
    expect(newSince([nov, oct], [nov, oct])).toEqual([]);
    expect(newSince([], [])).toEqual([]);
  });

  it("keeps the banner to a few items", () => {
    expect(bannerItems(["a", "b"])).toEqual({ shown: ["a", "b"], more: 0 });
    expect(bannerItems(["a", "b", "c", "d", "e"])).toEqual({ shown: ["a", "b", "c"], more: 2 });
  });

  it("takes bold phrases that appear in the entry's items, and nothing else", () => {
    expect(parseWhatsNew([{ date: "2026-11-13", items: ["Assemblies: mates"], bold: ["Assemblies"] }])[0].bold).toEqual(
      ["Assemblies"],
    );
    expect(() => parseWhatsNew([{ date: "2026-11-13", items: ["Assemblies"], bold: ["Sketch"] }])).toThrow(/bold/);
    expect(() => parseWhatsNew([{ date: "2026-11-13", items: ["Assemblies"], bold: "Assemblies" }])).toThrow(/bold/);
  });

  it("gives each item the bold phrases in it", () => {
    const e: WhatsNewEntry = {
      date: "2026-11-13",
      items: ["Assemblies: mates", "Press New → Assembly"],
      bold: ["Assemblies", "New → Assembly"],
    };
    expect(newSince([e], [])).toEqual([
      { text: "Assemblies: mates", bold: ["Assemblies"] },
      { text: "Press New → Assembly", bold: ["New → Assembly"] },
    ]);
  });

  it("an entry's bold doesn't change which entries a tab already has", () => {
    // Tabs on builds before `bold` know the entry without it: still the same entry.
    const e: WhatsNewEntry = { date: "2026-11-13", items: ["Assemblies"], bold: ["Assemblies"] };
    expect(newSince([e], [{ date: e.date, items: e.items }])).toEqual([]);
  });

  it("cuts text into bold and plain runs", () => {
    expect(boldRuns("Assemblies: join parts", ["Assemblies"])).toEqual([
      { text: "Assemblies", bold: true },
      { text: ": join parts", bold: false },
    ]);
    expect(boldRuns("Just press New → Assembly and insert", ["New → Assembly"])).toEqual([
      { text: "Just press ", bold: false },
      { text: "New → Assembly", bold: true },
      { text: " and insert", bold: false },
    ]);
    expect(boldRuns("plain", [])).toEqual([{ text: "plain", bold: false }]);
  });
});
