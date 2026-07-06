// Throwaway verification of the FACE geometric fallback: an extrude whose
// profile face name (`…/+z#1`, a boolean split) disappears after an upstream
// edit un-splits the face → re-matched geometrically + amber warning, instead
// of silently extruding whatever face happened to be nearest.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
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

// Clean slate: drop whatever the persisted document has accumulated.
const doc0 = await read({ read: "document" });
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await waitIdle();

// Base plate + a full-width cutter that SPLITS the top face into two strips.
const a = await apply({ op: "addPrimitive", kind: "box", params: { width: 30, depth: 30, height: 10 } });
const b = await apply({ op: "addPrimitive", kind: "box", params: { width: 4, depth: 40, height: 10, z: 5 } });
const cut = await apply({ op: "boolean", kind: "subtract", operands: [a.createdId, b.createdId] });
check("plate with splitting slot built", a.ok && b.ok && cut.ok, JSON.stringify({ a: a.ok, b: b.ok, cut: cut.ok }));

let scene = await read({ read: "sceneSummary" });
let body = scene.bodies.find((x) => x.id === cut.createdId);
const split = body?.faces?.find((f) => f.includes("+z#1")) ?? body?.faces?.find((f) => f.includes("#1"));
check("top face split produced a #1 name", Boolean(split), JSON.stringify(body?.faces));

// Pad on the split strip — this stores faceName "+z#1" + fingerprint.
const pad = await apply({
  op: "addExtrude",
  profile: { bodyId: cut.createdId, faceName: split },
  distance: "3",
  mode: "add",
  targetId: cut.createdId,
});
check("pad on the split strip succeeds", pad.ok, JSON.stringify(pad).slice(0, 200));

// Upstream edit: slide the cutter so the notch reaches one side — the top face
// is no longer split, so "+z#1" ceases to exist.
const move = await apply({ op: "setParam", featureId: b.createdId, name: "y", value: "12" });
check("upstream edit applied", move.ok, JSON.stringify(move).slice(0, 300));
await waitIdle();

// The pad must have re-attached (no feature error) WITH a surfaced warning.
const doc1 = await read({ read: "document" });
const padErr = move.featureErrors?.[pad.createdId];
check("pad survived the upstream rename (no feature error)", !padErr, padErr ?? "");
const titles = await page.locator(".row-badge.warn").evaluateAll((els) => els.map((e) => e.title));
check(
  "timeline warns that the profile face was re-matched geometrically",
  titles.some((t) => /profile face .* re-matched geometrically/.test(t)),
  JSON.stringify(titles),
);
check("doc still has all features", doc1.features.length === 4, `features: ${doc1.features.length}`);

await page.screenshot({ path: "/tmp/openshape-naming-face.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
