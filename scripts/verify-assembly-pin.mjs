// Assemblies: a Cylindrical mate between two real faceted parts — a pin in a
// hole. The block's hole is an extruded circle cut through a box and the pin is
// a cylinder primitive, so both round walls are faceted prisms and their axes
// are fitted from the tessellation (frames.ts), not read from the kernel. The
// pin's axis must land on the hole's; typing a distance and an angle must slide
// it along that axis and turn it about it; and after the block is rebuilt
// taller, the mate must still resolve with the axes still together.
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

const view = async (key) => {
  await page
    .locator(".viewport canvas")
    .first()
    .hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press(key);
  await page.waitForTimeout(900);
};

const R = 6;
const doc0 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await rename("Block");
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "20" } });
await waitIdle();
const sk = await apply({
  op: "addSketch",
  plane: { datum: "top" },
  entities: [{ shape: "circle", c: [0, 0], r: String(R) }],
});
await apply({
  op: "addExtrude",
  profile: { sketchId: sk.createdId },
  distance: "30",
  extent: "throughAll",
  mode: "remove",
  flip: true, // the sketch is on the box's bottom face: aim the cut into it
  targetId: box.createdId,
});
await waitIdle();
await page.locator(".newdoc-btn").click();
await waitIdle();
await rename("Pin");
await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: String(R), height: "40" } });
await waitIdle();

await page.locator(".split-btn-caret").click();
await page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }).click();
await waitIdle();
await rename("PinInHole");
await insertFrom("Block");
await insertFrom("Pin");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
let rec = await saved();
const T = (k) => rec.assembly.instances[k].transform;
check("the block (first in) is grounded", rec.assembly.instances[0].grounded === true);

/** A part's bounding box from its saved mesh, in part coordinates. */
const bounds = (docName) =>
  idb(
    `const v = recs.find((r) => r.name === arg).meshes[0].mesh.faces.vertices;
     const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
     for (let i = 0; i < v.length; i += 3) for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], v[i + q]); hi[q] = Math.max(hi[q], v[i + q]); }
     return { lo, hi };`,
    docName,
  );
let block = await bounds("Block");
const pin = await bounds("Pin");
const mid = (b) => [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2];
/** How far the pin's axis (both ends) is from the hole's axis, in world XY:
 *  the hole runs along Z through the block's middle. */
const axisGap = () => {
  const [hx, hy] = mid(block).map((v, i) => v + T(0)[12 + i]);
  const [px, py] = mid(pin);
  return Math.max(
    ...[pin.lo[2], pin.hi[2]].map((z) => {
      const p = apply4(T(1), [px, py, z]);
      return Math.hypot(p[0] - hx, p[1] - hy);
    }),
  );
};
/** The pin's axis direction in world space (a unit vector). */
const pinAxis = () => [T(1)[8], T(1)[9], T(1)[10]];

// --- The Cylindrical mate: click round walls until each slot reads "axis" -------
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("c");
await page.waitForTimeout(300);
check(
  "C opens the Mate dialog on Cylindrical",
  (await page.locator(".asm-mate-types button.active").textContent()) === "Cylindrical",
);
{
  const t = await page.locator(".asm-mate .ed-title").boundingBox();
  await page.mouse.move(t.x + 20, t.y + 8);
  await page.mouse.down();
  await page.mouse.move(t.x - 600, t.y + 300, { steps: 8 });
  await page.mouse.up();
}
await view("7");
const slotLabel = (k) =>
  page
    .locator(".asm-mate .asm-mate-slot")
    .nth(k)
    .locator(".bool-operand-name")
    .textContent({ timeout: 300 })
    .catch(() => "");
/** Click points round a wall (centre cx, cy in part space, radius r, at height
 *  z) until slot k holds an axis; re-arm the slot after a miss. */
const pickWall = async (k, inst, cx, cy, r, z) => {
  for (let a = 0; a < 16; a++) {
    const th = (a / 16) * 2 * Math.PI;
    await clickWorld(apply4(T(inst), [cx + r * Math.cos(th), cy + r * Math.sin(th), z]));
    const got = await slotLabel(k);
    if (/axis/.test(got)) return got;
    if (got) {
      await page.locator(".asm-mate .asm-mate-slot").nth(k).locator(".bool-operand-x").click();
      await page.waitForTimeout(150);
    }
  }
  return slotLabel(k);
};
const [bx, by] = mid(block);
const holeWall = await pickWall(0, 0, bx, by, R, block.hi[2] - 3);
check("the hole's wall fits an axis", /axis/.test(holeWall), holeWall);
const [pcx, pcy] = mid(pin);
const pinWall = await pickWall(1, 1, pcx, pcy, R, (pin.lo[2] + pin.hi[2]) / 2);
check("the pin's wall fits an axis", /axis/.test(pinWall), pinWall);
const warn = await page
  .locator(".asm-mate .ed-warning")
  .textContent({ timeout: 300 })
  .catch(() => "");
