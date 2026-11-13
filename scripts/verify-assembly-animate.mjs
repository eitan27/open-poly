// Assemblies: animating a mate. A revolute mate holds the arm on the base; the
// mate row's ▶ opens the Animate dialog, Play turns the arm in the view (the
// frames differ mid-play and the readout counts), nothing is saved, and Stop
// puts the arm back where it was. Export saves one cycle as a GIF or a
// video (MP4 where the browser records it) (and Cancel stops one), leaving the view and the document as they were. NB if the local open-poly MCP hub is running, this headless tab
// connects to it and can take the bridge from your own tab; reload yours after.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
const context = await browser.newContext({
  viewport: { width: 1660, height: 920 },
  deviceScaleFactor: 2,
  acceptDownloads: true,
});
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
await rename("Animate");
await insertFrom("Base");
await insertFrom("Arm");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const baseTop = await faceCentre("Base", 1);
const armBottom = await faceCentre("Arm", -1);
let rec = await saved();
const T = (prefix) => instanceOf(rec, prefix).transform;

await page.locator(".asm-new-mate").click();
await page.locator(".asm-mate-type-btn").click();
await page.locator(".asm-mate-types button", { hasText: "Revolute" }).click();
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
check("a revolute mate is made", rec.assembly.mates.length === 1 && rec.assembly.mates[0].type === "revolute");
const before = JSON.stringify(rec.assembly);

// Shoot the view only (the dialog's readout would differ on its own).
const canvas = page.locator(".viewport canvas").first();
// Right of the dialogs, which sit at the view's top left.
const shot = async () => {
  const b = await canvas.boundingBox();
  return page.screenshot({ clip: { x: b.x + 480, y: b.y, width: b.width - 480, height: b.height } });
};
const same = (a, b) => a.equals(b);
const still = await shot();

await page.locator(".asm-mate-animate").first().click();
await page.locator(".asm-animate").waitFor();
check("▶ opens the Animate dialog", (await page.locator(".asm-animate .ed-title").textContent()).includes("Animate"));
const field = (label) => page.locator(".asm-animate .ed-field", { hasText: label }).locator("input");
check(
  "a revolute's sweep starts at a full turn, looping",
  (await field("From").inputValue()) === "0" &&
    (await field("To").inputValue()) === "360" &&
    (await page.locator(".asm-animate .ed-modes button.active").textContent()) === "Loop",
);
await field("Seconds").fill("3");
await field("Seconds").press("Enter");
// Off the mate's row, whose hover shows its connectors over the parts.
await page.locator(".asm-animate .ed-title").hover();
await page.waitForTimeout(300);
const stillOpen = await shot();

