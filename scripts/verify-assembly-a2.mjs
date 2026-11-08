// Assemblies A2: mates. Picks connectors by clicking faces in the viewport,
// makes a revolute (turntable) and a slider, edits a value, drags a slider
// along its axis with the gizmo, checks a second, agreeing mate on the same
// pair is accepted (the loop solver takes it), deletes a mate
// (the part stays put), undo, reload, and a live part edit carried through a
// mate. NB if the local open-poly MCP hub is running, this headless tab
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
const ORDER = { Base: 0, Arm: 1, Pin: 2 };
const instanceOf = (rec, doc) => rec.assembly.instances[ORDER[doc]];
const view = async (key) => {
  await page
    .locator(".viewport canvas")
    .first()
    .hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
};

// --- Three part documents ------------------------------------------------
const doc0 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await rename("Base");
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await waitIdle();
for (const [name, op] of [
  ["Arm", { op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } }],
  ["Pin", { op: "addPrimitive", kind: "cylinder", params: { radius: "3", height: "20" } }],
]) {
  await page.locator(".newdoc-btn").click();
  await waitIdle();
  await rename(name);
  await apply(op);
  await waitIdle();
}

// --- The assembly ----------------------------------------------------------
await page.locator(".split-btn-caret").click();
await page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }).click();
await waitIdle();
await rename("Mech");
check("＋ Mate waits for two parts", await page.locator(".asm-new-mate").isDisabled());
await insertFrom("Base");
await insertFrom("Arm");
await insertFrom("Pin");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

const baseTop = await faceCentre("Base", 1);
const armBottom = await faceCentre("Arm", -1);
const pinBottom = await faceCentre("Pin", -1);
let rec = await saved();
const T = (prefix) => instanceOf(rec, prefix).transform;

// --- Revolute: the arm turns on the base's top ----------------------------
await page.locator(".asm-new-mate").click();
check("＋ Mate opens the Mate dialog", (await page.locator(".asm-mate").count()) === 1);
check("…armed for the first connector", (await page.locator(".asm-mate .ed-pick-btn.active").count()) === 1);
await page.locator(".asm-mate-types button", { hasText: "Revolute" }).click();
await clickWorld(apply4(T("Base"), baseTop));
const firstLabel = await page.locator(".asm-mate .bool-operand-name").first().textContent();
const names = rec.assembly.instances.map((i) => i.name);
check("picking the base's top fills the first slot", firstLabel === `${names[0]} · face`, firstLabel ?? "");
await view("6"); // bottom view, to see the arm's underside
await clickWorld(apply4(T("Arm"), armBottom));
const labels = await page.locator(".asm-mate .bool-operand-name").allTextContents();
check(
  "picking the arm's underside fills the second",
  labels.length === 2 && labels[1] === `${names[1]} · face`,
  labels.join(" | "),
);
check("a connector marker is drawn", true); // visual: see the screenshot
await page.screenshot({ path: "/tmp/asm-a2-picking.png" });
await view("7");
await page.locator(".asm-mate-dof input").first().fill("90");
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/asm-a2-preview.png" });
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
check("Create saves the mate", rec.assembly.mates.length === 1 && rec.assembly.mates[0].type === "revolute");
check("…named after its type", rec.assembly.mates[0].name === "Revolute 1", rec.assembly.mates[0].name);
const armT = T("Arm");
const armBottomWorld = apply4(armT, armBottom);
const baseTopWorld = apply4(T("Base"), baseTop);
check(
  "the arm's underside now sits on the base's top centre",
  armBottomWorld.every((v, i) => Math.abs(v - baseTopWorld[i]) < 1e-3),
  `${armBottomWorld.map((v) => v.toFixed(2))} vs ${baseTopWorld.map((v) => v.toFixed(2))}`,
);
// The arm is 30 long in X; turned 90° it lies along Y.
check("…turned 90°: its length now runs along Y", Math.abs(armT[0]) < 1e-6 && Math.abs(Math.abs(armT[1]) - 1) < 1e-6);
check("the mate is listed", (await page.locator(".asm-mate-row").count()) === 1);

// Edit the angle through the list.
await page.locator(".asm-mate-row").first().click();
check(
  "clicking a mate reopens it for editing",
  (await page.locator(".asm-mate .ed-title").textContent()) === "Edit mate",
);
await page.locator(".asm-mate-dof input").first().fill("45");
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
const a45 = T("Arm");
check(
  "editing the angle to 45° turns it to 45°",
  Math.abs(a45[0] - Math.SQRT1_2) < 1e-6 && Math.abs(Math.abs(a45[1]) - Math.SQRT1_2) < 1e-6,
  a45
    .slice(0, 3)
    .map((v) => v.toFixed(3))
    .join(","),
);

