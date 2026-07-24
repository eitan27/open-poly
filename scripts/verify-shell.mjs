// Throwaway verification for the new Shell feature: hollows a body via OCCT
// BRepOffsetAPI_MakeThickSolid, propagating face names through the op.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({
  viewport: { width: 1660, height: 920 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });

await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 80; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// --- 1. Basic shell: remove the top face of a box, keep outer dimensions ---
const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 30, height: 20 } });
check("box created", box.ok, JSON.stringify(box).slice(0, 200));
const boxId = box.createdId;

let scene = await read({ read: "sceneSummary" });
let boxBody = scene.bodies.find((b) => b.id === boxId);
check("box has 6 named faces before shelling", (boxBody?.faces ?? []).length === 6, JSON.stringify(boxBody?.faces));
const topFace = boxBody.faces.find((f) => f.includes("+z"));
check("top face is named", Boolean(topFace), JSON.stringify(boxBody?.faces));

const shell = await apply({ op: "shell", targetId: boxId, faces: [topFace], thickness: 2 });
check("shell op succeeds", shell.ok, JSON.stringify(shell).slice(0, 300));
await waitIdle();

scene = await read({ read: "sceneSummary" });
boxBody = scene.bodies.find((b) => b.id === boxId);
check("body still present after shell", Boolean(boxBody), JSON.stringify(scene.bodies?.map((b) => b.id)));
check(
  "outer bbox unchanged (wall grows inward)",
  boxBody &&
    Math.abs(boxBody.bbox.max[0] - boxBody.bbox.min[0] - 40) < 1e-6 &&
    Math.abs(boxBody.bbox.max[1] - boxBody.bbox.min[1] - 30) < 1e-6 &&
    Math.abs(boxBody.bbox.max[2] - boxBody.bbox.min[2] - 20) < 1e-6,
  JSON.stringify(boxBody?.bbox),
);
check("removed face is gone from the name list", !boxBody.faces.includes(topFace), JSON.stringify(boxBody.faces));
check(
  "new inner-wall faces appeared (named '<face>/in')",
  boxBody.faces.some((f) => f.endsWith("/in")),
  JSON.stringify(boxBody.faces),
);
check("face count grew (opening removed one, offset added several)", boxBody.faces.length > 5, JSON.stringify(boxBody.faces));

// --- 2. Sealed shell (no faces removed) on a fresh cylinder ---
const cyl = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: 10, height: 20 } });
check("cylinder created", cyl.ok, JSON.stringify(cyl).slice(0, 200));
const sealed = await apply({ op: "shell", targetId: cyl.createdId, thickness: 1.5 });
check("sealed shell (no faces removed) succeeds", sealed.ok, JSON.stringify(sealed).slice(0, 300));
await waitIdle();

// --- 3. Edit in place: re-open with a different thickness via updateShell path ---
const doc1 = await read({ read: "document" });
const shellFeature = doc1.features.find((f) => f.id === shell.createdId);
check("shell feature persisted with thickness + faces", shellFeature?.thickness === "2" && shellFeature.faces.length === 1, JSON.stringify(shellFeature));
const reset = await apply({ op: "setParam", featureId: shell.createdId, name: "thickness", value: "3" });
check("setParam updates shell thickness", reset.ok, JSON.stringify(reset).slice(0, 200));
await waitIdle();
scene = await read({ read: "sceneSummary" });
boxBody = scene.bodies.find((b) => b.id === boxId);
check("body still valid after thickness edit", Boolean(boxBody) && !scene.errors?.[shell.createdId], JSON.stringify(scene.errors));

// --- 4. Bad reference: a bogus face name errors descriptively, doesn't corrupt the body ---
const bad = await apply({ op: "shell", targetId: cyl.createdId, faces: ["nope/xx"], thickness: 1 });
check(
  "bogus face name errors descriptively",
  !bad.ok && /re-found|re-pick/.test(JSON.stringify(bad)),
  JSON.stringify(bad).slice(0, 250),
);

// --- 5. Too-thick a wall fails cleanly (not a crash) ---
const tooThick = await apply({ op: "addPrimitive", kind: "box", params: { width: 10, depth: 10, height: 10 } });
const failThick = await apply({ op: "shell", targetId: tooThick.createdId, faces: [], thickness: 20 });
check(
  "an impossible thickness reports a build error, not ok:true",
  failThick.ok === false,
  JSON.stringify(failThick).slice(0, 250),
);

await page.screenshot({ path: "/tmp/openpoly-shell.png" });
console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
console.log("screenshot: /tmp/openpoly-shell.png");
await browser.close();
process.exit(failures === 0 ? 0 : 1);
