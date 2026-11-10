// Assemblies: the Move panel's numbers. Like a part's Transform panel it reads
// out the move live while the gizmo is dragged and takes typed values: a free
// part's Move X/Y/Z (mm) and Angle (°) count how far it has moved since it was
// selected, and typing one moves it to that; a part one mate positions shows
// that mate's values instead, live during a drag, and typing one sets it.
// NB if the local open-poly MCP hub is running, this headless tab connects to
// it and can take the bridge from your own tab; reload yours after.
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
/** Click `target` to switch documents, then wait for the switch to land: it
 *  comes a few hundred ms after the click, while the status still reads "up
 *  to date", so without this the next step acts on the previous document. */
const switchVia = async (target) => {
  const was = await page.locator(".doc-title").inputValue();
  await target.click();
  await page.waitForFunction((t) => document.querySelector(".doc-title")?.value !== t, was, { timeout: 10000 });
  await waitIdle();
};

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
/** Centre of the part's flat face whose normal's `axis` component is `nz`,
 *  in part coordinates. */
const faceCentre = (docName, nz, axis = 2) =>
  idb(
    `const [name, nz, axis] = arg;
     const m = recs.find((r) => r.name === name).meshes[0].mesh.faces;
     let best = null;
     for (const g of m.faceGroups) {
       let c = [0, 0, 0], k = 0, nzSum = 0;
       for (let t = g.start; t < g.start + g.count; t += 3) {
         const p = [0, 1, 2].map((j) => [0, 1, 2].map((q) => m.vertices[m.triangles[t + j] * 3 + q]));
         const u = p[1].map((v, q) => v - p[0][q]), w = p[2].map((v, q) => v - p[0][q]);
         const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
         const len = Math.hypot(...n);
         nzSum += n[axis] / len;
         // Area-weighted: a fan-triangulated disc's vertex average leans to the fan's hub.
         for (const v of p) for (let q = 0; q < 3; q++) c[q] += (v[q] * len) / 3;
         k += len;
       }
       const avg = nzSum / (g.count / 3);
       if (Math.abs(avg - nz) < 1e-3) best = c.map((v) => v / k);
     }
     return best;`,
    [docName, nz, axis],
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

const doc0 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await rename("Base");
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await waitIdle();
await switchVia(page.locator(".newdoc-btn"));
await rename("Arm");
await apply({ op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } });
await waitIdle();

await page.locator(".split-btn-caret").click();
await switchVia(page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }));
await rename("Moves");
await insertFrom("Base");
await insertFrom("Arm");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const baseFront = await faceCentre("Base", -1, 1);
const baseBack = await faceCentre("Base", 1, 1);
const baseRight = await faceCentre("Base", 1, 0);
const armFront = await faceCentre("Arm", -1, 1);
const armBack = await faceCentre("Arm", 1, 1);
let rec = await saved();
const T = (prefix) => instanceOf(rec, prefix).transform;
const names = rec.assembly.instances.map((i) => i.name);
const labels = () => page.locator(".asm-mate .bool-operand-name").allTextContents();
const warning = () =>
  page
    .locator(".asm-mate .ed-warning")
    .textContent({ timeout: 500 })
    .catch(() => "");

const field = (label) => page.locator(".asm-move .ed-field", { hasText: label }).locator("input");
const typeInto = async (label, text) => {
  await field(label).click();
  await field(label).fill(text);
  await field(label).press("Enter");
  await page.waitForTimeout(300);
};
const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
// The arm is a 30 × 8 × 4 box: its middle is 2 above its bottom face.
const armBottom = await faceCentre("Arm", -1, 2);
const armCentre = [armBottom[0], armBottom[1], armBottom[2] + 2];

