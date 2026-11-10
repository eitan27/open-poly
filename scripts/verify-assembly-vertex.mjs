// Assemblies: vertex and offset connectors. One Fastened mate between a corner
// vertex of each part (clicked in the view) puts the arm's corner on the
// base's, square to it once flipped; an offset on the base's connector moves
// it along that connector's own axes; reload keeps it.
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
await rename("Corners");
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

/** Each box's corner vertices, in part coordinates, from its mesh's bounds. */
const bounds = (docName) =>
  idb(
    `const v = recs.find((r) => r.name === arg).meshes[0].mesh.faces.vertices;
     const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
     for (let i = 0; i < v.length; i += 3) for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], v[i + q]); hi[q] = Math.max(hi[q], v[i + q]); }
     return { lo, hi };`,
    docName,
  );
const base = await bounds("Base");
const arm = await bounds("Arm");
// The base's top front-left corner, and the arm's bottom front-left corner.
const baseCorner = [base.lo[0], base.lo[1], base.hi[2]];
const armCorner = [arm.lo[0], arm.lo[1], arm.lo[2]];
const near = (p, q, tol = 1e-3) => p.every((v, i) => Math.abs(v - q[i]) < tol);

// --- Hovering shows where a mate could anchor ------------------------------------
// The base's top face, hovered with no Mate dialog open and then with one
// listening: the face lights up either way, but only the dialog adds markers
// at its centre and corners. Compared over the base's part of the view.
await view("7");
const topMid = [(base.lo[0] + base.hi[0]) / 2 + 6, (base.lo[1] + base.hi[1]) / 2 - 6, base.hi[2]];
const region = async () => {
  const ps = await Promise.all(
    [
      baseCorner,
      [base.hi[0], base.hi[1], base.hi[2]],
      [base.hi[0], base.lo[1], base.lo[2]],
      [base.lo[0], base.hi[1], base.lo[2]],
    ].map((p) => toScreen(apply4(T("Base"), p))),
  );
  const xs = ps.map((p) => p.x),
    ys = ps.map((p) => p.y);
  return {
    x: Math.min(...xs) - 20,
    y: Math.min(...ys) - 20,
    width: Math.max(...xs) - Math.min(...xs) + 40,
    height: Math.max(...ys) - Math.min(...ys) + 40,
  };
};
const hoverTop = async () => {
  const p = await toScreen(apply4(T("Base"), topMid));
  await page.mouse.move(p.x - 30, p.y - 30);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.waitForTimeout(300);
  return page.screenshot({ clip: await region() });
};
const idleHover = await hoverTop();

await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("f");
await page.waitForTimeout(300);
check(
  "F opens the Mate dialog on Fastened",
  (await page.locator(".asm-mate-type-btn .asm-mate-type-name").textContent()) === "Fastened",
);
{
  const t = await page.locator(".asm-mate .ed-title").boundingBox();
  await page.mouse.move(t.x + 20, t.y + 8);
  await page.mouse.down();
  await page.mouse.move(t.x - 600, t.y + 300, { steps: 8 });
  await page.mouse.up();
}
await view("7");
const armedHover = await hoverTop();
check("hovering a face while a slot listens marks where a mate could anchor", !idleHover.equals(armedHover));
await page.screenshot({ path: "/tmp/asm-candidates.png" });
await clickWorld(apply4(T("Base"), baseCorner));
await clickWorld(apply4(T("Arm"), armCorner));
check(
  "a corner of each part fills the slots as vertices",
  (await labels()).join(" | ") === `${names[0]} · vertex | ${names[1]} · vertex`,
  (await labels()).join(" | "),
);
await page.locator(".asm-mate button", { hasText: "Flip" }).click();
await page.waitForTimeout(200);
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
check(
  "Create saves a fastened mate on two vertices",
  rec.assembly.mates[0]?.type === "fastened" &&
    rec.assembly.mates[0].a.ref.kind === "vertex" &&
    rec.assembly.mates[0].b.ref.kind === "vertex",
);
const corner0 = apply4(T("Base"), baseCorner);
check(
  "the arm's corner lands on the base's",
  near(apply4(T("Arm"), armCorner), corner0),
  apply4(T("Arm"), armCorner)
    .map((v) => v.toFixed(3))
    .join(","),
);
check(
  "…square to it (flipped: the modelled orientations line up)",
  near([T("Arm")[0], T("Arm")[5], T("Arm")[10]], [1, 1, 1], 1e-6),
);
await page.screenshot({ path: "/tmp/asm-vertex-corner.png" });

// --- An offset on the base's corner moves the arm along it -------------------------
await page.locator(".asm-mate-row").first().click();
await page.waitForTimeout(200);
const offset = (slot, axis) =>
  page.locator(".asm-mate .asm-mate-slot").nth(slot).locator(".asm-mate-offset input").nth(axis);
await offset(0, 0).fill("5");
await offset(0, 1).fill("2 * 3");
await page.waitForTimeout(200);
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
check(
  "the offset is saved on the connector",
  JSON.stringify(rec.assembly.mates[0].a.offset) === JSON.stringify({ x: "5", y: "2 * 3" }),
  JSON.stringify(rec.assembly.mates[0].a.offset),
);
check(
  "…and moves the arm by it along the corner's axes",
  near(apply4(T("Arm"), armCorner), [corner0[0] + 5, corner0[1] + 6, corner0[2]]),
  apply4(T("Arm"), armCorner)
    .map((v) => v.toFixed(3))
    .join(","),
);
await page.screenshot({ path: "/tmp/asm-vertex-offset.png" });

await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
await page.waitForTimeout(1000);
check(
  "after reload the mate is listed with no ⚠",
  (await page.locator(".asm-mate-row").count()) === 1 &&
    (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0,
);
rec = await saved();
check(
  "…and the arm is still set in from the corner",
  near(apply4(T("Arm"), armCorner), [corner0[0] + 5, corner0[1] + 6, corner0[2]]),
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
