// @vitest-environment jsdom
//
// Second jsdom opt-in (see useHistory.test.ts). This is the shape that needs
// one: a hook that reads and writes browser storage and subscribes to a browser
// event source, both of which only exist under jsdom.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installWebStorage } from "../test/webStorage";
import { useSettings } from "./useSettings";

/** A controllable matchMedia. jsdom ships none, so each test installs one. */
function installMatchMedia(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mq = {
    matches,
    addEventListener: (_: string, h: (e: MediaQueryListEvent) => void) => listeners.add(h),
    removeEventListener: (_: string, h: (e: MediaQueryListEvent) => void) => listeners.delete(h),
  };
  window.matchMedia = vi.fn().mockReturnValue(mq) as unknown as typeof window.matchMedia;
  return {
    /** Fire an OS theme change at everyone listening. */
    emit(nowMatches: boolean) {
      mq.matches = nowMatches;
      for (const h of listeners) h({ matches: nowMatches } as MediaQueryListEvent);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

beforeEach(() => {
  installWebStorage();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  // @ts-expect-error — putting jsdom back the way we found it
  delete window.matchMedia;
});

describe("useSettings", () => {
  it("falls back to dark when the browser cannot report a preference", () => {
    // jsdom has no matchMedia at all; the app's documented default is dark, so
    // "system" must never quietly downgrade a user who never picked.
    const { result } = renderHook(() => useSettings());
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("resolves 'system' from the OS when the browser can answer", () => {
    installMatchMedia(true); // prefers-color-scheme: light
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ theme: "system" }));
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("an explicit choice overrides the OS", () => {
    installMatchMedia(true); // OS says light
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ theme: "dark" }));
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("follows the OS flipping at sunset while the choice is 'system'", () => {
    const mm = installMatchMedia(false); // dark
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ theme: "system" }));
    expect(result.current.resolvedTheme).toBe("dark");
    act(() => mm.emit(true)); // OS flips to light, no user action
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("stops listening to the OS once the choice stops deferring to it", () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ theme: "system" }));
    expect(mm.listenerCount).toBe(1);
    act(() => result.current.update({ theme: "light" }));
    expect(mm.listenerCount).toBe(0);
  });

  it("unsubscribes on unmount", () => {
    const mm = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useSettings());
    act(() => result.current.update({ theme: "system" }));
    expect(mm.listenerCount).toBe(1);
    unmount();
    expect(mm.listenerCount).toBe(0);
  });

  it("writes the resolved theme onto <html data-theme>", () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ theme: "light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("persists to localStorage and reads it back on the next mount", () => {
    const { result, unmount } = renderHook(() => useSettings());
    act(() => result.current.update({ theme: "light" }));
    unmount();
    const { result: second } = renderHook(() => useSettings());
    expect(second.current.settings.theme).toBe("light");
  });

  it("merges a patch instead of replacing the whole settings object", () => {
    const { result } = renderHook(() => useSettings());
    const before = result.current.settings;
    act(() => result.current.update({ theme: "light" }));
    const after = result.current.settings;
    for (const k of Object.keys(before) as (keyof typeof before)[]) {
      if (k !== "theme") expect(after[k]).toEqual(before[k]);
    }
  });

  it("takes an updater function against the current settings", () => {
    const { result } = renderHook(() => useSettings());
    act(() => result.current.update({ theme: "light" }));
    act(() => result.current.update((p) => ({ theme: p.theme === "light" ? "dark" : "light" })));
    expect(result.current.settings.theme).toBe("dark");
  });

  it("keeps `update` stable across renders", () => {
    const { result, rerender } = renderHook(() => useSettings());
    const first = result.current.update;
    rerender();
    expect(result.current.update).toBe(first);
  });
});
