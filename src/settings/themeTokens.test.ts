// Guards the theming contract itself. Both failure modes here are silent in
// dark mode — the app looks fine to whoever wrote the CSS — and only show up as
// an unreadable patch in light mode, so they need a test rather than review.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const APP_CSS = read("../App.css");
const INDEX_CSS = read("../index.css");

const LIGHT_SELECTOR = ':root[data-theme="light"]';
const [darkBlock, lightBlock] = INDEX_CSS.split(LIGHT_SELECTOR);

const declared = (block: string) => new Set([...block.matchAll(/^\s{2}--([a-z0-9-]+):/gm)].map((m) => m[1]));
const used = new Set([...APP_CSS.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));

describe("colour tokens", () => {
  it("defines every token App.css uses", () => {
    const missing = [...used].filter((t) => !declared(darkBlock).has(t));
    expect(missing).toEqual([]);
  });

  it("overrides every token in the light theme", () => {
    // A token that exists only in :root silently keeps its DARK value under the
    // light theme — e.g. dark-grey text on a white panel.
    const dark = declared(darkBlock);
    const light = declared(lightBlock);
    expect([...dark].filter((t) => !light.has(t))).toEqual([]);
    // …and nothing light-only, which would be a token that does nothing on dark.
    expect([...light].filter((t) => !dark.has(t))).toEqual([]);
  });

  it("leaves no literal colours in App.css", () => {
    // Every colour must route through a token, or it can't be themed. `rgba(var(
    // --x), a)` is fine — the colour is still a token, only the alpha is inline.
    const literals = [
      ...APP_CSS.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
      ...APP_CSS.matchAll(/\brgba?\((?!var\(--)[^)]*\)/g),
    ].map((m) => m[0]);
    expect([...new Set(literals)]).toEqual([]);
  });
});
