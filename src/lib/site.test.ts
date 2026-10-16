import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITE_TITLE } from "./site";

// The tab title is set twice: statically in index.html, which is all a crawler
// that does not execute JS ever sees, and at runtime once a document loads.
// They have to agree, and nothing but this test makes them.
describe("SITE_TITLE", () => {
  it("matches the <title> shipped in index.html", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(html).toContain(`<title>${SITE_TITLE}</title>`);
  });

  it("stays inside what a search result will show", () => {
    expect(SITE_TITLE.length).toBeLessThanOrEqual(60);
  });
});
