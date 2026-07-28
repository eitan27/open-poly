import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  loadSettings,
  resolveTheme,
  saveSettings,
  systemTheme,
  watchSystemTheme,
  type ResolvedTheme,
  type Settings,
} from "./settings";

export interface SettingsStore {
  settings: Settings;
  /** Patch one or more fields. Persists and (for `theme`) repaints immediately.
   *  Takes a function when the new value depends on the old one, so callers
   *  captured in long-lived handlers (the global keydown listener) can toggle a
   *  setting without holding — and having to re-subscribe on — the current
   *  value. */
  update: (patch: Partial<Settings> | ((prev: Settings) => Partial<Settings>)) => void;
  /** What `settings.theme` currently means — "system" already folded in. */
  resolvedTheme: ResolvedTheme;
}

/** Owns user preferences for the app: reads them once at startup, keeps
 *  localStorage in sync, and keeps <html data-theme> matching the resolved
 *  theme (including tracking the OS when the choice is "system"). */
export function useSettings(): SettingsStore {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  // Tracked separately from `settings.theme` because it can change without any
  // user action — the OS flipping to dark at sunset while we're on "system".
  const [osTheme, setOsTheme] = useState<ResolvedTheme>(systemTheme);

  const resolvedTheme: ResolvedTheme = settings.theme === "system" ? osTheme : resolveTheme(settings.theme);

  // Paint before the browser does. useEffect would let one frame of the wrong
  // theme through on the very first mount (main.tsx also applies the stored
  // theme pre-render, so in practice this only matters for later changes).
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Only listen while the choice actually defers to the OS.
  useEffect(() => {
    if (settings.theme !== "system") return;
    setOsTheme(systemTheme());
    return watchSystemTheme(setOsTheme);
  }, [settings.theme]);

  const update = useCallback<SettingsStore["update"]>((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
      saveSettings(next);
      return next;
    });
  }, []);

  return { settings, update, resolvedTheme };
}
