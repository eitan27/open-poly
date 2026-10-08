// The global keyboard handler, beside the table it dispatches from.
//
// Every binding — which key, which modifier, which of the two mutually exclusive
// toolbars it belongs to — lives in `shortcuts.ts`. This hook owns the ORDER things
// are tried in, which is load-bearing and was the subtle part of the 290-line effect
// it replaces. The caller supplies only what each shortcut id *does*; no key letter
// appears here or there.
//
// Four precedence rules, in this order:
//
//  1. **Escape goes first, above the don't-fire-while-typing guard.** It has to back
//     you out of a dialog whose input holds the focus.
//  2. **`withModifier` is tried before the ⌘/Ctrl bail-out.** A handful of bindings
//     are meant to keep firing with the modifier held (undo, redo, delete, the hint
//     toggle); everything else must leave OS and browser chords alone.
//  3. **In sketch mode the sketch bindings are the whole story** — matched, handled,
//     and returned from, so a sketch key can never fall through to a modeling one.
//  4. **In modeling mode `whilePicking` beats the pick guard.** Those few bindings
//     work while a viewport pick is armed; every other modeling binding stands down,
//     and the ones that do run are `preventDefault`ed first, because several mount a
//     dialog with an autofocusing input and the same keystroke would otherwise leak
//     into it ("e" turning an Extrude distance of "10" into "10e").
//
// The listener registers ONCE and reads its config through a ref. The effect this
// replaced listed 36 dependencies behind an `exhaustive-deps` disable — a
// hand-maintained defence against stale closures that had already failed once and
// been patched in place (a comment in that array explained why `shell.dialog` had to
// join it). Reading through a ref removes the whole class of bug instead.
import { useEffect, useRef } from "react";
import type { SketchTool, ViewName } from "../viewport/types";
import { isShortcut, matchShortcut, type ShortcutId } from "./shortcuts";

/** What a shortcut does. Returning `false` means "not handled after all, keep
 *  looking" — only `feature.moveUp`/`moveDown` need it, because they apply to the
 *  primary selected feature and there may not be one. */
export type ShortcutAction = (e: KeyboardEvent) => boolean | void;

type ActionMap = Partial<Record<ShortcutId, ShortcutAction>>;

export interface ShortcutHandlerConfig {
  /** Which toolbar's bindings are live. The two are mutually exclusive, which is
   *  what lets a letter mean different things in each. */
  mode: "sketch" | "modeling";
  /** True while a viewport pick is armed. */
  picking: boolean;
  /** Escape: back out of whatever is innermost. The cascade is the caller's. */
  onCancel: () => void;
  /** Bindings that must survive ⌘/Ctrl — see rule 2. */
  withModifier: ActionMap;
  /** Standard views, which work in both modes. */
  views: Partial<Record<ShortcutId, ViewName>>;
  onView: (view: ViewName) => void;
  /** Sketch-mode tool keys, which are `preventDefault`ed before switching. */
  sketchTools: Map<ShortcutId, SketchTool>;
  onSketchTool: (tool: SketchTool) => void;
  /** Everything else in sketch mode. */
  sketchActions: ActionMap;
  /** Modeling bindings that keep working while a pick is armed — see rule 4. */
  whilePicking: ActionMap;
  /** Modeling feature bindings: suppressed during a pick, `preventDefault`ed. */
  modelingActions: ActionMap;
}

/** Run `id`'s action from `map`, and say whether that settles the key. An action
 *  returning `false` declines it, so the search continues past this map. */
function handled(map: ActionMap, id: ShortcutId | undefined, e: KeyboardEvent): boolean {
  const action = id && map[id];
  return action ? action(e) !== false : false;
}

export function useShortcutHandler(config: ShortcutHandlerConfig): void {
  const ref = useRef(config);
  // Mirrored during render so the handler is never a render behind — the same
  // reason `useSketchSession` does it, and the reason this needs no dependencies.
  ref.current = config;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = ref.current;

      // 1. Escape, before the typing guard.
      if (isShortcut(e, "app.cancel")) {
        c.onCancel();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const id = matchShortcut(e, c.mode)?.id;

      // 2. The bindings that survive the modifier, then the bail-out.
      if (handled(c.withModifier, id, e)) return;
      if (e.metaKey || e.ctrlKey) return;

      if (id && c.views[id]) {
        c.onView(c.views[id]!);
        return;
      }

      // 3. Sketch mode is self-contained.
      if (c.mode === "sketch") {
        const tool = id && c.sketchTools.get(id);
        if (tool) {
          e.preventDefault();
          c.onSketchTool(tool);
          return;
        }
        if (id) c.sketchActions[id]?.(e);
        return;
      }

      // 4. Modeling: the pick-surviving bindings, the guard, then the rest.
      if (handled(c.whilePicking, id, e)) return;
      if (c.picking) return;
      e.preventDefault();
      if (id) c.modelingActions[id]?.(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
