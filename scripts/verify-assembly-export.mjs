// Assemblies: Export. A base and two instances of one arm part (plus a hidden
// third, left out), exported through the Instances header's Export menu all
// three ways: a 3MF with each visible instance a separate, coloured object
// where it sits (read back with three.js's own 3MFLoader too), one merged STL,
// and a zip of one STL per distinct part with its count in the name. Built
// through the agent bridge for speed; the export is the UI's. NB if the local
// open-poly MCP hub is running, this headless tab connects to it and can take
// the bridge from your own tab; reload yours after.
import { strFromU8, unzipSync } from "fflate";
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
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const summary = () => read({ read: "sceneSummary" });

const doc0 = await read({ read: "document" });
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await apply({ op: "renameDocument", name: "ExportBase" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await apply({ op: "newDocument", name: "ExportArm" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } });
await waitIdle();
await apply({ op: "newDocument", name: "Export test", kind: "assembly" });
await waitIdle();
const docs = await read({ read: "documents" });
const idOf = (name) => docs.find((d) => d.name === name)?.id;
await apply({ op: "insertInstance", documentId: idOf("ExportBase") });
await apply({ op: "insertInstance", documentId: idOf("ExportArm"), name: "Arm A" });
await apply({ op: "insertInstance", documentId: idOf("ExportArm"), name: "Arm B" });
const hidden = await apply({ op: "insertInstance", documentId: idOf("ExportArm"), name: "Arm hidden" });
let s = await summary();
const [base, armA] = s.instances;
const top = s.parts.find((p) => p.key === base.part).faces.find((f) => f.endsWith("/+z"));
const bottom = s.parts.find((p) => p.key === armA.part).faces.find((f) => f.endsWith("/-z"));
// Seat Arm A on the base, so its exported place is the solved one.
await apply({
  op: "addMate",
  type: "fastened",
  a: { instanceId: base.id, face: top },
  b: { instanceId: armA.id, face: bottom },
});
// Hide the fourth from the panel (its eye).
await page.locator(".asm-row").nth(3).locator('.row-icon[title="Hide"]').click();
await page.waitForTimeout(500);
s = await summary();
check("the fourth arm is hidden", s.instances.find((i) => i.id === hidden.createdId)?.hidden === true);

const exportVia = async (kind) => {
  await page.locator(".asm-export-btn").click();
  const [d] = await Promise.all([
    page.waitForEvent("download", { timeout: 30000 }),
    page.locator(`.asm-export-menu .asm-export-${kind}`).click(),
  ]);
  const fs = await import("node:fs");
  return { name: d.suggestedFilename(), bytes: fs.readFileSync(await d.path()) };
};

// --- 3MF --------------------------------------------------------------------------------
await page.locator(".asm-export-btn").click();
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/export-menu.png` });
check("the menu offers the three exports", (await page.locator(".asm-export-menu button").count()) === 3);
await page.keyboard.press("Escape");
const mf = await exportVia("3mf");
const files = unzipSync(new Uint8Array(mf.bytes));
const model = strFromU8(files["3D/3dmodel.model"]);
const objects = [...model.matchAll(/<object id="\d+" type="model" name="([^"]+)"/g)].map((m) => m[1]);
check("3MF: named after the assembly", mf.name === "Export test.3mf", mf.name);
check(
  "…each visible instance a separate object, the hidden one left out",
  objects.join("|") === "Box 1 &lt;1&gt;|Arm A|Arm B",
  objects.join("|"),
);
const vertexCounts = model
  .split("<object ")
  .slice(1)
  .map((o) => (o.match(/<vertex /g) ?? []).length);
check(
  "…each a closed, welded box (8 corners)",
  vertexCounts.every((n) => n === 8),
  vertexCounts.join(","),
);
// Arm A sits on the base's top: its lowest z is the base's 10 mm.
const armAObj = model.split('name="Arm A"')[1].split("</object>")[0];
const zs = [...armAObj.matchAll(/<vertex x="[-\d.]+" y="[-\d.]+" z="([-\d.]+)"/g)].map((m) => Number(m[1]));
check("…where the mates put it", Math.abs(Math.min(...zs) - 10) < 1e-3, `min z ${Math.min(...zs)}`);
// Read back by an independent 3MF reader: three.js's own loader, in the page.
const loaded = await page.evaluate(async (b64) => {
  const { ThreeMFLoader } = await import("/node_modules/three/examples/jsm/loaders/3MFLoader.js");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const group = new ThreeMFLoader().parse(bytes.buffer);
  const meshes = [];
  group.traverse((o) => o.isMesh && meshes.push(o.geometry.getAttribute("position").count));
  return meshes;
}, Buffer.from(mf.bytes).toString("base64"));
check("…and three.js's 3MFLoader reads it: three meshes", loaded.length === 3, JSON.stringify(loaded));

// --- STL, assembled ------------------------------------------------------------------------
const stl = await exportVia("stl");
const count = stl.bytes.readUInt32LE(80);
check(
  "STL: one file, every visible part merged (3 boxes × 12 triangles)",
  stl.name === "Export test.stl" && count === 36 && stl.bytes.length === 84 + 50 * 36,
  `${stl.name}, ${count} triangles`,
);

// --- STL, each part once -------------------------------------------------------------------
const zip = await exportVia("stl-parts");
const parts = unzipSync(new Uint8Array(zip.bytes));
const names = Object.keys(parts).sort();
check(
  "Parts: a zip of one STL per distinct part, the arm counted ×2",
  zip.name === "Export test parts.zip" && names.join("|") === "Box 1 ×2.stl|Box 1.stl",
  `${zip.name}: ${names.join(", ")}`,
);
const armStl = Buffer.from(parts["Box 1 ×2.stl"]);
const xs = [];
for (let t = 0; t < armStl.readUInt32LE(80); t++)
  for (let v = 0; v < 3; v++) xs.push(armStl.readFloatLE(84 + 50 * t + 12 + 12 * v));
check(
  "…each in its own coordinates (the arm 30 mm long, not where it sits)",
  Math.abs(Math.max(...xs) - Math.min(...xs) - 30) < 1e-3 && Math.abs(Math.max(...xs) - 15) < 1e-3,
  `x ${Math.min(...xs)}..${Math.max(...xs)}`,
);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
