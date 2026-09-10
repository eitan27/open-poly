import { useCallback, useState } from "react";

// Undo/redo state container. Consecutive edits that share a `coalesceKey`
// (e.g. typing into the same field) collapse into a single undo step, while
// structural edits (add/delete/reorder) always create a new step.
interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey?: string;
}

export function useHistory<T>(initial: T | (() => T)) {
  const [hist, setHist] = useState<HistoryState<T>>(() => ({
    past: [],
    present: typeof initial === "function" ? (initial as () => T)() : initial,
    future: [],
  }));

  const set = useCallback((next: T | ((prev: T) => T), coalesceKey?: string) => {
    setHist((h) => {
      const value = typeof next === "function" ? (next as (prev: T) => T)(h.present) : next;
      if (value === h.present) return h;
      if (coalesceKey && h.lastKey === coalesceKey) {
        return { ...h, present: value, future: [] };
      }
      return { past: [...h.past, h.present], present: value, future: [], lastKey: coalesceKey };
    });
  }, []);

  const undo = useCallback(() => {
    setHist((h) => {
      if (h.past.length === 0) return h;
      return {
        past: h.past.slice(0, -1),
        present: h.past[h.past.length - 1],
        future: [h.present, ...h.future],
        lastKey: undefined,
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHist((h) => {
      if (h.future.length === 0) return h;
      return {
        past: [...h.past, h.present],
        present: h.future[0],
        future: h.future.slice(1),
        lastKey: undefined,
      };
    });
  }, []);

  // Swap the present WITHOUT touching the undo stack — for a DERIVED value
  // catching up with the state already in play (a dimension re-evaluating after
  // its variable changed), not for a user edit. The edit that caused it is
  // already a step, and undoing that step restores the pre-derivation snapshot,
  // so the recomputation must not add a second step of its own.
  const replace = useCallback((next: T | ((prev: T) => T)) => {
    setHist((h) => {
      const value = typeof next === "function" ? (next as (prev: T) => T)(h.present) : next;
      return value === h.present ? h : { ...h, present: value };
    });
  }, []);

  // Replace the whole state and clear undo/redo — e.g. loading a saved document
  // shouldn't leave an undo path back to the placeholder it replaced.
  const reset = useCallback((value: T) => {
    setHist({ past: [], present: value, future: [] });
  }, []);

  return {
    state: hist.present,
    set,
    replace,
    reset,
    undo,
    redo,
    canUndo: hist.past.length > 0,
    canRedo: hist.future.length > 0,
  };
}