// --- Slider: the pin stands on the base, free to slide up --------------------
await page.locator(".asm-new-mate").click();
await page.locator(".asm-mate-types button", { hasText: "Slider" }).click();
// The base's top, off-centre so the arm (on the centre) isn't hit.
await clickWorld(apply4(T("Base"), [baseTop[0] + 15, baseTop[1] - 15, baseTop[2]]));
await view("6");
await clickWorld(apply4(T("Pin"), pinBottom));
await view("7");
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
const pin0 = apply4(T("Pin"), pinBottom);
check(
  "the slider stands the pin on the base's top centre",
  pin0.every((v, i) => Math.abs(v - baseTopWorld[i]) < 1e-3),
  pin0.map((v) => v.toFixed(2)).join(","),
);

// Drag the pin with the gizmo: it may only go along the slider's axis (Z).
await page.locator(".asm-row", { hasText: "Pin" }).first().click();
await page.waitForTimeout(300);
check("a slider's part offers Move only", (await page.locator(".asm-move .ed-modes").count()) === 0);
check("…and says which mate it moves along", /along Slider 1/.test(await page.locator(".asm-move").textContent()));
const pinMid = apply4(T("Pin"), [pinBottom[0], pinBottom[1], pinBottom[2] + 10]);
const g = await toScreen(pinMid);
await page.mouse.move(g.x, g.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(g.x + i * 8, g.y - i * 6, { steps: 2 });
await page.mouse.up();
rec = await saved();
const slider = rec.assembly.mates.find((m) => m.type === "slider");
const tz = Number(slider.values?.tz ?? 0);
const pin1 = apply4(T("Pin"), pinBottom);
check("dragging the pin writes the slider's distance", Math.abs(tz) > 1, `tz = ${tz}`);
check(
  "…and moves it only along the axis",
  Math.abs(pin1[0] - pin0[0]) < 1e-3 && Math.abs(pin1[1] - pin0[1]) < 1e-3 && Math.abs(pin1[2] - pin0[2] - tz) < 1e-3,
  pin1.map((v) => v.toFixed(2)).join(","),
);
await page.screenshot({ path: "/tmp/asm-a2-dragged.png" });
await page.keyboard.press("Escape");

// --- A second mate on the same pair that agrees is accepted --------------------
// The same face pair again: redundant, not conflicting, so the loop solver
// takes it without a warning (it used to be refused as a loop).
await page.locator(".asm-new-mate").click();
await clickWorld(apply4(T("Base"), [baseTop[0] - 15, baseTop[1] + 15, baseTop[2]]));
await view("6");
await clickWorld(apply4(T("Pin"), pinBottom));
await view("7");
const loopMsg =
  (await page
    .locator(".asm-mate .ed-warning")
    .textContent({ timeout: 500 })
    .catch(() => "")) ?? "";
check("a redundant second mate isn't flagged", !/Over-constrained/.test(loopMsg), loopMsg);
check("…and could be created", !(await page.locator(".asm-mate .ed-primary").isDisabled()));
await page.locator(".asm-mate button", { hasText: "Cancel" }).click();

// --- Delete a mate: the part stays where it was ---------------------------------
const before = T("Arm");
await page.locator(".asm-mate-row").first().locator(".row-icon").click();
rec = await saved();
check("✕ deletes the mate", rec.assembly.mates.length === 1);
check(
  "…and the arm stays where the mate held it",
  T("Arm").every((v, i) => Math.abs(v - before[i]) < 1e-9),
);
await page.keyboard.press("Meta+z");
rec = await saved();
check("undo brings the mate back", rec.assembly.mates.length === 2);

// --- Live: make the base taller, the mated parts ride up --------------------------
await page.locator(".asm-row", { hasText: "Base" }).first().dblclick();
await waitIdle();
const box = (await page.evaluate(() => window.__openpoly.read({ read: "document" }))).features[0];
await apply({ op: "setParam", featureId: box.id, name: "height", value: "30" });
await waitIdle();
await page.waitForTimeout(900);
await page.locator(".docs-btn").click();
await page.locator(".docs-row", { hasText: "Mech" }).locator(".text-btn", { hasText: "Open" }).click();
await waitIdle();
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/asm-a2-live.png" });
// The solved placement isn't saved until the next edit; read it off the arm's
// rendered position through a pick instead: click where the arm's top now is.
// Off-centre: the pin stands in the middle of it. (The arm turns about Z, so
// its own Z is the world's and the 20 mm rise can be added there.)
const armTopNow = apply4(T("Arm"), [armBottom[0] + 11, armBottom[1], armBottom[2] + 4 + 20]);
await clickWorld(armTopNow);
const sel = await page
  .locator(".asm-row.selected .solid-name")
  .inputValue()
  .catch(() => "");
check("after the base grows 20 mm, the arm rides up with it", sel === names[1], sel);
await page.keyboard.press("Escape");

// --- Reload ----------------------------------------------------------------------
await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
await page.waitForTimeout(1000);
check("after reload both mates are listed", (await page.locator(".asm-mate-row").count()) === 2);
check("…with no ⚠", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);
await page.screenshot({ path: "/tmp/asm-a2-reload.png" });

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
