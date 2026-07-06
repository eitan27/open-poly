// Throwaway verification for the topological-naming robustness work:
//  1. cylinder rim edges are now nameable (side face gets a name) → fillet works;
//  2. a dress-up whose stored edge name churned (#n suffix) is re-matched by
//     base name instead of hard-failing, and an amber ⚠ badge appears.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1660, height: 920 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });

// Wait for the app (and __openpoly) to be ready.
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- 1. Cylinder rim fillet (previously impossible: side face was unnamed) ---
const cyl = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 10, height: 20 } });
check("cylinder created", cyl.ok, JSON.stringify(cyl).slice(0, 200));
const cylId = cyl.createdId ?? cyl.id ?? (await read({ read: "document" })).features.at(-1).id;

let scene = await read({ read: "sceneSummary" });
const cylBody = scene.bodies.find((b) => b.id === cylId);
const rimEdges = (cylBody?.edges ?? []).filter((e) => e.includes("∩"));
check("cylinder rim edges are named", rimEdges.length >= 2, `edges: ${JSON.stringify(cylBody?.edges)}`);

const rim = rimEdges.find((e) => e.includes("+z")) ?? rimEdges[0];
const fil = await apply({ op: "dressUp", kind: "fillet", targetId: cylId, edges: [rim], size: "2" });
check("fillet on cylinder rim succeeds", fil.ok, JSON.stringify(fil).slice(0, 200));
await waitIdle();

// The agent path must bake a geometric fingerprint (mid + length) alongside
// the name, so the kernel's geometric fallback has something to match on.
const docAfterFillet = await read({ read: "document" });
const filFeature = docAfterFillet.features.find((f) => f.id === fil.createdId);
const ref = filFeature?.edgeRefs?.[0];
check(
  "agent dress-up stored an edge fingerprint",
  ref && ref.name === rim && Array.isArray(ref.mid) && ref.length > 50, // rim circumference ~63 mm
  JSON.stringify(filFeature?.edgeRefs),
);

// --- 2. Base-name fallback: a stored name with a stale #n suffix still resolves ---
scene = await read({ read: "sceneSummary" });
const body = scene.bodies.find((b) => b.id === cylId);
const bottomRim = (body?.edges ?? []).find((e) => e.includes("∩") && !e.includes("fillet"));
check("an un-filleted edge remains", Boolean(bottomRim), JSON.stringify(body?.edges));

// Corrupt the name the way boolean/dress-up churn does: append a #1 suffix.
const [a, b] = bottomRim.split("∩");
const stale = `${a}#1∩${b}`;
const ch = await apply({ op: "dressUp", kind: "chamfer", targetId: cylId, edges: [stale], size: "1" });
check("chamfer with churned (#1) edge name still succeeds", ch.ok, JSON.stringify(ch).slice(0, 200));
await waitIdle();

// The re-match must be SURFACED, not silent: amber ⚠ badge in the timeline.
const warnBadges = await page.locator(".row-badge.warn").count();
const warnTitle = warnBadges ? await page.locator(".row-badge.warn").first().getAttribute("title") : null;
check("timeline shows the amber re-match warning", warnBadges >= 1, `title: ${warnTitle}`);

// --- 3. A truly lost edge fails with a helpful error (not a wrong match) ---
const lost = await apply({ op: "dressUp", kind: "chamfer", targetId: cylId, edges: ["nope/xx∩nope/yy"], size: "1" });
check(
  "bogus edge name errors descriptively",
  !lost.ok && /re-found|re-pick/.test(JSON.stringify(lost)),
  JSON.stringify(lost).slice(0, 250),
);

await page.screenshot({ path: "/tmp/openshape-naming.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openshape-naming.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
