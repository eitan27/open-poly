// A chamfer's size must not be capped by how finely the wall is faceted.
//
// BRepFilletAPI has to propagate a chamfer's run-out onto whatever adjoins the
// edge's ends. Round walls here are polygons, so the run-out reaches a facet
// boundary as soon as the chamfer is wider than one facet chord, and OCCT fails.
// Measured on this fixture (96-gon, r=18, chord 2*18*sin(pi/96) = 1.178mm) the
// chamfer built at 1.17 and failed at 1.18; halving the facet count to 48 (chord
// 2.356) moved the cutoff to between 2 and 3. So the largest chamfer you could
// build WAS the facet chord — the rounder the wall, the smaller the chamfer.
//
// Chamfers on a straight edge between two perpendicular flat faces are now built
// as a boolean, which has no run-out to propagate, so faceting stops mattering.
// This sweeps well past the old ceiling and asserts every size builds.
import { chromium } from "playwright";
const URL = process.env.URL ?? "http://localhost:5175/";
const FILE = process.env.FILE ?? "scripts/fixtures/bc-chamfer-ceiling.openpoly.json";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await (await browser.newContext({ viewport: { width: 1660, height: 920 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
const warn = [];
page.on("console", (m) => {
  if (/^mesh:/.test(m.text())) warn.push(m.text().slice(0, 70));
});
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 250; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return s;
    await page.waitForTimeout(300);
  }
  return "TIMEOUT";
};
await waitIdle();
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);

// Import through the app's own JSON path.
for (const label of ["Open", "Documents"]) {
  const b = page.locator(`button:has-text("${label}")`).first();
  if (await b.count()) {
    await b.click();
    break;
  }
}
await page.waitForTimeout(600);
const accepts = await page.locator('input[type="file"]').evaluateAll((ns) => ns.map((n) => n.getAttribute("accept")));
await page
  .locator('input[type="file"]')
  .nth(accepts.findIndex((a) => (a ?? "").includes("json")))
  .setInputFiles(FILE);
await waitIdle();
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

const doc = await read({ read: "document" });
const cham = (doc.features ?? []).find((f) => f.type === "dressup");
const cylF = (doc.features ?? []).find((f) => f.type === "primitive");
const R = Number(cylF?.params?.radius ?? 18);
const chord = 2 * R * Math.sin(Math.PI / 96);
console.log(`cylinder r=${R}  96-gon facet chord = ${chord.toFixed(4)} mm`);
console.log(
  `chamfer edges (${cham.targets[0].edges.length}):`,
  JSON.stringify(
    cham.targets[0].edges.map((e) =>
      e
        .split("∩")
        .map((p) => p.split("/").pop())
        .join("∩"),
    ),
  ),
);

let failures = 0;
for (const size of ["0.5", "1", "1.17", "1.18", "1.5", "2", "3", "4"]) {
  warn.length = 0;
  const r = await apply({ op: "setParam", featureId: cham.id, name: "size", value: size });
  const st = await waitIdle();
  const sc = await read({ read: "sceneSummary" });
  const body = sc.bodies.find((b) => b.id === cham.targetId);
  const err = r.ok ? (r.featureErrors?.[cham.id] ?? null) : (r.error ?? "err");
  const ok = !err && /up to date/.test(st);
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"}: chamfer builds at ${size}mm` +
      ` (chord ${chord.toFixed(3)}, old ceiling)` +
      ` — faces=${body?.faces?.length}${err ? " " + String(err).slice(0, 56) : ""}` +
      `${warn.length ? " " + JSON.stringify(warn) : ""}`,
  );
}
// Build-and-look: a boolean chamfer could succeed and still be wrong (wedge on
// the wrong side, or protruding past the edge's ends), so render a big one.
import("node:fs").then(async (fs) => {
  await apply({ op: "setParam", featureId: cham.id, name: "size", value: process.env.SHOT_SIZE ?? "3" });
  await waitIdle();
  await apply({ op: "select", refs: [] });
  for (const eye of await page.locator(".tree-row.datum-row .row-icon").all()) await eye.click();
  await page.waitForTimeout(700);
  const img = await page.evaluate(() => window.__openpoly.screenshot("iso"));
  fs.writeFileSync(
    process.env.SHOT ?? "/tmp/chamfer.png",
    Buffer.from(String(img).replace(/^data:image\/\w+;base64,/, ""), "base64"),
  );
  console.log("screenshot:", process.env.SHOT ?? "/tmp/chamfer.png");
  console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
});
