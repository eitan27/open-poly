import { useEffect, useState } from "react";

// How often to poll the deployed version.json while the tab is open+visible.
const POLL_MS = 2 * 60 * 1000;

/** Reports `true` once a newer build than the running one has been deployed, so
 *  the app can show a "refresh to update" banner. It polls `/version.json` (a
 *  tiny, un-hashed file emitted by the build — see vite.config.ts) and compares
 *  its `version` to the id baked into this bundle. Checks run on an interval and
 *  whenever the tab regains focus/visibility, so a long-idle tab notices the
 *  next time it's looked at. Production only — the dev server emits no
 *  version.json, and there's nothing to refresh to. */
export function useUpdateAvailable(): boolean {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const current = __BUILD_ID__;
    let active = true;

    const check = async () => {
      // Skip while hidden (saves needless requests) and once we've already found
      // an update (nothing changes by re-checking).
      if (!active || stale || document.hidden) return;
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const { version } = (await res.json()) as { version?: string };
        if (active && version && version !== current) setStale(true);
      } catch {
        // Offline or a transient failure — ignore and try again next tick.
      }
    };

    const interval = setInterval(check, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    check();

    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [stale]);

  return stale;
}
