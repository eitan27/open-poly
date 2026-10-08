// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSketchSession } from "./useSketchSession";

afterEach(cleanup);

interface Draft {
  sourceIds: string[];
}

describe("useSketchSession", () => {
  it("starts with no session in progress", () => {
    const { result } = renderHook(() => useSketchSession<Draft>());
    expect(result.current.value).toBeNull();
    expect(result.current.ref.current).toBeNull();
  });

  it("holds a session and clears back to null", () => {
    const { result } = renderHook(() => useSketchSession<Draft>());
    act(() => result.current.set({ sourceIds: ["a"] }));
    expect(result.current.value).toEqual({ sourceIds: ["a"] });
    act(() => result.current.set(null));
    expect(result.current.value).toBeNull();
  });

  it("takes an updater, so a session can accumulate", () => {
    const { result } = renderHook(() => useSketchSession<Draft>());
    act(() => result.current.set({ sourceIds: ["a"] }));
    act(() => result.current.set((p) => (p ? { sourceIds: [...p.sourceIds, "b"] } : p)));
    expect(result.current.value).toEqual({ sourceIds: ["a", "b"] });
  });

  // The whole reason the ref exists. The global keydown handler is registered once
  // and closes over whatever existed then, so it reads `ref.current` instead — and
  // that has to be the CURRENT session, not the previous render's. Mirroring during
  // render rather than in an effect is what makes this true.
  it("keeps ref.current in step with value, never a render behind", () => {
    const seen: (Draft | null)[] = [];
    const { result } = renderHook(() => {
      const s = useSketchSession<Draft>();
      // Read the ref during the same render that produced the value, the way a
      // handler called mid-gesture would.
      seen.push(s.ref.current);
      return s;
    });
    act(() => result.current.set({ sourceIds: ["a"] }));
    act(() => result.current.set({ sourceIds: ["a", "b"] }));
    expect(result.current.ref.current).toEqual({ sourceIds: ["a", "b"] });
    // Every render saw its own value, so the last entry is never the one before it.
    expect(seen[seen.length - 1]).toEqual({ sourceIds: ["a", "b"] });
  });

  it("gives each session its own state, so five of them don't share one", () => {
    const { result } = renderHook(() => ({
      a: useSketchSession<Draft>(),
      b: useSketchSession<Draft>(),
    }));
    act(() => result.current.a.set({ sourceIds: ["only-a"] }));
    expect(result.current.a.value).toEqual({ sourceIds: ["only-a"] });
    expect(result.current.b.value).toBeNull();
  });

  describe("commitRef", () => {
    it("starts as a no-op, so a key press before commit exists does nothing", () => {
      const { result } = renderHook(() => useSketchSession<Draft>());
      expect(() => result.current.commitRef.current()).not.toThrow();
    });

    it("calls the LATEST commit, not the one installed first", () => {
      // This is the stale-closure bug the ref is here to prevent: commit is
      // redefined every render over the current doc, and Enter must reach that one.
      const calls: string[] = [];
      const { result, rerender } = renderHook(
        ({ tag }: { tag: string }) => {
          const s = useSketchSession<Draft>();
          s.commitRef.current = () => calls.push(tag);
          return s;
        },
        { initialProps: { tag: "first" } },
      );
      rerender({ tag: "second" });
      result.current.commitRef.current();
      expect(calls).toEqual(["second"]);
    });

    it("is stable across renders, so a handler can capture it once", () => {
      const { result, rerender } = renderHook(() => useSketchSession<Draft>());
      const first = result.current.commitRef;
      rerender();
      expect(result.current.commitRef).toBe(first);
    });
  });
});
