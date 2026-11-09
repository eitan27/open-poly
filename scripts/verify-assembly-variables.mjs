// Assemblies: variables. The part document's Variables panel, reused: it
// starts collapsed in an assembly, adds and edits variables the same way, and
// a mate's value can name one, so changing the variable moves the part. Typing
// in it doesn't fire the assembly's shortcuts. Reload keeps it all.
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
await page.locator(".newdoc-btn").click();
await waitIdle();
await rename("Arm");
await apply({ op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } });
await waitIdle();

await page.locator(".split-btn-caret").click();
await page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }).click();
await waitIdle();
await rename("Vars");
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

const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
const heading = page.locator(".panel .params-heading", { hasText: "Variables" });
const rows = page.locator(".panel .var-row");

// --- Collapsed by default ----------------------------------------------------------
check("an assembly has a Variables section", (await heading.count()) === 1);
check("…collapsed by default", (await heading.getAttribute("aria-expanded")) === "false" && (await rows.count()) === 0);
await heading.click();
check("…and opens on a click", (await heading.getAttribute("aria-expanded")) === "true");

// --- Add one, the part document's way ------------------------------------------------
await page.locator(".panel .var-add").click();
await page.waitForTimeout(200);
check("+ Variable adds a row", (await rows.count()) === 1);
const nameBox = rows.first().locator(".var-name");
const exprBox = rows.first().locator(".var-expr");
await nameBox.fill("");
await nameBox.pressSequentially("lift"); // i and f are assembly shortcuts
await exprBox.fill("");
await exprBox.pressSequentially("10 + 5");
await page.waitForTimeout(300);
check(
  "typing a name doesn't fire shortcuts",
  (await page.locator(".insert-doc").count()) === 0 && (await page.locator(".asm-mate").count()) === 0,
);
check("its value shows beside it", (await rows.first().locator(".var-value").textContent()) === "15");
check("the heading counts it", /Variables \(1\)/.test(await heading.textContent()));
rec = await saved();
check(
  "it's saved with the assembly",
  rec.assembly.variables?.[0]?.name === "lift" && rec.assembly.variables[0].expression === "10 + 5",
);

// Leave the field before using the view's keys, as a person would by clicking
// away: in a field, keys type rather than act.
await exprBox.blur();

// --- A mate value names it ---------------------------------------------------------
const baseTop = await faceCentre("Base", 1, 2);
const armBottom = await faceCentre("Arm", -1, 2);
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
const dist = page.locator(".asm-mate .asm-mate-dof input").first();
await dist.fill("lift");
await page.waitForTimeout(300);
check(
  "a mate value can name the variable",
  !(
    (await page
      .locator(".asm-mate .ed-warning")
      .textContent({ timeout: 300 })
      .catch(() => "")) ?? ""
  ).length,
);
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
const z0 = apply4(T("Base"), baseTop)[2];
check(
  "…and the part sits at its value",
  near(apply4(T("Arm"), armBottom)[2] - z0, 15),
  (apply4(T("Arm"), armBottom)[2] - z0).toFixed(3),
);

// Change the variable: the part follows.
await exprBox.fill("25");
await exprBox.blur();
await page.waitForTimeout(300);
rec = await saved();
check(
  "changing the variable moves the part",
  near(apply4(T("Arm"), armBottom)[2] - z0, 25),
  (apply4(T("Arm"), armBottom)[2] - z0).toFixed(3),
);
check("no ⚠ on the mate", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);

// A name the mate uses, gone: the mate says so.
await nameBox.fill("lifted");
await page.waitForTimeout(300);
check("renaming it away flags the mate", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 1);
await nameBox.fill("lift");
await page.waitForTimeout(300);
check("…and naming it back clears it", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);
await page.screenshot({ path: "/tmp/asm-variables.png" });

// --- Reload ------------------------------------------------------------------------
await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
await page.waitForTimeout(1000);
check("after reload it's collapsed again", (await heading.getAttribute("aria-expanded")) === "false");
await heading.click();
check(
  "…and still holds lift = 25",
  (await rows.first().locator(".var-name").inputValue()) === "lift" &&
    (await rows.first().locator(".var-expr").inputValue()) === "25",
);
rec = await saved();
check(
  "…with the part still at 25",
  near(apply4(T("Arm"), armBottom)[2] - z0, 25),
  (apply4(T("Arm"), armBottom)[2] - z0).toFixed(3),
);

// The placement a variable leads to is kept like any mate edit's: deleting the
// mate leaves the part where the variable had put it.
await page.locator(".asm-mate-row").first().locator(".row-icon").click();
rec = await saved();
check(
  "deleting the mate leaves the part where the variable put it",
  rec.assembly.mates.length === 0 && near(apply4(T("Arm"), armBottom)[2] - z0, 25),
  (apply4(T("Arm"), armBottom)[2] - z0).toFixed(3),
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
