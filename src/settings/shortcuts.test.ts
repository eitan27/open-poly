import { describe, it, expect } from "vitest";
import {
  SHORTCUTS,
  firesWithAnyShift,
  modsOf,
  shortcut,
  shortcutHint,
  shortcutName,
  matchShortcut,
  isShortcut,
} from "./shortcuts";
import type { Shortcut } from "./shortcuts";

/**
 * Every concrete chord a shortcut swallows. Usually one — but an `anyShift`
 * entry never looks at Shift, so it swallows the Shift version of its key too,
 * and would shadow a Shift variant someone added later.
 */
const chordsOf = (s: Shortcut): string[] => {
  const base = [...modsOf(s)].filter((m) => m !== "shift").sort();
  const spell = (mods: string[]) => [s.key.toLowerCase(), ...mods].join("+");
  if (firesWithAnyShift(s)) return [spell(base), spell([...base, "shift"].sort())];
  return [spell([...modsOf(s)].sort())];
};

/** Every mode a shortcut is live in — "both" is live in each of them. */
const livesIn = (s: Shortcut) => (s.mode === "both" ? (["modeling", "sketch"] as const) : ([s.mode] as const));

/**
 * The reason this table exists. Two tools sharing a chord inside one mode means
 * one of them silently never fires; the doc this replaced checked that by eye,
 * and got it wrong.
 */
describe("no two shortcuts collide within a mode", () => {
  for (const mode of ["modeling", "sketch"] as const) {
    it(`${mode} mode`, () => {
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const s of SHORTCUTS) {
        if (!livesIn(s).includes(mode)) continue;
        for (const c of chordsOf(s)) {
          const previous = seen.get(c);
          if (previous) collisions.push(`${c} is claimed by both ${previous} and ${s.id}`);
          else seen.set(c, s.id);
        }
      }
      expect(collisions).toEqual([]);
    });
  }
});

describe("the table itself", () => {
  it("gives every entry a non-empty label", () => {
    expect(SHORTCUTS.filter((s) => s.label.trim() === "").map((s) => s.id)).toEqual([]);
  });

  it("gives every entry a unique id", () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  });

  it("stores single-character keys lower-cased, so matching can fold case", () => {
    expect(SHORTCUTS.filter((s) => s.key.length === 1 && s.key !== s.key.toLowerCase()).map((s) => s.id)).toEqual([]);
  });

  it("reuses letters only across the two mutually exclusive toolbars", () => {
    // Not a collision — the point of the mode field. Guards against someone
    // "fixing" one of these by moving it.
    expect(shortcut("model.plane").key).toBe(shortcut("sketch.polygon").key);
    expect(shortcut("model.transform").key).toBe(shortcut("sketch.text").key);
    expect(shortcut("view.home").key).toBe(shortcut("sketch.horizontal").key);
  });
});

const press = (key: string, opts: Partial<KeyboardEvent> = {}) =>
  ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...opts }) as KeyboardEvent;

describe("shortcutHint", () => {
  it("upper-cases the letter and prefixes the modifiers", () => {
    expect(shortcutHint("model.extrude")).toBe("E");
    expect(shortcutHint("sketch.extend")).toBe("⇧K");
    expect(shortcutHint("sketch.equal")).toBe("=");
    expect(shortcutHint("app.redo")).toBe("⌘⇧Z");
    expect(shortcutHint("feature.moveUp")).toBe("⌥↑");
  });
});

describe("shortcutName", () => {
  it("spells the modifiers out, for the tooltips that name their key in prose", () => {
    expect(shortcutName("model.extrude")).toBe("E");
    expect(shortcutName("sketch.extend")).toBe("Shift+K");
    expect(shortcutName("sketch.parallel")).toBe("Shift+P");
    expect(shortcutName("sketch.equal")).toBe("=");
  });
});

describe("matchShortcut", () => {
  it("routes a shared letter by mode", () => {
    expect(matchShortcut(press("l"), "modeling")?.id).toBe("model.loft");
    expect(matchShortcut(press("l"), "sketch")?.id).toBe("sketch.line");
  });

  it("keeps the Shift variants of the sketch tools apart", () => {
    expect(matchShortcut(press("r"), "sketch")?.id).toBe("sketch.rectCorner");
    expect(matchShortcut(press("R", { shiftKey: true }), "sketch")?.id).toBe("sketch.rectCenter");
    expect(matchShortcut(press("p"), "sketch")?.id).toBe("sketch.polygon");
    expect(matchShortcut(press("P", { shiftKey: true }), "sketch")?.id).toBe("sketch.parallel");
  });

  it("does not fire a sketch tool when Shift is down and it has no variant", () => {
    expect(matchShortcut(press("O", { shiftKey: true }), "sketch")).toBeUndefined();
  });

  it("tells undo from redo, and needs the ⌘ the entry asks for", () => {
    expect(matchShortcut(press("z", { metaKey: true }), "modeling")?.id).toBe("app.undo");
    expect(matchShortcut(press("z", { metaKey: true, shiftKey: true }), "modeling")?.id).toBe("app.redo");
    expect(matchShortcut(press("z", { ctrlKey: true }), "modeling")?.id).toBe("app.undo");
    expect(matchShortcut(press("z"), "modeling")).toBeUndefined();
  });

  it("still matches a ⌘-less entry with ⌘ held — the handler drops those, not the table", () => {
    // Escape / "?" / "/" / Enter / Delete were all handled above the old
    // handler's "leave other OS/browser chords alone" bail-out, so they had to
    // survive a stray ⌘. Everything below it (⌘E and friends) never reaches
    // the table, because the handler still bails at that same point.
    expect(matchShortcut(press("Escape", { metaKey: true }), "sketch")?.id).toBe("app.cancel");
    expect(matchShortcut(press("e", { metaKey: true }), "modeling")?.id).toBe("model.extrude");
  });

  it("serves the views and the tool search in both modes", () => {
    expect(matchShortcut(press("1"), "modeling")?.id).toBe("view.top");
    expect(matchShortcut(press("1"), "sketch")?.id).toBe("view.top");
    expect(matchShortcut(press("/"), "sketch")?.id).toBe("app.toolSearch");
  });

  it("only moves a feature with Alt held", () => {
    expect(matchShortcut(press("ArrowUp", { altKey: true }), "modeling")?.id).toBe("feature.moveUp");
    expect(matchShortcut(press("ArrowUp"), "modeling")).toBeUndefined();
  });
});

describe("isShortcut", () => {
  it("matches one entry regardless of mode", () => {
    expect(isShortcut(press("Escape"), "app.cancel")).toBe(true);
    expect(isShortcut(press("Enter"), "app.cancel")).toBe(false);
  });
});
