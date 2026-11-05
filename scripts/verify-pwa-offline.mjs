// The app opens and models with no connection after one online visit, and a new
// deploy reaches an installed service worker through the update banner.
//
// Needs a PRODUCTION build — the dev server registers no service worker, and the
// dev-only window.__openpoly bridge is absent, so this drives the real UI:
//
//   npm run build && npx vite preview --port 4173 &
//   URL=http://localhost:4173/ node scripts/verify-pwa-offline.mjs
//
// With REBUILD=1 it also checks the update path: it rebuilds dist/ (a new build
// id) with two tabs open, then expects a freshly opened tab to load the new build
// directly (pages are network-first), an open tab to show the banner and reload
// onto it, the other open tab to be left alone, and the new build to be what
// opens offline afterwards. Runs `npm run build` itself, so don't run it
// alongside anything else.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { checker } from "./lib/harness.mjs";

const URL = process.env.URL ?? "http://localhost:4173/";
const { check, done } = checker();

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

const status = (p = page) =>
  p
    .locator(".status")
    .textContent()
    .then((s) => s?.trim() ?? "");
async function waitIdle(p = page) {
  let run = 0;
  for (let i = 0; i < 200; i++) {
    run = /up to date|error|fail/i.test(await status(p)) ? run + 1 : 0;
    if (run >= 3) return status(p);
    await p.waitForTimeout(300);
  }
  return "TIMEOUT";
}
const parts = () => page.locator(".solid-name").count();
const bundle = (p = page) => p.evaluate(() => document.querySelector('script[type="module"]')?.getAttribute("src"));

// 1. First visit, online: the worker installs and precaches.
await page.goto(URL);
check("first visit builds the seed part online", /up to date/i.test(await waitIdle()));
const active = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.ready;
  for (let i = 0; i < 100 && !r.active; i++) await new Promise((res) => setTimeout(res, 100));
  return r.active?.state ?? null;
});
check("a service worker is active after the first visit", active === "activated", String(active));
const cached = await page.evaluate(async () => {
  const names = await caches.keys();
  let n = 0,
    wasm = 0;
  for (const name of names) {
    const keys = await (await caches.open(name)).keys();
    n += keys.length;
    wasm += keys.filter((k) => k.url.endsWith(".wasm")).length;
  }
  return { n, wasm };
});
check("both wasm modules are precached", cached.wasm === 2, JSON.stringify(cached));

// 2. Offline: a reload still opens the app, and the kernel still builds geometry.
await context.setOffline(true);
check(
  "the network is really gone",
  await page.evaluate(() =>
    fetch("/robots.txt").then(
      () => false,
      () => true,
    ),
  ),
);
await page.reload();
check("offline reload opens the app", /up to date/i.test(await waitIdle()), await status());
check("offline: the stored part is rebuilt by the kernel", (await parts()) >= 1, `${await parts()} part(s)`);

// A brand-new document with a fresh primitive proves OCCT runs offline, not just
// that a cached picture came back.
await page.locator(".newdoc-btn").click();
await waitIdle();
const before = await parts();
await page.locator('.model-toolbar button[title^="New Body"]:visible').first().click();
await page.waitForTimeout(300);
await page.locator("button:visible", { hasText: /^Box$/ }).first().click();
await waitIdle();
check("offline: a new box builds in a new document", (await parts()) > before, `${before} → ${await parts()}`);

const solverWasm = await page.evaluate(async () => {
  const url = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .find((n) => n.includes("planegcs"));
  const src = url ?? [...document.scripts].map((s) => s.src).find(Boolean);
  if (!url) {
    // Not loaded yet this session — ask the cache for it directly.
    for (const name of await caches.keys()) {
      const hit = (await (await caches.open(name)).keys()).find((k) => k.url.includes("planegcs"));
      if (hit) return (await fetch(hit.url)).ok;
    }
    return `none (${src})`;
  }
  return (await fetch(url)).ok;
});
check("offline: the sketch solver's wasm is served", solverWasm === true, String(solverWasm));
console.log(`persistent storage granted: ${await page.evaluate(() => navigator.storage.persisted())}`);
await context.setOffline(false);

// 3. Update path, with a second tab open the whole time.
if (process.env.REBUILD) {
  await page.reload();
  await waitIdle();
  const oldBundle = await bundle();
  const other = await context.newPage();
  await other.goto(URL);
  await waitIdle(other);
  let otherReloaded = false;
  other.on("load", () => (otherReloaded = true));

  execSync("npm run build", { stdio: "ignore" });

  // A tab opened after the deploy gets the new build straight away, no banner.
  const fresh = await context.newPage();
  await fresh.goto(URL);
  await waitIdle(fresh);
  const newBundle = await bundle(fresh);
  check("a fresh tab opens the new build directly", newBundle !== oldBundle, `${oldBundle} → ${newBundle}`);
  await fresh.waitForTimeout(3000);
  check("…with no banner", (await fresh.locator(".update-banner").count()) === 0);

  // A tab that was open shows the banner, and Refresh lands on the new build.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const banner = page.locator(".update-banner");
  await banner.waitFor({ timeout: 30000 }).catch(() => {});
  check("an open tab shows the update banner", (await banner.count()) === 1);
  if (await banner.count()) {
    await Promise.all([page.waitForEvent("load", { timeout: 30000 }), banner.locator("button").click()]);
    await waitIdle();
    check("Refresh loads the new bundle", (await bundle()) === newBundle, `${oldBundle} → ${await bundle()}`);
    check("no banner after updating", (await page.locator(".update-banner").count()) === 0);
  }
  check("the other open tab was not reloaded", !otherReloaded);

  // The new worker takes over once installed, so offline now opens the new build.
  const cachedNew = await page.evaluate(async (src) => {
    for (let i = 0; i < 100; i++) {
      for (const name of await caches.keys())
        if (await (await caches.open(name)).match(new URL(src, location.href).href)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }, newBundle);
  check("the new build is cached by the new worker", cachedNew);
  await context.setOffline(true);
  await fresh.reload();
  await waitIdle(fresh);
  check(
    "offline after the update opens the new build",
    (await bundle(fresh)) === newBundle,
    String(await bundle(fresh)),
  );
  await context.setOffline(false);
}

await browser.close();
done();
