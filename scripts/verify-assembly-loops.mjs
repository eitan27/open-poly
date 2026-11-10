// Assemblies: the loop solver. Two mates between the same two parts — a width
// mate centring an arm between a base's front and back, then a planar mate
// laying it on the base's top — used to be refused as a loop. Now the pair is
// solved together: no ⚠, the arm lies on the top and stays centred, a drag
// slides it along the base and nowhere else, and reload keeps it all. Then a
// third mate, made from two faces picked BEFORE the dialog opens: it opens
// ready to confirm, turned to fit (flush ends need Flip), and clicking on to
// another face makes it and starts the next mate from that face.
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
await rename("Loops");
await insertFrom("Base");
await insertFrom("Arm");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const baseFront = await faceCentre("Base", -1, 1);
const baseBack = await faceCentre("Base", 1, 1);
const baseTop = await faceCentre("Base", 1, 2);
const armBottom = await faceCentre("Arm", -1, 2);
const baseLeft = await faceCentre("Base", -1, 0);
const armLeft = await faceCentre("Arm", -1, 0);
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

const moveDialogAside = async () => {
  const t = await page.locator(".asm-mate .ed-title").boundingBox();
  await page.mouse.move(t.x + 20, t.y + 8);
  await page.mouse.down();
  await page.mouse.move(t.x - 600, t.y + 300, { steps: 8 });
  await page.mouse.up();
};
const hoverView = () =>
  page
    .locator(".viewport canvas")
    .first()
    .hover({ position: { x: 5, y: 5 } });

// --- Width: the arm centred between the base's front and back ----------------
await hoverView();
await page.keyboard.press("m");
await page.waitForTimeout(300);
await page.keyboard.press("w");
await page.waitForTimeout(200);
await moveDialogAside();
await view("2");
await clickWorld(apply4(T("Base"), baseFront));
await view("4");
await clickWorld(apply4(T("Base"), baseBack));
await clickWorld(apply4(T("Arm"), armBack));
await view("2");
await clickWorld(apply4(T("Arm"), armFront));
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
check("the width mate is made", rec.assembly.mates.length === 1 && rec.assembly.mates[0].type === "width");

// --- Planar: the arm's bottom on the base's top --------------------------------
await hoverView();
await page.keyboard.press("p");
await page.waitForTimeout(300);
check(
  "P opens the Mate dialog on Planar",
  (await page.locator(".asm-mate-type-btn .asm-mate-type-name").textContent()) === "Planar",
);
await moveDialogAside();
await view("7");
// Off to one side of the top, clear of the arm.
await clickWorld(apply4(T("Base"), [baseTop[0] - 15, baseTop[1] - 15, baseTop[2]]));
// The width mate centred the arm inside the base: hide the base to reach the
// arm's bottom from below, then show it again.
const instRow = (k) => page.locator(".asm-list > .asm-row").nth(k);
const eye = (k) => instRow(k).locator('button[title="Hide"], button[title="Show"]');
await eye(0).click();
await view("6");
await clickWorld(apply4(T("Arm"), armBottom));
await eye(0).click();
await view("7");
const w = (await warning()) ?? "";
check("a second mate on the same pair isn't flagged", !/Over-constrained|loop/.test(w), w);
await page.screenshot({ path: "/tmp/asm-loops-preview.png" });
check("…and can be created", !(await page.locator(".asm-mate .ed-primary").isDisabled()));
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
check("both mates are saved", rec.assembly.mates.length === 2);
check("…with no ⚠", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);

const mid = (t, p, q) =>
  apply4(
    t,
    p.map((v, i) => (v + q[i]) / 2),
  );
const baseMid = mid(T("Base"), baseFront, baseBack);
const topZ = apply4(T("Base"), baseTop)[2];
const onTop = () => apply4(T("Arm"), armBottom)[2];
const centred = () => mid(T("Arm"), armFront, armBack)[1];
check("the arm lies on the base's top", Math.abs(onTop() - topZ) < 1e-3, `${onTop().toFixed(3)} vs ${topZ.toFixed(3)}`);
check(
  "…still centred between its front and back",
  Math.abs(centred() - baseMid[1]) < 1e-3,
  `${centred().toFixed(3)} vs ${baseMid[1].toFixed(3)}`,
);
check("…and the same way up", Math.abs(T("Arm")[10] - 1) < 1e-6);
await page.screenshot({ path: "/tmp/asm-loops-made.png" });

