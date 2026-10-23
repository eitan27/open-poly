// Offline support. A service worker (src/sw.ts, built by vite-plugin-pwa — see
// vite.config.ts) precaches the app shell, the OCCT and planegcs wasm, and the
// fonts, so openpoly.dev opens with no connection once it has been visited.
// Documents already live in IndexedDB, so nothing else needs the network.
//
// Online, pages still load from the network, so a fresh visit always gets the
// latest deploy and the "new version" banner works exactly as it did before the
// worker: Refresh is a plain reload. See src/sw.ts for why.

let registration: ServiceWorkerRegistration | undefined;

export function startServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("/sw.js")
    .then((r) => (registration = r))
    .catch(() => {
      // No worker (private mode, a browser setting) — the app still works online.
    });
}

/** Ask the browser to fetch the new worker now, rather than at its next own
 *  check, so the new build is cached for offline use without waiting. */
export function checkForServiceWorkerUpdate(): void {
  registration?.update().catch(() => {
    // Offline — the next check will try again.
  });
}

/** Ask the browser not to evict the app's storage (IndexedDB documents and the
 *  offline cache) under storage pressure — Safari otherwise clears a site's data
 *  after seven days without a visit. Chrome and Edge decide silently; Firefox
 *  would show a permission prompt on first visit, so it's skipped there. */
export function requestPersistentStorage(): void {
  if (!import.meta.env.PROD || /firefox/i.test(navigator.userAgent)) return;
  navigator.storage
    ?.persisted?.()
    .then((already) => already || navigator.storage.persist())
    .catch(() => {});
}
