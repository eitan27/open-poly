// The offline service worker, built by vite-plugin-pwa (injectManifest — see
// vite.config.ts) and registered from src/pwa.ts.
//
// Pages: network first. Online, every load fetches index.html from the network,
// exactly as it did before there was a worker, so a fresh visit always opens the
// latest deploy. Only when the network fails or takes longer than
// NAVIGATION_TIMEOUT_MS does it fall back to the precached copy. The network copy
// is deliberately NOT cached: it references the new build's hashed assets, which
// aren't cached until the new worker finishes installing, so a stored copy could
// open offline to an app with missing files. The fallback is always the active
// worker's own index.html, which matches the assets it precached.
//
// Everything else (the app bundle, the OCCT worker, both wasm modules, fonts) is
// precached and served from cache. Hashed files keep their URL across deploys
// unless their content changes, so an update downloads only what changed.
//
// A new worker takes over as soon as it has installed. That's safe because a page
// loads all of its code at startup — there are no lazily loaded chunks — so a
// running tab never asks the new worker for an old file. Open tabs are never
// reloaded: they show the "new version" banner (src/useVersionCheck.ts).
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";

const sw = self as unknown as ServiceWorkerGlobalScope;

const NAVIGATION_TIMEOUT_MS = 3000;

sw.addEventListener("install", () => void sw.skipWaiting());
sw.addEventListener("activate", (event) => {
  // Navigation preload starts the page request while the worker boots, so
  // network-first costs no more than a load without a worker.
  event.waitUntil(Promise.all([sw.registration.navigationPreload?.enable(), sw.clients.claim()]));
});

// Registered before precacheAndRoute, whose own listener would otherwise answer
// "/" from the precache first.
sw.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(networkFirst(event, url));
});

async function networkFirst(event: FetchEvent, url: URL): Promise<Response> {
  const network = (async () => ((await event.preloadResponse) as Response | undefined) ?? fetch(event.request))();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), NAVIGATION_TIMEOUT_MS),
  );
  try {
    const response = await Promise.race([network, timeout]);
    // A server error falls back too: the cached app beats an error page.
    if (response.status < 500) return response;
  } catch {
    // Offline, or too slow — use the cached copy.
  }
  // A precached file opened directly (third-party-licenses.txt) is itself;
  // anything else is the app.
  const cached = (url.pathname !== "/" && (await matchPrecache(url.pathname))) || (await matchPrecache("/index.html"));
  return cached ?? Response.error();
}

// Spelled `self.__WB_MANIFEST` exactly: the build finds that text and replaces it
// with the precache list.
precacheAndRoute((self as unknown as { __WB_MANIFEST: Parameters<typeof precacheAndRoute>[0] }).__WB_MANIFEST);
cleanupOutdatedCaches();
