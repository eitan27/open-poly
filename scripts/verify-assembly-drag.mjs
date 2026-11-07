// Assemblies: dragging mated parts. A planar mate holds the arm on the base:
// pushing the arm off the plane moves nothing (and leaves nothing behind once
// let go), and turning or lifting the base carries the arm with it during the
// drag, not only after it. NB if the local open-poly MCP hub is running, this headless tab
// connects to it and can take the bridge from your own tab; reload yours after.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const context = await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 120; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
await page.waitForFunction(() => window.__openpoly);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const rename = async (name) => {
  await page.locator(".doc-title").click();
  await page.locator(".doc-title").fill(name);
  await page.locator(".doc-title").press("Enter");
};
const idb = (fn, arg) =>
  page.evaluate(
    ([src, a]) =>
      new Promise((resolve) => {
        const req = indexedDB.open("open-poly");
        req.onsuccess = () => {
          req.result.transaction("documents").objectStore("documents").getAll().onsuccess = (e) =>
            resolve(new Function("recs", "arg", src)(e.target.result, a));
        };
      }),
    [fn, arg],
  );
/** The open assembly's saved record (after the autosave debounce). */
const saved = async () => {
  await page.waitForTimeout(900);
  const id = await page.evaluate(() => localStorage.getItem("openpoly.activeDocId"));
  return idb("return recs.find((r) => r.id === arg)", id);
};
/** Centre of the part's flat face facing `n` (±z), in part coordinates. */
const faceCentre = (docName, nz) =>
  idb(
    `const [name, nz] = arg;
     const m = recs.find((r) => r.name === name).meshes[0].mesh.faces;
     let best = null;
     for (const g of m.faceGroups) {
       let c = [0, 0, 0], k = 0, nzSum = 0;
       for (let t = g.start; t < g.start + g.count; t += 3) {
         const p = [0, 1, 2].map((j) => [0, 1, 2].map((q) => m.vertices[m.triangles[t + j] * 3 + q]));
         const u = p[1].map((v, q) => v - p[0][q]), w = p[2].map((v, q) => v - p[0][q]);
         const cz = u[0] * w[1] - u[1] * w[0], len = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], cz);
         nzSum += cz / len;
         // Area-weighted: a fan-triangulated disc's vertex average leans to the fan's hub.
         for (const v of p) for (let q = 0; q < 3; q++) c[q] += (v[q] * len) / 3;
         k += len;
       }
       const avg = nzSum / (g.count / 3);
       if (Math.abs(avg - nz) < 1e-3) best = c.map((v) => v / k);
     }
     return best;`,
    [docName, nz],
  );
const apply4 = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const toScreen = async (p) => {
  const box = await page.locator(".viewport canvas").first().boundingBox();
  const s = await page.evaluate((q) => window.__openpoly.worldToScreen(q), p);
  return { x: box.x + s.x, y: box.y + s.y };
};
const clickWorld = async (p) => {
  const s = await toScreen(p);
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(300);
};
const insertFrom = async (docName) => {
  await page.locator(".asm-insert").click();
  await page.locator(".insert-doc", { hasText: docName }).click();
  await page.locator(".insert-confirm").waitFor({ timeout: 30000 });
  await page.locator(".insert-confirm").click();
  await page.waitForTimeout(400);
};
// Instances are named after their parts ("Box 1 <2>"), so tests find them by
// the order they were inserted in.
const ORDER = { Base: 0, Arm: 1 };
const instanceOf = (rec, doc) => rec.assembly.instances[ORDER[doc]];
const view = async (key) => {
  await page
    .locator(".viewport canvas")
    .first()
    .hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
};

const S = "/private/tmp/claude-501/-Users-eitan-Developer-open-shape/845ccf82-68f1-42f8-abbd-b6ddc86732d0/scratchpad";
const doc0 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await rename("Base");
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await waitIdle();
await page.locator(".newdoc-btn").click();
await waitIdle();
await rename("Arm");
await apply({ op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } });
await waitIdle();

await page.locator(".split-btn-caret").click();
await page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }).click();
await waitIdle();
await rename("Drag");
await insertFrom("Base");
await insertFrom("Arm");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const baseTop = await faceCentre("Base", 1);
const armBottom = await faceCentre("Arm", -1);
let rec = await saved();
const T = (prefix) => instanceOf(rec, prefix).transform;

