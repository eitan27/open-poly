import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, resolveTheme, saveSettings, systemTheme } from "./settings";

const KEY = "openpoly.settings";

// jsdom is not the test environment here (vitest.config.ts runs node), so stand
// in a minimal localStorage. The point of these tests is the coercion layer, not
// the browser API.
function installStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(KEY, initial);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  return store;
}

describe("loadSettings", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns the defaults when nothing is stored", () => {
    installStorage();
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a saved settings object", () => {
    installStorage();
    saveSettings({ ...DEFAULT_SETTINGS, theme: "light", showGrid: false });
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: "light", showGrid: false });
  });

  it("keeps known fields and drops unknown ones", () => {
    installStorage(JSON.stringify({ theme: "system", showAxes: false, wat: 1 }));
    const s = loadSettings();
    expect(s.theme).toBe("system");
    expect(s.showAxes).toBe(false);
    expect(s).not.toHaveProperty("wat");
    // Untouched fields keep their defaults rather than becoming undefined.
    expect(s.showViewCube).toBe(DEFAULT_SETTINGS.showViewCube);
  });

  it("falls back per-field on wrong types, rather than failing whole", () => {
    installStorage(JSON.stringify({ theme: "chartreuse", showGrid: "yes", confirmDelete: false }));
    const s = loadSettings();
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.showGrid).toBe(DEFAULT_SETTINGS.showGrid);
    expect(s.confirmDelete).toBe(false); // the one valid field still lands
  });

  it("falls back to the defaults on unparseable JSON", () => {
    installStorage("{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to the defaults when storage throws (private browsing)", () => {
    vi.stubGlobal("localStorage", {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    });
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
  });
});

describe("theme resolution", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("passes explicit choices through", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });

  it("asks the OS for 'system'", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(resolveTheme("system")).toBe("light");
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    expect(resolveTheme("system")).toBe("dark");
  });

  it("defaults 'system' to dark when the browser can't say", () => {
    vi.stubGlobal("window", {});
    expect(systemTheme()).toBe("dark");
    vi.stubGlobal("window", { matchMedia: () => { throw new Error("nope"); } });
    expect(systemTheme()).toBe("dark");
  });
});
