// Assemblies: relations. Two arms hinged on a base by revolute mates; a gear
// relation (ratio 2) made in the Relation dialog turns the second when the
// first's angle is typed, and typing the second's angle turns the first (it
// drives it through the relation). The relation is listed, saved, and goes
// with its mate. Animating the first mate turns both. The suppress toggles
// leave a relation or mate out, keeping it and the parts where they are. NB if the local open-poly MCP hub is running, this headless tab
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
// Instances are named after their parts, so tests find them by insert order.
const ORDER = { Base: 0, Arm: 1, Arm2: 2 };
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
await apply({ op: "addPrimitive", kind: "box", params: { width: "80", depth: "40", height: "10" } });
await waitIdle();
await switchVia(page.locator(".newdoc-btn"));
await rename("Arm");
await apply({ op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } });
await waitIdle();

await page.locator(".split-btn-caret").click();
await switchVia(page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }));
await rename("Gears");
await insertFrom("Base");
await insertFrom("Arm");
await insertFrom("Arm");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const baseTop = await faceCentre("Base", 1);
const armBottom = await faceCentre("Arm", -1);
let rec = await saved();
const T = (prefix) => instanceOf(rec, prefix).transform;

/** A revolute from the base's top at (dx, dy) off its centre to `arm`'s bottom. */
const hingeAt = async (dx, dy, arm) => {
  await page.locator(".asm-new-mate").click();
  await page.locator(".asm-mate-type-btn").click();
  await page.locator(".asm-mate-types button", { hasText: "Revolute" }).click();
  const t = await page.locator(".asm-mate .ed-title").boundingBox();
  await page.mouse.move(t.x + 20, t.y + 8);
  await page.mouse.down();
  await page.mouse.move(t.x - 600, t.y + 300, { steps: 8 });
  await page.mouse.up();
  await clickWorld(apply4(T("Base"), [baseTop[0] + dx, baseTop[1] + dy, baseTop[2]]));
  await view("6");
  await clickWorld(apply4(T(arm), armBottom));
  await view("7");
  await page.locator(".asm-mate .ed-primary").click();
  rec = await saved();
};
await hingeAt(-20, 0, "Arm");
await hingeAt(20, 0, "Arm2");
check("two revolute mates", rec.assembly.mates.length === 2 && rec.assembly.mates.every((m) => m.type === "revolute"));
const [m1, m2] = rec.assembly.mates;

// --- The Relation dialog ----------------------------------------------------
await page.locator(".asm-new-relation").click();
await page.locator(".asm-relation").waitFor();
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/relation-dialog.png` });
check(
  "＋ Relation opens on a gear between the two mates",
  (await page.locator(".asm-relation .ed-modes button.active").textContent()).trim() === "Gear" &&
    (await page.locator(".asm-relation-driver").inputValue()) === `${m1.id}:rz` &&
    (await page.locator(".asm-relation-driven").inputValue()) === `${m2.id}:rz`,
);
await page.locator(".asm-relation-value").fill("0");
await page.waitForTimeout(200);
check("a zero ratio is refused", await page.locator(".asm-relation .ed-primary").isDisabled());
await page.locator(".asm-relation-value").fill("2");
await page.waitForTimeout(200);
await page.locator(".asm-relation .ed-primary").click();
rec = await saved();
check(
  "Add saves the relation",
  rec.assembly.relations?.length === 1 &&
    rec.assembly.relations[0].type === "gear" &&
    rec.assembly.relations[0].value === "2",
);
check(
  "…and lists it",
  (await page.locator(".asm-relation-row .asm-source").textContent()).includes("Revolute 1 → Revolute 2 · 2"),
);

/** A part's turn about Z, degrees. */
const turnOf = (prefix) => {
  const m = T(prefix);
  return (Math.atan2(m[1], m[0]) * 180) / Math.PI;
};
const near = (a, b) => Math.abs(a - b) < 0.05;
/** Type into the Move panel's field for the selected part. */
const typeField = async (label, text) => {
  const f = page.locator(".asm-move .ed-field", { hasText: label }).locator("input");
  await f.click();
  await f.fill(text);
  await f.press("Enter");
  await page.waitForTimeout(400);
};

if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/relation-panel.png` });
// Type the first arm's angle: the second turns twice as far, the other way.
const a0 = turnOf("Arm");
const b0 = turnOf("Arm2");
await page.locator(".asm-row").nth(1).click();
await page.waitForTimeout(300);
await typeField("Angle", "30");
rec = await saved();
const da = turnOf("Arm") - a0;
const db = turnOf("Arm2") - b0;
check("typing the driver's angle turns it", near(Math.abs(da), 30), da.toFixed(2));
check("…and the driven arm twice as far, the other way", near(db, -2 * da), db.toFixed(2));

