// Records the "Getting started" tutorial: drives the app in a HEADED Chromium
// (headless renders the view cube black), captures frames over the CDP
// screencast, and logs when each narration line starts so build.mjs can lay the
// voice-over on the same clock.
//
//   OUT=<dir> node scripts/tutorial/tts.mjs      # narration → $OUT/audio
//   OUT=<dir> node scripts/tutorial/record.mjs   # frames    → $OUT/frames
//   OUT=<dir> node scripts/tutorial/build.mjs    # → $OUT/open-poly-tutorial.mp4
//
// Expects the dev server on http://localhost:5173 (URL= to override). The agent
// bridge socket is refused so a running MCP hub isn't hijacked by this tab.
import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { NARRATION } from "./narration.mjs";

const OUT = process.env.OUT;
const APP_URL = process.env.URL ?? "http://localhost:5173/";
const SHOTS = !!process.env.SHOTS; // also save a PNG at each beat's end, for checking
const TEXT = Object.fromEntries(NARRATION);
const DUR = JSON.parse(fs.readFileSync(`${OUT}/audio/durations.json`, "utf8"));
const frameDir = `${OUT}/frames`;
fs.rmSync(frameDir, { recursive: true, force: true });
fs.mkdirSync(frameDir, { recursive: true });
fs.rmSync(`${OUT}/shots`, { recursive: true, force: true });
if (SHOTS) fs.mkdirSync(`${OUT}/shots`, { recursive: true });

const BLUE = 0x3b82f6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: false, args: ["--window-size=1300,860"] });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1.5,
  acceptDownloads: true,
});
await ctx.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.close());
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("openpoly.settings", JSON.stringify({ newBodyColor: "#3b82f6" }));
  } catch {}
});
await ctx.addInitScript({ path: fileURLToPath(new URL("./overlay.js", import.meta.url)) });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(APP_URL);
await page.waitForFunction(() => !!window.__openpoly && !!window.__tut, { timeout: 30000 });

const idle = async () => {
  let run = 0;
  for (let i = 0; i < 200; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    run = /up to date|error|fail/i.test(s) ? run + 1 : 0;
    if (run >= 3) return s;
    await sleep(200);
  }
};
await idle();
const tut = (fn, arg) => page.evaluate(([f, a]) => window.__tut[f](...a), [fn, arg]);
const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);

// Seed document: colour its box so the opening shot has a consistent look.
{
  const d = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
  const box = d.features.find((f) => f.type === "primitive");
  if (box) await apply({ op: "setAppearance", featureId: box.id, color: BLUE });
  await idle();
}

// ---- mouse, with visible motion -------------------------------------------
let mx = 784,
  my = 420;
