import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bannerItems, newSince, parseWhatsNew, type WhatsNewEntry } from "./whatsNew";

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
    expect(newSince([nov, oct], [oct])).toEqual(nov.items);
    expect(newSince([nov, oct], [])).toEqual([...nov.items, ...oct.items]);
  });

  it("a deploy with no new entry has nothing to show (the plain banner)", () => {
    expect(newSince([nov, oct], [nov, oct])).toEqual([]);
    expect(newSince([], [])).toEqual([]);
  });

  it("keeps the banner to a few items", () => {
    expect(bannerItems(["a", "b"])).toEqual({ shown: ["a", "b"], more: 0 });
    expect(bannerItems(["a", "b", "c", "d", "e"])).toEqual({ shown: ["a", "b", "c"], more: 2 });
  });
});