await page.locator(".asm-new-mate").click();
await page.locator(".asm-mate-types button", { hasText: "Planar" }).click();
// The dialog opens over the middle of the view, where the base is: move it aside.
{
  const t = await page.locator(".asm-mate .ed-title").boundingBox();
  await page.mouse.move(t.x + 20, t.y + 8);
  await page.mouse.down();
  await page.mouse.move(t.x - 600, t.y + 300, { steps: 8 });
  await page.mouse.up();
}
await clickWorld(apply4(T("Base"), [baseTop[0] + 12, baseTop[1] - 12, baseTop[2]]));
await view("6");
await clickWorld(apply4(T("Arm"), armBottom));
await view("7");
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
const arm0 = T("Arm");
check("a planar mate sets the arm on the base", Math.abs(apply4(arm0, armBottom)[2] - baseTop[2]) < 1e-3);

/** Drag the selected instance's gizmo from world point `p` by screen steps. */
const drag = async (p, dx, dy, shot) => {
  const g = await toScreen(p);
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(g.x + (i * dx) / 10, g.y + (i * dy) / 10, { steps: 2 });
  await page.waitForTimeout(200);
  if (shot) await page.screenshot({ path: `${S}/${shot}` });
  await page.mouse.up();
  await page.waitForTimeout(300);
};
const centreOf = (t, lo, hi) =>
  apply4(
    t,
    lo.map((v, i) => (v + hi[i]) / 2),
  );

// Push the arm straight up the screen: off its plane, which the mate forbids.
await page.locator(".asm-row").nth(1).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${S}/drag-0.png` });
const armMid = apply4(arm0, [armBottom[0], armBottom[1], armBottom[2] + 2]);
await drag(armMid, 0, -120, "drag-arm-mid.png");
await page.screenshot({ path: `${S}/drag-arm-after.png` });
rec = await saved();
const arm1 = T("Arm");
check(
  "the arm can't leave the base's plane",
  Math.abs(apply4(arm1, armBottom)[2] - baseTop[2]) < 1e-3,
  apply4(arm1, armBottom)
    .map((v) => v.toFixed(2))
    .join(","),
);

// Lift the base straight up the screen: the arm rides along mid-drag.
await page.locator(".asm-row").nth(0).click();
await page.waitForTimeout(300);
await page.locator(".asm-move button", { hasText: "Unground" }).click();
await page.waitForTimeout(300);
rec = await saved();
const base0 = T("Base");
await drag(apply4(base0, [baseTop[0], baseTop[1], baseTop[2] - 5]), 0, -100, "drag-base-mid.png");
await page.screenshot({ path: `${S}/drag-base-after.png` });
rec = await saved();
const lift = T("Base")[14] - base0[14];
check("dragging the base moves it", Math.abs(lift) > 1, `dz = ${lift.toFixed(2)}`);
check("…and the arm stays on it", Math.abs(apply4(T("Arm"), armBottom)[2] - apply4(T("Base"), baseTop)[2]) < 1e-3);

// Turn the base about Z with the rotate ring: the arm turns with it.
await page.locator(".asm-move .ed-modes button", { hasText: "Rotate" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${S}/drag-rotate-0.png` });
// The arm's corner as seen from the base, before and after: it should not change.
const armInBase = () => {
  const b = T("Base");
  const w = apply4(T("Arm"), [armBottom[0] + 15, armBottom[1] + 4, armBottom[2]]).map((v, i) => v - b[12 + i]);
  // Undo the base's rotation (its columns are orthonormal).
  return [0, 1, 2].map((c) => b[c * 4] * w[0] + b[c * 4 + 1] * w[1] + b[c * 4 + 2] * w[2]);
};
const rel0 = armInBase();
{
  // The ring's near edge, below the gizmo's centre on screen (found from a
  // screenshot of this view); drag it sideways.
  const c = await toScreen(apply4(T("Base"), [baseTop[0], baseTop[1], baseTop[2] - 5]));
  const [rx, ry, dx, dy] = [c.x, c.y + 45, 90, -20];
  await page.mouse.move(rx, ry);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(rx + (i * dx) / 10, ry + (i * dy) / 10, { steps: 2 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${S}/drag-rotate-mid.png` });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${S}/drag-rotate-after.png` });
  rec = await saved();
  const b = T("Base");
  const turned = (Math.atan2(b[1], b[0]) * 180) / Math.PI;
  check("dragging the ring turns the base", Math.abs(turned) > 2, `${turned.toFixed(1)}°`);
  const rel1 = armInBase();
  check(
    "…and the arm turns with it",
    rel1.every((v, i) => Math.abs(v - rel0[i]) < 1e-3),
    `${rel0.map((v) => v.toFixed(2))} → ${rel1.map((v) => v.toFixed(2))}`,
  );
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