await page.mouse.move(mx, my);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
async function moveTo(x, y, ms = 550) {
  const n = Math.max(6, Math.round(ms / 16)),
    x0 = mx,
    y0 = my;
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    await page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k);
    await sleep(ms / n);
  }
  mx = x;
  my = y;
}
async function clickAt(x, y, { ms = 550, after = 250, button = "left" } = {}) {
  await moveTo(x, y, ms);
  await sleep(120);
  await page.mouse.down({ button });
  await sleep(70);
  await page.mouse.up({ button });
  await sleep(after);
}
async function drag(x0, y0, x1, y1, { button = "left", ms = 1200 } = {}) {
  await moveTo(x0, y0, 450);
  await page.mouse.down({ button });
  await moveTo(x1, y1, ms);
  await page.mouse.up({ button });
}
async function canvasBox() {
  return page.locator("canvas").first().boundingBox();
}
async function screenOf(w) {
  const b = await canvasBox();
  const p = await page.evaluate((q) => window.__openpoly.worldToScreen(q), w);
  return { x: b.x + p.x, y: b.y + p.y };
}
async function clickWorld(w, opts) {
  const p = await screenOf(w);
  await clickAt(p.x, p.y, opts);
}
async function boxOf(loc) {
  return (
    (await loc.first().boundingBox()) ??
    (() => {
      throw new Error(`no box for ${loc}`);
    })()
  );
}
async function clickEl(loc, opts) {
  const b = await boxOf(loc);
  await clickAt(b.x + b.width / 2, b.y + b.height / 2, opts);
}
const tool = (title) => page.locator(`.model-toolbar button[title^="${title}"]:visible`);
const key = async (k, after = 350) => {
  await page.keyboard.press(k);
  await sleep(after);
};
const typeSlow = async (s) => {
  for (const ch of s) {
    await page.keyboard.type(ch);
    await sleep(110);
  }
};
async function spot(locOrRect, ms, pad) {
  const r = locOrRect.x !== undefined ? locOrRect : await boxOf(locOrRect);
  await tut("spot", [r, ms, pad]);
}
// The paired sketch tools (Rectangle, Circle, Trim, Pattern) render as a split
// button: the active variant plus a 16px caret, two <button>s side by side. Both
// titles start with the group name, so union them to spotlight the whole control.
async function groupBox(name) {
  return page.evaluate((n) => {
    const bs = [...document.querySelectorAll(`.sketch-toolbar button[title^="${n}"]`)]
      .map((e) => e.getBoundingClientRect())
      .filter((b) => b.width);
    if (!bs.length) throw new Error(`no sketch-toolbar group "${n}"`);
    const x = Math.min(...bs.map((b) => b.x)),
      y = Math.min(...bs.map((b) => b.y));
    return { x, y, width: Math.max(...bs.map((b) => b.right)) - x, height: Math.max(...bs.map((b) => b.bottom)) - y };
  }, name);
}
/** Screen-space bounds of a body's world AABB, for spotlighting the model. */
async function bodyBox(w, d, h, pad = 16) {
  const b = await canvasBox();
  const pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [0, h]) pts.push([(sx * w) / 2, (sy * d) / 2, z]);
  const s = await page.evaluate((ps) => ps.map((q) => window.__openpoly.worldToScreen(q)), pts);
  const xs = s.map((p) => p.x),
    ys = s.map((p) => p.y);
  return {
    x: b.x + Math.min(...xs) - pad,
    y: b.y + Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + 2 * pad,
    height: Math.max(...ys) - Math.min(...ys) + 2 * pad,
  };
}
// ---- screencast ------------------------------------------------------------
const cdp = await ctx.newCDPSession(page);
const frames = [];
let frameNo = 0;
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  const file = `${String(frameNo++).padStart(6, "0")}.jpg`;
  frames.push({ file, t: metadata.timestamp });
  fs.writeFileSync(`${frameDir}/${file}`, Buffer.from(data, "base64"));
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});

// ---- beats -----------------------------------------------------------------
const marks = [];
let shotNo = 0;
async function beat(id, action = async () => {}, { gap = 300 } = {}) {
  if (!(id in TEXT)) throw new Error(`no narration for ${id}`);
  marks.push({ id, t: Date.now() / 1000 });
  // Non-breaking hyphen: the caption must never wrap the URL at "open-".
  await tut("caption", [TEXT[id].replace(/open-poly/g, "open\u2011poly")]);
  const t0 = Date.now();
  await Promise.all([action(), sleep(DUR[id] * 1000)]);
  const over = (Date.now() - t0) / 1000 - DUR[id];
  if (over > 0.4) console.log(`  ${id}: action ran ${over.toFixed(1)}s past its line`);
  if (SHOTS) await page.screenshot({ path: `${OUT}/shots/${String(++shotNo).padStart(2, "0")}-${id}.png` });
  await sleep(gap);
}

