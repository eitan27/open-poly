// Shared scaffolding for the verify-*.mjs scripts.
//
// Sixty-five of these scripts each re-declared the same launch / waitIdle /
// apply / read / check block, and they had drifted: the poll loop ran anywhere
// from 60 to 300 iterations at 200ms or 300ms, and — the one difference that is
// not cosmetic — about a third treated "error" as NOT settled. Those scripts
// spin the entire timeout on a failed regen and then carry on against a state
// they never actually waited for, which reads as a slow, flaky script rather
// than the failure it is.
//
// This settles on error and RETURNS the status text, so a caller that wants to
// assert "no error" asserts it, and a caller that expects one gets there in
// milliseconds instead of half a minute.
//
// Usage:
//   import { launch, openPoly, checker } from "./lib/harness.mjs";
//   const { page, browser, close } = await launch();
//   const op = openPoly(page);
//   const { check, done } = checker();
//   await op.newDocument();
//   check("a box builds", (await op.bodyCount()) === 1);
//   await close();
//   done();            // prints the tally and exits non-zero on failure

import { chromium } from "playwright";

export const DEFAULT_URL = process.env.URL ?? "http://localhost:5173/";

/** Launch a browser on the app and wait for the agent bridge to exist.
 *  `errors` collects page errors and console errors for the whole run. */
export async function launch({
  url = DEFAULT_URL,
  width = 1660,
  height = 920,
  deviceScaleFactor = 1,
  collectErrors = true,
} = {}) {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
  const page = await context.newPage();
  const errors = [];
  if (collectErrors) {
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(`[console] ${m.text()}`));
  } else {
    page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
  return { browser, context, page, errors, close: () => browser.close() };
}

/** The app's agent bridge, plus the waits every script needs. */
export function openPoly(page) {
  /** Wait for the status chip to read a STABLE terminal state, and return it.
   *  "Stable" = the same terminal reading three polls running, which is what
   *  keeps StrictMode's remount-regen from being mistaken for the real one. */
  const waitIdle = async ({ iterations = 250, intervalMs = 300, stable = 3 } = {}) => {
    let run = 0;
    for (let i = 0; i < iterations; i++) {
      const s = (await page.locator(".status").textContent())?.trim() ?? "";
      run = /up to date|error|fail/i.test(s) ? run + 1 : 0;
      if (run >= stable) return s;
      await page.waitForTimeout(intervalMs);
    }
    return "TIMEOUT";
  };

  /** waitIdle, a beat, then waitIdle again — for the flows that kick off a
   *  SECOND regen once the first lands (a derived feature, a re-solve). */
  const settle = async (opts) => {
    await waitIdle(opts);
    await page.waitForTimeout(350);
    return waitIdle(opts);
  };

  const apply = (op) => page.evaluate((x) => window.__openpoly.apply(x), op);
  const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
  const scene = () => read({ read: "sceneSummary" });
  const doc = () => read({ read: "document" });
  const selection = () => read({ read: "selection" });

  return {
    page,
    waitIdle,
    settle,
    apply,
    read,
    scene,
    doc,
    selection,
    /** Feature list of the current document. */
    features: async () => (await doc()).features ?? [],
    /** Any feature the kernel flagged, as "<type>: <error>" strings. */
    featureErrors: async () => (await doc()).features?.filter((f) => f.error).map((f) => `${f.type}: ${f.error}`) ?? [],
    bodies: async () => (await scene()).bodies ?? [],
    bodyCount: async () => ((await scene()).bodies ?? []).length,
    newDocument: async (opts) => {
      const r = await apply({ op: "newDocument" });
      await settle(opts);
      return r;
    },
    /** Apply an op and wait for the regen it triggers. Returns the op result. */
    applySettled: async (op, opts) => {
      const r = await apply(op);
      await settle(opts);
      return r;
    },
    /** Canvas-relative screen point for a world coordinate — for real clicks. */
    screenOf: async (world) => {
      const box = await page.locator("canvas").first().boundingBox();
      const p = await page.evaluate((q) => window.__openpoly.worldToScreen(q), world);
      return { x: box.x + p.x, y: box.y + p.y };
    },
    clickWorld: async (world, pauseMs = 500) => {
      const p = await (async () => {
        const box = await page.locator("canvas").first().boundingBox();
        const s = await page.evaluate((q) => window.__openpoly.worldToScreen(q), world);
        return { x: box.x + s.x, y: box.y + s.y };
      })();
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(pauseMs);
      return p;
    },
  };
}

/** PASS/FAIL tally. `done()` prints the summary and exits non-zero on failure. */
export function checker() {
  let failures = 0;
  const check = (label, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
    return ok;
  };
  return {
    check,
    get failures() {
      return failures;
    },
    done(extra = "") {
      console.log(`\n${failures ? `${failures} FAILURE(S)` : "all checks passed"}${extra ? ` — ${extra}` : ""}`);
      process.exit(failures ? 1 : 0);
    },
  };
}