await page.locator(".asm-animate-play").click();
await page.waitForTimeout(700);
const mid1 = await shot();
const live1 = await page.locator(".asm-animate-live").textContent();
await page.waitForTimeout(500);
const mid2 = await shot();
const live2 = await page.locator(".asm-animate-live").textContent();
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/animate-mid.png` });
check("playing moves the arm in the view", !same(stillOpen, mid1) && !same(mid1, mid2));
check("…and the readout counts the angle", live1 !== live2 && /Angle: [\d.]+ °/.test(live2), `${live1} → ${live2}`);
check("the Stop button shows while playing", await page.locator(".asm-animate-stop").isVisible());

rec = await saved();
check("nothing is saved while it plays", JSON.stringify(rec.assembly) === before);

await page.locator(".asm-animate-stop").click();
await page.waitForTimeout(400);
check("Stop puts the arm back", same(await shot(), stillOpen));

// Once, a quarter turn: it ends there and holds until closed.
await field("To").fill("90");
await field("To").press("Enter");
await field("Seconds").fill("0.5");
await field("Seconds").press("Enter");
await page.locator(".asm-animate .ed-modes button", { hasText: "Once" }).click();
await page.locator(".asm-animate-play").click();
await page.waitForTimeout(1200);
check("a Once animation ends", await page.locator(".asm-animate-play").isVisible());
check("…at its last value", (await page.locator(".asm-animate-live").textContent()).includes("90"));
const held = await shot();
check("…holding the arm turned", !same(held, stillOpen));
// --- Export one cycle: a GIF, a video, and a cancelled one -----------------------------
// Once, a quarter turn in half a second: 10 GIF frames, 15 video frames.
const download = async (button) => {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.locator(button).click()]);
  const path = await d.path();
  const fs = await import("node:fs");
  return { name: d.suggestedFilename(), bytes: fs.readFileSync(path) };
};
const gifClick = page.locator(".asm-export-gif").click();
await page.locator(".asm-export-progress").waitFor({ timeout: 5000 });
check("exporting shows its progress, with Play off", await page.locator(".asm-animate-play").isDisabled());
await gifClick;
const gif = await (async () => {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60000 })]);
  const fs = await import("node:fs");
  return { name: d.suggestedFilename(), bytes: fs.readFileSync(await d.path()) };
})();
// Each frame carries a graphic control extension (21 F9 04).
const frames = (b) => {
  let n = 0;
  for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9 && b[i + 2] === 0x04) n++;
  return n;
};
check(
  "GIF downloads a GIF of one cycle",
  gif.name.endsWith(".gif") && gif.bytes.subarray(0, 6).toString() === "GIF89a" && frames(gif.bytes) === 10,
  `${gif.name}, ${gif.bytes.length} bytes, ${frames(gif.bytes)} frames`,
);
if (process.env.SHOTS) (await import("node:fs")).writeFileSync(`${process.env.SHOTS}/export.gif`, gif.bytes);
await page.waitForTimeout(300);
// Like Stop, the export lets go of the poses when it's done: the arm at rest.
check("…and lets the view go, as Stop does", same(await shot(), stillOpen));

const video = await download(".asm-export-video");
// MP4 (H.264) where the browser records it, as Chromium does; WebM where not.
const mp4 = video.bytes.subarray(4, 8).toString() === "ftyp";
const webm = video.bytes.readUInt32BE(0) === 0x1a45dfa3;
check(
  "Video downloads an H.264 MP4 (or a WebM where MP4 doesn't record), named for what it is",
  video.bytes.length > 2000 &&
    ((mp4 && video.name.endsWith(".mp4") && video.bytes.includes("avc1")) || (webm && video.name.endsWith(".webm"))),
  `${video.name}, ${video.bytes.length} bytes, ${mp4 ? "MP4" : webm ? "WebM" : "unknown"}`,
);
check("Chromium records MP4", mp4);
if (process.env.SHOTS)
  (await import("node:fs")).writeFileSync(`${process.env.SHOTS}/export.${mp4 ? "mp4" : "webm"}`, video.bytes);

let downloaded = false;
page.once("download", () => (downloaded = true));
await field("Seconds").fill("3");
await field("Seconds").press("Enter");
await page.locator(".asm-export-gif").click();
await page.locator(".asm-export-cancel").click();
await page.waitForTimeout(1500);
check(
  "Cancel stops an export: nothing downloads",
  !downloaded &&
    (await page.locator(".asm-export-gif").count()) === 1 &&
    (await page.locator(".asm-animate .ed-warning").count()) === 0,
);
await page.locator(".asm-animate-close").click();
await page.waitForTimeout(400);
check("Close puts the arm back", same(await shot(), still));

// Esc closes it too, mid-play, putting the arm back.
await page.locator(".asm-mate-animate").first().click();
await page.locator(".asm-animate-play").click();
await page.waitForTimeout(600);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Esc closes the Animate dialog", (await page.locator(".asm-animate").count()) === 0);
await page.mouse.move(5, 5);
await page.waitForTimeout(300);
check("…and puts the arm back", same(await shot(), still));
rec = await saved();
check("…and the document is as it was", JSON.stringify(rec.assembly) === before);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