await tut("card", [
  `<h1>Open <span>Poly</span></h1>
   <h2>Getting started: your first 3D-printable part</h2>
   <div class="tut-tags"><div>Free &amp; Open Source</div><div>Browser-based and locally runnable</div><div>Use with any AI agent</div></div>
   <div class="tut-url">open-poly.pages.dev &nbsp;·&nbsp; github.com/eitan27/open-poly</div>`,
  "tut-title",
]);
await sleep(900);
await cdp.send("Page.startScreencast", {
  format: "jpeg",
  quality: 92,
  maxWidth: 1920,
  maxHeight: 1080,
  everyNthFrame: 1,
});
await sleep(800);
const recStart = Date.now() / 1000;

// Intro. The title card holds for the whole pitch and only fades on "dive right
// in", so the cut to the app lands on the line that announces it.
await beat("title", async () => {}, { gap: 200 });
await beat("opensource", async () => {}, { gap: 200 });
await beat("dive", async () => {
  await tut("hideCard", ["tut-title"]); // .tut-card fades over .7s
  await sleep(700);
  await moveTo(620, 520, 450); // just off the body — parking ON it tints a face
});

// Tour
// 2.3s, so the model's spotlight clears before the timeline's one lights up.
await beat("center", async () => {
  await spot(await bodyBox(40, 30, 20), 2300, 0);
});
await beat("timeline", () => spot(page.locator(".tree-list"), 3800, 6));
await beat("toolbar", () => spot(page.locator(".model-toolbar"), 3000, 4));

// Camera
const cubeC = { x: 1211, y: 162 }; // view cube centre at the default iso view
// Top-right corner nub of the now-front-on cube. Each of the 8 nubs snaps to the
// iso view down its own diagonal, so this is the shot that undoes the FRONT click.
const cubeNub = { x: 1243, y: 131 };
await beat("cube", async () => {
  await spot({ x: cubeC.x - 52, y: cubeC.y - 56, width: 104, height: 112 }, 2400, 4);
  await sleep(1300);
  await clickAt(cubeC.x - 18, cubeC.y + 12, { ms: 700 }); // FRONT face
});
await beat("cubeCorner", async () => {
  await sleep(350);
  await clickAt(cubeNub.x, cubeNub.y, { ms: 800, after: 500 });
});
// Starts below the body (a left PRESS on geometry would select it) and covers
// ~230px in 1.15s — about 2.5x the old throw, so the orbit reads as responsive.
await beat("orbit", () => drag(860, 555, 1090, 450, { ms: 1150 }));
await beat("panZoom", async () => {
  await drag(780, 520, 700, 460, { button: "right", ms: 900 });
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -120);
    await sleep(90);
  }
});
await beat("home", async () => {
  const home = page.locator('button.view-reset[title^="Home"]');
  await spot(home, 2200, 6);
  await sleep(1300);
  await clickEl(home, { ms: 700 });
});

// Sketch
await beat("new", () => clickEl(page.locator(".newdoc-btn"), { ms: 800, after: 600 }));
await idle();
await beat("sketch", async () => {
  await clickEl(tool("Sketch (S)"), { ms: 700, after: 1600 });
  await clickWorld([22, 32, 0], { ms: 800, after: 300 });
});
await beat("rect", async () => {
  // The sketch opens zoomed right in; back off so the plate has room.
  const o = await screenOf([0, 0, 0]);
  await moveTo(o.x + 40, o.y + 30, 500);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 120);
    await sleep(120);
  }
  await spot(await groupBox("Rectangle"), 2200, 5);
  await sleep(500);
  await key("Shift+R", 600);
  await clickWorld([0, 0, 0], { ms: 700, after: 300 });
  const c = await screenOf([27, 17, 0]);
  await moveTo(c.x, c.y, 1100);
  await clickAt(c.x, c.y, { ms: 100, after: 300 });
});
await beat("dimW", async () => {
  await sleep(1800);
  await key("s", 250);
  await clickWorld([0, 17, 0], { after: 300 });
  await key("d", 700);
  await typeSlow("60");
  await sleep(250);
  await key("Enter", 300);
});
await beat(
  "dimH",
  async () => {
    await clickWorld([30, -6, 0], { ms: 300, after: 150 });
    await key("d", 500);
    await typeSlow("40");
    await key("Enter", 200);
  },
  { gap: 500 },
);
await beat("circle", async () => {
  await spot(await groupBox("Circle"), 2000, 5);
  await sleep(400);
  await key("c", 300);
  await clickWorld([0, 0, 0], { after: 200 });
  await clickWorld([0, -6, 0], { ms: 500, after: 300 });
  await key("s", 200);
  await clickWorld([-4.24, -4.24, 0], { after: 200 });
  await key("d", 500);
  await typeSlow("16");
  await key("Enter", 200);
});
await beat(
  "finish",
  async () => {
    await sleep(300);
    // Finish sketch sits right on top of Chamfer in the modeling toolbar, so
    // leave at once (no post-click pause) — any dwell shows Chamfer's hover state
    // the moment the banner goes.
    await clickEl(page.getByRole("button", { name: /Finish sketch/ }), { ms: 800, after: 0 });
    await moveTo(mx, my + 140, 250);
  },
  { gap: 400 },
);

