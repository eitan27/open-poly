// Assemblies: the width mate. Two faces on each part (here the front and back
// of a base and of an arm): the first pick half-fills a slot, a face that isn't
// parallel is refused, and the arm ends up centred between the base's faces,
// the same way up. An offset slides it within the mid-plane; reload keeps it.
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
await rename("Width");
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

// The keys: I opens Insert, M opens the Mate dialog, W picks Width in it.
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("i");
await page.waitForTimeout(300);
check("I opens Insert", (await page.locator(".insert-doc").count()) > 0);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await page.keyboard.press("m");
await page.waitForTimeout(300);
check("M opens the Mate dialog", (await page.locator(".asm-mate").count()) === 1);
await page.keyboard.press("w");
await page.waitForTimeout(200);
check("…and W picks Width", (await page.locator(".asm-mate-type-btn .asm-mate-type-name").textContent()) === "Width");
check("Width asks for two faces", /two faces of the first part/.test(await page.locator(".asm-mate").textContent()));
// The dialog opens over the middle of the view, where the base is: move it aside.
{
  const t = await page.locator(".asm-mate .ed-title").boundingBox();
  await page.mouse.move(t.x + 20, t.y + 8);
  await page.mouse.down();
  await page.mouse.move(t.x - 600, t.y + 300, { steps: 8 });
  await page.mouse.up();
}
await view("2"); // front: both front faces face the camera
await clickWorld(apply4(T("Base"), baseFront));
const prompt = await page.locator(".asm-mate .ed-pick-btn.active").textContent();
check(
  "one face leaves the slot listening for the opposite one",
  prompt === `Select the opposite face of ${names[0]}`,
  prompt,
);
await view("3"); // right: the base's right side, not parallel to its front
// High on it, clear of the arm's edges beyond.
await clickWorld(apply4(T("Base"), [baseRight[0], baseRight[1] - 10, baseRight[2] + 3]));
check("a face that isn't parallel is refused", /parallel/.test(await warning()), await warning());
await view("4"); // back
await clickWorld(apply4(T("Base"), baseBack));
check("the opposite face completes it", (await labels())[0] === `${names[0]} · 2 faces`, (await labels()).join(" | "));
await clickWorld(apply4(T("Arm"), armBack));
await view("2");
await clickWorld(apply4(T("Arm"), armFront));
check(
  "two faces of the arm fill the second slot",
  (await labels())[1] === `${names[1]} · 2 faces`,
  (await labels()).join(" | "),
);
await view("7");
await page.screenshot({ path: "/tmp/asm-width-preview.png" });
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
const m = rec.assembly.mates[0];
check("Create saves a width mate", m?.type === "width" && m.name === "Width 1", JSON.stringify(m?.name));
check("…with both faces of each side", !!m?.a.ref2 && !!m?.b.ref2);
const mid = (t, p, q) =>
  apply4(
    t,
    p.map((v, i) => (v + q[i]) / 2),
  );
const baseMid = mid(T("Base"), baseFront, baseBack);
const armMid = mid(T("Arm"), armFront, armBack);
check(
  "the arm is centred between the base's front and back",
  Math.abs(armMid[1] - baseMid[1]) < 1e-3,
  `${armMid[1].toFixed(3)} vs ${baseMid[1].toFixed(3)}`,
);
const armT = T("Arm");
check(
  "…the same way up (not flipped over)",
  Math.abs(armT[10] - 1) < 1e-6,
  armT
    .slice(8, 11)
    .map((v) => v.toFixed(3))
    .join(","),
);

// An offset slides it within the mid-plane, keeping it centred.
await page.locator(".asm-mate-row").first().click();
await page.locator(".asm-mate-dof input").first().fill("25");
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
const armMid2 = mid(T("Arm"), armFront, armBack);
const slid = Math.hypot(armMid2[0] - armMid[0], armMid2[2] - armMid[2]);
check("an offset slides it 25 mm within the mid-plane", Math.abs(slid - 25) < 1e-3, slid.toFixed(3));
check("…still centred", Math.abs(armMid2[1] - baseMid[1]) < 1e-3);
await page.screenshot({ path: "/tmp/asm-width-offset.png" });

// The toolbar: a button per mate type, each opening the dialog on its type
// (or switching the open one).
await page.keyboard.press("Escape");
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("?");
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/asm-toolbar.png", clip: { x: 0, y: 0, width: 1660, height: 140 } });
await page.keyboard.press("?");
const tb = (label) => page.locator(".model-toolbar button", { hasText: label }).first();
await tb("Slider").click();
await page.waitForTimeout(300);
check(
  "the toolbar's Slider opens the Mate dialog on Slider",
  (await page.locator(".asm-mate-type-btn .asm-mate-type-name").textContent()) === "Slider",
);
await tb("Revolute").click();
await page.waitForTimeout(200);
check(
  "…and Revolute switches it",
  (await page.locator(".asm-mate").count()) === 1 &&
    (await page.locator(".asm-mate-type-btn .asm-mate-type-name").textContent()) === "Revolute",
);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("m");
await page.waitForTimeout(300);
check(
  "M reopens it on the last type used",
  (await page.locator(".asm-mate-type-btn .asm-mate-type-name").textContent()) === "Revolute",
);
await page.keyboard.press("Escape");

await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
await page.waitForTimeout(1000);
check("after reload the width mate is listed", (await page.locator(".asm-mate-row").count()) === 1);
check("…with no ⚠", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