// Type the driven arm's angle: its field reads where it is, and typing turns the driver.
await page.locator(".asm-row").nth(2).click();
await page.waitForTimeout(300);
const shown = await page.locator(".asm-move .ed-field", { hasText: "Angle" }).locator("input").inputValue();
check("the driven arm's field reads where it is", shown === "-60", shown);
await typeField("Angle", "-20");
rec = await saved();
check(
  "typing the driven arm's angle turns the driver",
  rec.assembly.mates[0].values?.rz === "10" && rec.assembly.mates[1].values?.rz === undefined,
  JSON.stringify(rec.assembly.mates.map((m) => m.values)),
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// --- Animating the driver turns both -----------------------------------------
check("the driven mate has no ▶ (its driver animates it)", (await page.locator(".asm-mate-animate").count()) === 1);
await page.locator(".asm-mate-animate").click();
await page.locator(".asm-animate .ed-title").hover();
await page.waitForTimeout(300);
// Shoot each arm's half of the view, before and mid-play.
const half = async (prefix) => {
  const p = await toScreen(apply4(T(prefix), [armBottom[0], armBottom[1], armBottom[2] + 2]));
  return page.screenshot({ clip: { x: p.x - 90, y: p.y - 90, width: 180, height: 180 } });
};
const still = [await half("Arm"), await half("Arm2")];
await page.locator(".asm-animate-play").click();
await page.waitForTimeout(800);
const mid = [await half("Arm"), await half("Arm2")];
check("animating the driver turns the first arm", !still[0].equals(mid[0]));
check("…and the second, through the relation", !still[1].equals(mid[1]));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// --- Suppress toggles: left out of the solve, kept, parts staying put ---------------
const relToggle = page.locator(".asm-relation-row .asm-suppress");
await relToggle.click();
rec = await saved();
check(
  "the relation's toggle suppresses it, keeping it",
  rec.assembly.relations?.[0].suppressed === true &&
    (await page.locator(".asm-relation-row .asm-source").textContent()).includes("suppressed"),
);
await relToggle.click();
rec = await saved();
check("…and brings it back", rec.assembly.relations?.[0].suppressed === undefined);
const armAt = JSON.stringify(T("Arm2"));
const mateToggle = page.locator(".asm-mate-row").nth(1).locator(".asm-suppress");
await mateToggle.click();
rec = await saved();
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/suppressed-panel.png` });
check(
  "a mate's toggle suppresses it, the arm it held staying where it was",
  rec.assembly.mates[1].suppressed === true && JSON.stringify(T("Arm2")) === armAt,
);
check(
  "…its row says so, and the relation that used it says why it can't apply",
  (await page.locator(".asm-mate-row").nth(1).locator(".asm-source").textContent()).includes("suppressed") &&
    /is suppressed/.test(await page.locator(".asm-relation-row .asm-source").textContent()),
);
await mateToggle.click();
rec = await saved();
check("…and back", rec.assembly.mates[1].suppressed === undefined);

// --- Deleting the driven mate takes the relation with it ------------------------
await page.locator(".asm-mate-row").nth(1).locator('.row-icon[title="Delete the mate"]').click();
rec = await saved();
check("deleting a related mate deletes the relation", !rec.assembly.relations && rec.assembly.mates.length === 1);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