// --- Drag: along the base, and nowhere else -------------------------------------
await instRow(1).click();
await page.waitForTimeout(300);
const x0 = apply4(T("Arm"), armBottom)[0];
const g = await toScreen(apply4(T("Arm"), [armBottom[0] + 8, armBottom[1], armBottom[2] + 4]));
await page.mouse.move(g.x, g.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(g.x + i * 8, g.y - i * 5, { steps: 2 });
await page.mouse.up();
rec = await saved();
const x1 = apply4(T("Arm"), armBottom)[0];
check("dragging the arm moves it", Math.abs(x1 - x0) > 1, `${x0.toFixed(2)} → ${x1.toFixed(2)}`);
check("…keeping it on the top", Math.abs(onTop() - topZ) < 1e-3, onTop().toFixed(3));
check("…and centred", Math.abs(centred() - baseMid[1]) < 1e-3, centred().toFixed(3));
check("…with no ⚠", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);
await page.screenshot({ path: "/tmp/asm-loops-dragged.png" });
await page.locator(".asm-move .ed-primary", { hasText: "Done" }).click(); // keep the drag (Esc would undo it)

// --- Delete the planar mate: the arm stays where the pair held it ---------------
const before = T("Arm");
await page.locator(".asm-mate-row").nth(1).locator(".row-icon").click();
rec = await saved();
check("✕ deletes the planar mate", rec.assembly.mates.length === 1);
check(
  "…and the arm stays put",
  T("Arm").every((v, i) => Math.abs(v - before[i]) < 1e-2),
  T("Arm")
    .slice(12, 15)
    .map((v) => v.toFixed(3))
    .join(","),
);
await page.keyboard.press("Meta+z");
rec = await saved();
check("undo brings it back", rec.assembly.mates.length === 2);

await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
await page.waitForTimeout(1000);
check("after reload both mates are listed", (await page.locator(".asm-mate-row").count()) === 2);
check("…with no ⚠", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);

// --- Pre-picked faces that can't make the mate are let go -----------------------
await view("7");
await clickWorld(apply4(T("Base"), [baseTop[0] - 15, baseTop[1] - 15, baseTop[2]]));
await view("5");
await clickWorld(apply4(T("Base"), [baseLeft[0], baseLeft[1] + 12, baseLeft[2] - 2]));
await hoverView();
await page.keyboard.press("p");
await page.waitForTimeout(400);
check(
  "two faces of one part leave the mate empty",
  (await page.locator(".asm-mate .bool-operand-name").count()) === 0,
  (await page.locator(".asm-mate .bool-operand-name").allTextContents()).join(" | "),
);
check(
  "…listening for the first face as usual",
  /first part/.test((await page.locator(".asm-mate .ed-pick-btn.active").textContent()) ?? ""),
);
check("…and says why", /let go/.test((await warning()) ?? ""), (await warning()) ?? "");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Three faces are one too many for a planar mate: let go too.
await view("7");
await clickWorld(apply4(T("Base"), [baseTop[0] - 15, baseTop[1] - 15, baseTop[2]]));
await view("5");
await clickWorld(apply4(T("Base"), [baseLeft[0], baseLeft[1] + 12, baseLeft[2] - 2]));
await clickWorld(apply4(T("Arm"), armLeft));
await hoverView();
await page.keyboard.press("p");
await page.waitForTimeout(400);
check("three faces for a planar mate are let go", (await page.locator(".asm-mate .bool-operand-name").count()) === 0);
check("…and it says why", /let go/.test((await warning()) ?? ""));
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// …but three can start a width mate: both faces of one part and one of the
// other, in whichever order they were clicked.
await view("2");
await clickWorld(apply4(T("Base"), [baseFront[0] + 12, baseFront[1], baseFront[2] - 3]));
// Two faces gathered hide the move gizmo, so the arm's back (clicked third)
// isn't covered by its arrows.
await clickWorld(apply4(T("Arm"), [armFront[0] + 10, armFront[1], armFront[2]]));
await view("4");
await clickWorld(apply4(T("Arm"), [armBack[0] + 10, armBack[1], armBack[2]]));
await hoverView();
await page.keyboard.press("w");
await page.waitForTimeout(400);
const w3 = await page.locator(".asm-mate .bool-operand-name").allTextContents();
check(
  "three faces start a width mate from the part with both",
  w3.length === 1 && w3[0] === `${names[1]} · 2 faces`,
  w3.join(" | "),
);
const want4 = (await page.locator(".asm-mate .ed-pick-btn.active").textContent()) ?? "";
check("…waiting for the base's other face", want4 === `Select the opposite face of ${names[0]}`, want4);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// --- A third mate from two pre-picked faces ------------------------------------
rec = await saved();
await view("5"); // left: both left ends face the camera
await clickWorld(apply4(T("Base"), [baseLeft[0], baseLeft[1] + 12, baseLeft[2] - 2]));
await clickWorld(apply4(T("Arm"), armLeft));
await hoverView();
await page.keyboard.press("p");
await page.waitForTimeout(400);
const filled = await page.locator(".asm-mate .bool-operand-name").allTextContents();
check(
  "two faces picked first fill both slots",
  filled.length === 2 && filled.every((t) => /face/.test(t)),
  filled.join(" | "),
);
check("…with nothing left armed", (await page.locator(".asm-mate .ed-pick-btn.active").count()) === 0);
const msg = (await warning()) ?? "";
check("flush ends are turned to fit, not flagged", !msg, msg);
check(
  "…which shows as Flip pressed",
  (await page.locator(".asm-mate .ed-modes button.active", { hasText: "Flip" }).count()) === 1,
);
check("…so it's ready to create", !(await page.locator(".asm-mate .ed-primary").isDisabled()));

// Clicking on to another face makes this mate and starts the next from it.
await view("7");
await clickWorld(apply4(T("Base"), [baseTop[0] - 15, baseTop[1] - 15, baseTop[2]]));
rec = await saved();
check("clicking on makes the mate", rec.assembly.mates.length === 3, String(rec.assembly.mates.length));
check(
  "…the arm's left end flush with the base's",
  Math.abs(apply4(T("Arm"), armLeft)[0] - apply4(T("Base"), baseLeft)[0]) < 1e-3,
);
check(
  "…and the dialog stays open, counting it",
  /1 made/.test(await page.locator(".asm-mate .ed-title").textContent()),
);
const next = await page.locator(".asm-mate .bool-operand-name").allTextContents();
check("…with the clicked face starting the next mate", next.length === 1, next.join(" | "));
check(
  "Cancel reads Close once a mate is made",
  (await page.locator(".asm-mate button", { hasText: "Close" }).count()) === 1,
);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check("Esc closes it", (await page.locator(".asm-mate").count()) === 0);
check("no ⚠ with three mates", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);
await page.screenshot({ path: "/tmp/asm-loops-three.png" });

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
