// Drive sign-in under the offline service worker, which the dev server never
// registers (so verify-drive-sync.mjs can't see it). Its navigation preload
// once made the browser send the sign-in callback TWICE — one copy connected,
// the other answered "failed" — so this checks the callback arrives exactly
// once, for the popup and for the full-page fallback.
//
// Needs a production build behind the mock API:
//   npm run dev:api                                  # mock Google/Drive on :8788
//   npm run build && npx vite preview --port 4173    # proxies /api to :8788
//   URL=http://localhost:4173/ node scripts/verify-drive-sw.mjs
import { chromium } from "playwright";
import { checker } from "./lib/harness.mjs";

const URL = process.env.URL ?? "http://localhost:4173/";
const { check, done } = checker();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

/** A page the service worker controls (installed on the first load, in charge from the reload). */
async function controlledPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(URL);
  await page.locator(".drive-btn").waitFor({ timeout: 30000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.locator(".drive-btn").waitFor({ timeout: 30000 });
  return { context, page };
}
const hits = (page, state) =>
  page.evaluate(
    async (s) => (await (await fetch(`/api/drive/mock/callback-hits?state=${encodeURIComponent(s)}`)).json()).hits,
    state,
  );

// --- popup ------------------------------------------------------------------
{
  const { context, page } = await controlledPage();
  check(
    "the page is controlled by the service worker",
    await page.evaluate(() => !!navigator.serviceWorker.controller),
  );
  await page.locator(".drive-btn").click();
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Connect Google Drive" }).click(),
  ]);
  await popup.locator("#mock-email").waitFor();
  const state = new globalThis.URL(popup.url()).searchParams.get("state") ?? "";
  await popup.locator("#mock-email").fill(`sw-popup-${Date.now()}@example.com`);
  await popup.locator("#mock-allow").click();
  await page
    .locator(".drive-btn--ok")
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  check("popup sign-in connects", await page.locator(".drive-btn--ok").isVisible());
  check(
    "…with its callback arriving exactly once",
    (await hits(page, state)) === 1,
    `${await hits(page, state)} hit(s)`,
  );
  await context.close();
}

// --- full-page fallback (popup blocked) -------------------------------------------
{
  const { context, page } = await controlledPage();
  await page.evaluate(() => location.assign("/api/drive/auth/start?mode=redirect&return=%2F"));
  await page.locator("#mock-email").waitFor({ timeout: 15000 });
  const state = new globalThis.URL(page.url()).searchParams.get("state") ?? "";
  await page.locator("#mock-email").fill(`sw-page-${Date.now()}@example.com`);
  await page.locator("#mock-allow").click();
  await page
    .locator(".drive-btn--ok")
    .waitFor({ timeout: 20000 })
    .catch(() => {});
  check("full-page sign-in comes back connected", await page.locator(".drive-btn--ok").isVisible());
  check(
    "…with its callback arriving exactly once",
    (await hits(page, state)) === 1,
    `${await hits(page, state)} hit(s)`,
  );
  await context.close();
}

await browser.close();
done();