// --- A free part: Move X/Y/Z, live while dragging -------------------------------
await page.locator(".asm-list > .asm-row").nth(1).click();
await page.waitForTimeout(300);
check("a free part's panel starts at zero", (await field("Move X").inputValue()) === "0");
const t0 = T("Arm");
const g = await toScreen(apply4(t0, armCentre));
await page.mouse.move(g.x, g.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(g.x + i * 9, g.y - i * 4, { steps: 2 });
const mid = await Promise.all(["Move X", "Move Y", "Move Z"].map((l) => field(l).inputValue()));
check(
  "mid-drag the panel shows the move",
  mid.some((v) => Number(v) !== 0),
  mid.join(", "),
);
await page.mouse.up();
rec = await saved();
const t1 = T("Arm");
const after = await Promise.all(["Move X", "Move Y", "Move Z"].map((l) => field(l).inputValue()));
check(
  "after the drag it reads what the part moved",
  [12, 13, 14].every((k, i) => near(t1[k] - t0[k], Number(after[i]))),
  `${after.join(", ")} vs ${[12, 13, 14].map((k) => (t1[k] - t0[k]).toFixed(3)).join(", ")}`,
);

// Typing a total moves it there.
await typeInto("Move X", "25");
rec = await saved();
const t2 = T("Arm");
check(
  "typing Move X = 25 puts it 25 from where it was selected",
  near(t2[12] - t0[12], 25),
  (t2[12] - t0[12]).toFixed(3),
);
check("…and the field says 25", (await field("Move X").inputValue()) === "25");
await typeInto("Move Z", "2 * 5");
rec = await saved();
check("an expression works too", near(T("Arm")[14] - t0[14], 10), (T("Arm")[14] - t0[14]).toFixed(3));
await field("Move Y").click();
await field("Move Y").fill("99");
await field("Move Y").press("Escape");
await page.waitForTimeout(300);
rec = await saved();
check("Escape abandons a typed value", near(T("Arm")[13], t2[13]));

// Rotate: an angle about Z.
await page.locator(".asm-move .ed-modes button", { hasText: "Rotate" }).click();
await page.waitForTimeout(200);
check("Rotate reads an angle from zero", (await field("Angle").inputValue()) === "0");
await typeInto("Angle", "90");
rec = await saved();
const r = T("Arm");
check(
  "typing 90° turns it a quarter turn about Z",
  near(r[0], 0, 1e-6) && near(Math.abs(r[1]), 1, 1e-6),
  r
    .slice(0, 3)
    .map((v) => v.toFixed(3))
    .join(","),
);
await page.screenshot({ path: "/tmp/asm-move-free.png" });

// --- A mated part: the mate's own value -----------------------------------------
await typeInto("Angle", "0");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
rec = await saved(); // where the arm is now, turned back
const baseTop = await faceCentre("Base", 1, 2);
await view("7");
await clickWorld(apply4(T("Base"), [baseTop[0] - 15, baseTop[1] - 15, baseTop[2]]));
await view("6");
await clickWorld(apply4(T("Arm"), [armBottom[0] + 10, armBottom[1], armBottom[2]]));
await view("7");
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("s");
await page.waitForTimeout(400);
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
check("a slider is made from the two pre-picked faces", rec.assembly.mates[0]?.type === "slider");
await page.keyboard.press("Escape");
await page.locator(".asm-list > .asm-row").nth(1).click();
await page.waitForTimeout(300);
check(
  "a slider's part shows the slider's distance",
  (await field("Distance").count()) === 1 && (await field("Move X").count()) === 0,
);
const z0 = apply4(T("Arm"), armBottom)[2];
await typeInto("Distance", "15");
rec = await saved();
check(
  "typing 15 sets the slider",
  rec.assembly.mates[0].values?.tz === "15",
  JSON.stringify(rec.assembly.mates[0].values),
);
check(
  "…and lifts the part 15",
  near(apply4(T("Arm"), armBottom)[2] - z0, 15),
  (apply4(T("Arm"), armBottom)[2] - z0).toFixed(3),
);
// By the gizmo's Z arrow, the slider's axis.
const pc = apply4(T("Arm"), armCentre);
const pcs = await toScreen(pc);
const c = { x: pcs.x, y: pcs.y - 70 }; // up the blue arrow, clear of the others
await page.mouse.move(c.x, c.y);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(c.x, c.y - i * 8, { steps: 2 });
const live = await field("Distance").inputValue();
check("mid-drag the distance updates live", Number(live) !== 15, live);
await page.mouse.up();
rec = await saved();
check(
  "…and lands on what was shown",
  rec.assembly.mates[0].values?.tz === (await field("Distance").inputValue()),
  `${rec.assembly.mates[0].values?.tz} vs ${await field("Distance").inputValue()}`,
);
await page.screenshot({ path: "/tmp/asm-move-mated.png" });

// --- Esc cancels the move session, as in a part's Transform ----------------------
await page.keyboard.press("Escape");
await page.locator(".asm-list > .asm-row").nth(1).click();
await page.waitForTimeout(300);
rec = await saved();
const tBefore = T("Arm");
const vBefore = JSON.stringify(rec.assembly.mates[0].values);
{
  const p = await toScreen(apply4(tBefore, armCentre));
  const s0 = { x: p.x, y: p.y - 70 };
  await page.mouse.move(s0.x, s0.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(s0.x, s0.y - i * 8, { steps: 2 });
  await page.mouse.up();
}
rec = await saved();
check(
  "a drag moved it",
  JSON.stringify(rec.assembly.mates[0].values) !== vBefore,
  JSON.stringify(rec.assembly.mates[0].values),
);
await page.keyboard.press("Escape");
rec = await saved();
check(
  "Esc puts the mate's values back",
  JSON.stringify(rec.assembly.mates[0].values) === vBefore,
  JSON.stringify(rec.assembly.mates[0].values),
);
check(
  "…and the part where it was",
  T("Arm").every((v, i) => near(v, tBefore[i])),
);
check("…and closes the panel", (await page.locator(".asm-move").count()) === 0);
// Done keeps a move instead.
await page.locator(".asm-list > .asm-row").nth(1).click();
await page.waitForTimeout(300);
await typeInto("Distance", "7");
await page.locator(".asm-move .ed-primary", { hasText: "Done" }).click();
rec = await saved();
check(
  "Done keeps the move and closes the panel",
  rec.assembly.mates[0].values?.tz === "7" && (await page.locator(".asm-move").count()) === 0,
  JSON.stringify(rec.assembly.mates[0].values),
);

// --- Two faces gathered for a mate: no Move panel --------------------------------
const baseTopFace = await faceCentre("Base", 1);
await clickWorld(apply4(T("Base"), [baseTopFace[0] + 15, baseTopFace[1] - 15, baseTopFace[2]]));
check("one face picked still shows its part's panel", (await page.locator(".asm-move").count()) === 1);
await clickWorld(apply4(T("Arm"), [armBottom[0], armBottom[1], armBottom[2] + 4]));
check("two faces gathered show no Move panel", (await page.locator(".asm-move").count()) === 0);
await page.keyboard.press("Escape");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
