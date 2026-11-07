import type { Vec2 } from "../document/types";

/** The live draw cursor, published by the Viewport on every move. Kept outside
 *  React state so riding the cursor re-renders only the field, not the App. */
export interface DraftCursor {
  uv: Vec2;
  /** Canvas-relative pixels. */
  x: number;
  y: number;
}

let current: DraftCursor | null = null;
const listeners = new Set<() => void>();
export const draftCursorStore = {
  set(c: DraftCursor) {
    current = c;
    listeners.forEach((l) => l());
  },
  get: () => current,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