// Variable → extrude by it → change it
await beat("variable", async () => {
  await spot(page.locator(".var-add"), 3800, 5);
  await sleep(4300);
  await clickEl(page.locator(".var-add"), { ms: 700, after: 400 });
  await clickEl(page.locator(".var-name").first(), { ms: 400, after: 100 });
  await page.keyboard.press("Meta+a");
  await typeSlow("thickness");
  await clickEl(page.locator(".var-expr").first(), { ms: 400, after: 100 });
  await page.keyboard.press("Meta+a");
  await typeSlow("8");
  await page.evaluate(() => document.activeElement?.blur());
});
await idle();
await beat("extrude", async () => {
  // Park the cursor on empty canvas first: a highlighted Home button with the
  // pointer resting on some other control reads as if that one is being pressed.
  // Outside the 60×40 rectangle: resting on the sketch region highlights it.
  const park = await screenOf([45, -28, 0]);
  await moveTo(park.x, park.y, 500);
  await spot(page.locator('button.view-reset[title^="Home"]'), 1900, 6);
  await sleep(350);
  await key("h", 1400);
  await clickEl(tool("Extrude (E)"), { ms: 800, after: 400 });
});
await beat("extrudeSet", async () => {
  await clickWorld([20, 10, 0], { ms: 550, after: 250 });
  const dist = page.locator(".extrude-dialog .ed-field input").first();
  await clickEl(dist, { ms: 400, after: 100 });
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("thickness", { delay: 45 });
  await sleep(400);
  await clickEl(page.locator(".extrude-dialog .ed-primary"), { ms: 450 });
});
await idle();
await beat("plate", () => moveTo(560, 560, 900), { gap: 400 });
await beat(
  "varChange",
  async () => {
    const expr = page.locator(".var-expr").first();
    await spot(page.locator(".var-row").first(), 3000, 5);
    await clickEl(expr, { ms: 700, after: 150 });
    await page.keyboard.press("Meta+a");
    await typeSlow("12");
    await page.evaluate(() => document.activeElement?.blur());
    await moveTo(700, 600, 600);
  },
  { gap: 500 },
);
await idle();

// Fillet (the top face is at z = thickness = 12 now)
await beat("fillet", async () => {
  await clickEl(tool("Fillet (F)"), { ms: 700, after: 500 });
  await clickWorld([18, 12, 12], { ms: 700, after: 300 });
});
await beat("filletSet", async () => {
  const r = page.locator(".extrude-dialog .ed-field input").first();
  await clickEl(r, { ms: 500, after: 100 });
  await page.keyboard.press("Meta+a");
  await typeSlow("2");
  await sleep(350);
  await clickEl(page.locator(".extrude-dialog .ed-primary"), { ms: 500 });
});
await idle();
await moveTo(1000, 640, 500);

