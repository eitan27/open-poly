// Guards the theming contract itself. Both failure modes here are silent in
// dark mode — the app looks fine to whoever wrote the CSS — and only show up as
// an unreadable patch in light mode, so they need a test rather than review.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** Every stylesheet except the token definitions themselves. Globbed rather than
 *  listed: App.css was split into one file per component, and a hardcoded list
 *  would quietly stop guarding whichever file was added next. */
const styleSheets = (): { name: string; css: string }[] => {
  const out: { name: string; css: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".css") && rel !== "styles/tokens.css") out.push({ name: rel, css: read(rel) });
    }
  };
  walk("");
  return out;
};

const SHEETS = styleSheets();
const ALL_CSS = SHEETS.map((s) => s.css).join("\n");
const TOKENS_CSS = read("styles/tokens.css");

const LIGHT_SELECTOR = ':root[data-theme="light"]';
const [darkBlock, lightBlock] = TOKENS_CSS.split(LIGHT_SELECTOR);

const declared = (block: string) => new Set([...block.matchAll(/^\s{2}--([a-z0-9-]+):/gm)].map((m) => m[1]));
const allUsed = [...ALL_CSS.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
// `--sw-*` are the theme-picker swatches' local colours, set inline per element
// by SettingsDialog.tsx. They are deliberately NOT theme tokens: a swatch paints
// the theme it *names*, which is generally the one the stylesheet is not
// currently painting, so resolving them from :root would be exactly wrong.
const isSwatchLocal = (t: string) => t.startsWith("sw-");
const used = new Set(allUsed.filter((t) => !isSwatchLocal(t)));

describe("colour tokens", () => {
  it("defines every token the stylesheets use", () => {
    const missing = [...used].filter((t) => !declared(darkBlock).has(t));
    expect(missing).toEqual([]);
  });

  it("keeps the swatch locals out of the theme", () => {
    // The other half of the exemption above: if one of these ever gets declared
    // in styles/tokens.css it would silently start tracking the active theme.
    const leaked = allUsed.filter((t) => isSwatchLocal(t) && declared(darkBlock).has(t));
    expect(leaked).toEqual([]);
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

  // Reported per file so a failure names the stylesheet to open, not just the
  // colour — there are sixteen of them now.
  it.each(SHEETS.map((s) => [s.name, s.css] as const))("leaves no literal colours in %s", (_name, css) => {
    // Every colour must route through a token, or it can't be themed. `rgba(var(
    // --x), a)` is fine — the colour is still a token, only the alpha is inline.
    const literals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g), ...css.matchAll(/\brgba?\((?!var\(--)[^)]*\)/g)].map(
      (m) => m[0],
    );
    expect([...new Set(literals)]).toEqual([]);
  });
});