check("…with nothing to warn about", !warn, warn);
await page.locator(".asm-mate .ed-primary").click();
rec = await saved();
check("Create saves a cylindrical mate", rec.assembly.mates[0]?.type === "cylindrical");
check("the pin's axis lands on the hole's", axisGap() < 1e-3, axisGap().toExponential(2));
check(
  "…pointing along it",
  Math.abs(Math.abs(pinAxis()[2]) - 1) < 1e-6,
  pinAxis()
    .map((v) => v.toFixed(4))
    .join(","),
);

// --- It slides and turns -----------------------------------------------------------
await page.locator(".asm-list > .asm-row").nth(1).click();
await page.waitForTimeout(300);
const field = (label) => page.locator(".asm-move .ed-field", { hasText: label }).locator("input");
const typeInto = async (label, text) => {
  await field(label).click();
  await field(label).fill(text);
  await field(label).press("Enter");
  await page.waitForTimeout(300);
};
check(
  "the pin's panel shows Distance and Angle",
  (await field("Distance").count()) === 1 && (await field("Angle").count()) === 1,
);
const z0 = apply4(T(1), [pcx, pcy, pin.lo[2]])[2];
await typeInto("Distance", "12");
rec = await saved();
const slid = Math.abs(apply4(T(1), [pcx, pcy, pin.lo[2]])[2] - z0);
check(
  "a distance slides it along the axis",
  Math.abs(slid - 12) < 1e-3 && axisGap() < 1e-3,
  `${slid.toFixed(3)} mm, gap ${axisGap().toExponential(2)}`,
);
const x0 = [T(1)[0], T(1)[1]];
await typeInto("Angle", "90");
rec = await saved();
const turned = Math.abs(x0[0] * T(1)[0] + x0[1] * T(1)[1]);
check(
  "an angle turns it about the axis",
  turned < 1e-6 && axisGap() < 1e-3,
  `cos ${turned.toExponential(2)}, gap ${axisGap().toExponential(2)}`,
);
await page.screenshot({ path: "/tmp/asm-pin-moved.png" });
// Done keeps the move (Esc would cancel it, putting back what was typed).
await page.locator(".asm-move .ed-primary").click();

// --- Rebuild the block taller: the mate holds -------------------------------------
await page.locator(".asm-list > .asm-row").nth(0).dblclick();
// The switch lands a few hundred ms after the click, while the status already
// reads "up to date": wait for the assembly panel to go before editing.
await page.waitForFunction(() => !document.querySelector(".panel .asm-list"), null, { timeout: 10000 });
await waitIdle();
await apply({ op: "setParam", featureId: box.createdId, name: "height", value: "30" });
await waitIdle();
await page.waitForTimeout(900);
await page.locator(".docs-btn").click();
await page.locator(".docs-row", { hasText: "PinInHole" }).locator(".text-btn", { hasText: "Open" }).click();
await waitIdle();
await page.waitForTimeout(1200);
rec = await saved();
block = await bounds("Block");
check(
  "the block was rebuilt taller",
  Math.abs(block.hi[2] - block.lo[2] - 30) < 1e-3,
  (block.hi[2] - block.lo[2]).toFixed(3),
);
check("…and the mate still resolves", (await page.locator(".asm-mate-row .asm-source.bad").count()) === 0);
// The stored placement is only refreshed by an edit: nudge the angle and back.
await page.locator(".asm-list > .asm-row").nth(1).click();
await page.waitForTimeout(300);
await typeInto("Angle", "45");
rec = await saved();
check("after the rebuild the axes still coincide", axisGap() < 1e-3, axisGap().toExponential(2));
// The hole's connector is the middle of its wall, which the rebuild raised
// 5 mm, so measure the slide from where the pin is now: 12 → 20 is 8.
const zNow = apply4(T(1), [pcx, pcy, pin.lo[2]])[2];
await typeInto("Distance", "20");
rec = await saved();
const slid2 = Math.abs(apply4(T(1), [pcx, pcy, pin.lo[2]])[2] - zNow);
check(
  "…and it still slides along it",
  axisGap() < 1e-3 && Math.abs(slid2 - 8) < 1e-3,
  `${slid2.toFixed(3)} mm, gap ${axisGap().toExponential(2)}`,
);
await page.screenshot({ path: "/tmp/asm-pin-rebuilt.png" });

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
