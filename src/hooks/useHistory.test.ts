// @vitest-environment jsdom
//
// The first test in this repo that renders React. The suite's default
// environment stays "node" (see vitest.config.ts) — the 813 tests that predate
// it all pass there and have no reason to move. A file that needs a DOM opts in
// with the docblock above, so the cost is paid only where it buys something.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHistory } from "./useHistory";

describe("useHistory", () => {
  it("starts with the initial value and nothing to undo or redo", () => {
    const { result } = renderHook(() => useHistory("a"));
    expect(result.current.state).toBe("a");
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("accepts a lazy initial value", () => {
    const { result } = renderHook(() => useHistory(() => "lazy"));
    expect(result.current.state).toBe("lazy");
  });

  it("pushes a step per set, and undo/redo walk it", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.set("b"));
    act(() => result.current.set("c"));
    expect(result.current.state).toBe("c");

    act(() => result.current.undo());
    expect(result.current.state).toBe("b");
    act(() => result.current.undo());
    expect(result.current.state).toBe("a");
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.redo());
    expect(result.current.state).toBe("b");
    expect(result.current.canRedo).toBe(true);
  });

  it("takes an updater function against the current present", () => {
    const { result } = renderHook(() => useHistory(1));
    act(() => result.current.set((n) => n + 1));
    act(() => result.current.set((n) => n + 1));
    expect(result.current.state).toBe(3);
    act(() => result.current.undo());
    expect(result.current.state).toBe(2);
  });

  it("ignores a set to the identical value — no dead undo step", () => {
    const { result } = renderHook(() => useHistory("a"));
    act(() => result.current.set("a"));
    expect(result.current.canUndo).toBe(false);
  });

  describe("coalescing", () => {
    it("collapses consecutive edits sharing a key into ONE step", () => {
      // Typing into a field: three keystrokes, one undo back to the start.
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.set("ab", "field-1"));
      act(() => result.current.set("abc", "field-1"));
      act(() => result.current.set("abcd", "field-1"));
      expect(result.current.state).toBe("abcd");
      act(() => result.current.undo());
      expect(result.current.state).toBe("a");
      expect(result.current.canUndo).toBe(false);
    });

    it("starts a new step when the key changes — two fields are two edits", () => {
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.set("b", "field-1"));
      act(() => result.current.set("c", "field-2"));
      act(() => result.current.undo());
      expect(result.current.state).toBe("b");
    });

    it("a keyless structural edit after a coalesced run starts its own step", () => {
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.set("b", "field-1"));
      act(() => result.current.set("c"));
      act(() => result.current.undo());
      expect(result.current.state).toBe("b");
    });

    it("does not coalesce back into a run once undo has broken it", () => {
      // undo clears lastKey, so resuming the same field must not silently
      // absorb the new edit into the step the user just undid past.
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.set("b", "field-1"));
      act(() => result.current.undo());
      act(() => result.current.set("z", "field-1"));
      act(() => result.current.undo());
      expect(result.current.state).toBe("a");
    });
  });

  describe("set clears the redo future", () => {
    it("a new edit after undo drops what was ahead", () => {
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.set("b"));
      act(() => result.current.undo());
      expect(result.current.canRedo).toBe(true);
      act(() => result.current.set("c"));
      expect(result.current.canRedo).toBe(false);
    });
  });

  describe("replace", () => {
    it("swaps the present WITHOUT adding an undo step", () => {
      // A derived value catching up (a dimension re-evaluating after its
      // variable changed) must not become a second step of its own.
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.set("b"));
      act(() => result.current.replace("b-derived"));
      expect(result.current.state).toBe("b-derived");
      act(() => result.current.undo());
      expect(result.current.state).toBe("a"); // one step back, not two
    });

    it("leaves the redo future alone", () => {
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.set("b"));
      act(() => result.current.undo());
      act(() => result.current.replace("a-derived"));
      expect(result.current.canRedo).toBe(true);
    });

    it("ignores a replace to the identical value", () => {
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.replace("a"));
      expect(result.current.canUndo).toBe(false);
    });
  });

  describe("reset", () => {
    it("clears both stacks — loading a document leaves no path back", () => {
      const { result } = renderHook(() => useHistory("a"));
      act(() => result.current.set("b"));
      act(() => result.current.undo());
      expect(result.current.canRedo).toBe(true);
      act(() => result.current.reset("loaded"));
      expect(result.current.state).toBe("loaded");
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
    });
  });

  it("keeps its callbacks stable across renders, so consumers don't re-subscribe", () => {
    const { result, rerender } = renderHook(() => useHistory("a"));
    const first = { set: result.current.set, undo: result.current.undo, reset: result.current.reset };
    rerender();
    act(() => result.current.set("b"));
    expect(result.current.set).toBe(first.set);
    expect(result.current.undo).toBe(first.undo);
    expect(result.current.reset).toBe(first.reset);
  });
});