// Shortcuts
await beat("hints", async () => {
  await sleep(1800);
  await key("?", 300);
  await spot(page.locator(".model-toolbar"), 2400, 4);
});
await beat("keys", async () => {
  for (const t of ["Sketch (S)", "Extrude (E)", "Fillet (F)"]) {
    await spot(tool(t), 950, 3);
    await sleep(1150);
  }
  await sleep(150);
  await key("1", 1500);
  await key("7", 300);
});
// Undo by the shortcut, redo by the button, so both routes get shown.
const undoBtn = page.locator('.tool-btn[title^="Undo"]');
const redoBtn = page.locator('.tool-btn[title^="Redo"]');
await beat(
  "undo",
  async () => {
    await key("?", 900); // hints off again
    await key("Meta+z", 400);
    await spot(undoBtn, 1700, 5);
  },
  { gap: 200 },
);
await beat(
  "redo",
  async () => {
    await spot(redoBtn, 2600, 5);
    // A straight line to the top bar crosses the model (hover-lights its edges)
    // and the modeling toolbar (hover-lights a button). So: along under the
    // model (above the caption bar, which would hide the cursor), up the gap
    // beside the sidebar — stepping right of its collapse
    // button (x 289–301, y ≈345–400) — then along the empty lane between the
    // two bars (y≈48).
    const r = await boxOf(redoBtn);
    await moveTo(mx, 610, 250);
    await moveTo(310, 610, 450);
    await moveTo(310, 320, 250);
    await moveTo(294, 120, 200);
    await moveTo(294, 48, 120);
    await moveTo(r.x + r.width / 2, 48, 250);
    await clickAt(r.x + r.width / 2, r.y + r.height / 2, { ms: 150, after: 300 });
  },
  { gap: 600 },
);
await idle();

// Export
await beat("name", async () => {
  const name = page.locator(".solid-name");
  await spot(page.locator(".solid-name").locator(".."), 3600, 4);
  await clickEl(name, { ms: 700, after: 150 });
  await page.keyboard.press("Meta+a");
  await typeSlow("Plate");
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(700);
  await apply({ op: "select", refs: [] }); // clicking the row selected the part; show its real colour
});
let downloaded = "";
await beat(
  "stl",
  async () => {
    const stl = page.locator(".export-btn", { hasText: "STL" });
    const dl = page.waitForEvent("download");
    await clickEl(stl, { ms: 700, after: 200 });
    const d = await dl;
    downloaded = d.suggestedFilename();
    await d.saveAs(`${OUT}/${downloaded}`);
    await tut("toast", [`<span style="font-size:24px">⬇</span><span><b>${downloaded}</b> downloaded</span>`, 3600]);
  },
  { gap: 700 },
);

// Outro
await beat(
  "basics",
  async () => {
    await apply({ op: "select", refs: [] }); // drop the selection tint for the closing shot
    await moveTo(1300, 760, 900);
  },
  { gap: 200 },
);
await beat("next", async () => {
  await tut("caption", [""]);
  await tut("card", [
    `<h1>Open <span>Poly</span></h1>
     <div class="tut-next" style="margin-top:14px">Next video</div>
     <h2>Run it locally, then model with Claude or any AI agent</h2>
     <div class="tut-url">open-poly.pages.dev &nbsp;·&nbsp; github.com/eitan27/open-poly</div>`,
    "tut-end",
  ]);
  await sleep(300);
  await tut("caption", [TEXT.next]);
});
await beat("bye", async () => {}, { gap: 900 });
await tut("caption", [""]);
await sleep(700);

await cdp.send("Page.stopScreencast");
await sleep(300);
const recEnd = Date.now() / 1000;
fs.writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ recStart, recEnd, marks, frames, downloaded }, null, 1));
console.log(`recorded ${frames.length} frames, ${(recEnd - recStart).toFixed(1)}s; downloaded ${downloaded}`);
await browser.close();
