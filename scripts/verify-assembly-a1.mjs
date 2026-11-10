// Assemblies A1: inserting instances of parts from other documents, drawing
// them from the parts' saved builds, picking, moving one with the gizmo,
// grounding, hiding, removing, live references to an edited part, the
// "unbuilt" path (a part never built on this device), and the delete warning.
// NB if the local open-poly MCP hub is running, this headless tab connects to
// it ("Agent connected" in the screenshots) and can take the bridge from your
// own tab; reload yours afterwards.
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
/** The open document's saved record, straight from IndexedDB (after the
 *  autosave debounce). */
const savedRecord = async () => {
  await page.waitForTimeout(900);
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const id = localStorage.getItem("openpoly.activeDocId");
        const req = indexedDB.open("open-poly");
        req.onsuccess = () => {
          const get = req.result.transaction("documents").objectStore("documents").get(id);
          get.onsuccess = () => resolve(get.result);
        };
      }),
  );
};
const rows = () => page.locator(".asm-row .solid-name").evaluateAll((els) => els.map((e) => e.value));
const insertFrom = async (docName, parts = null) => {
  await page.locator(".asm-insert").click();
  await page.locator(".insert-doc", { hasText: docName }).click();
  await page.locator(".insert-confirm").waitFor({ timeout: 30000 });
  if (parts) {
    for (const label of await page.locator(".insert-parts label").all()) {
      const name = (await label.textContent())?.trim();
      if (!parts.includes(name)) await label.locator("input").uncheck();
    }
  }
  await page.locator(".insert-confirm").click();
  await page.waitForTimeout(400);
};
/** A document switch lands a few hundred ms after its click, while the status
 *  still reads "up to date": wait for the title to stop being `was` before
 *  acting on the new document (or a rename lands on the old one). */
const switchedFrom = async (was) => {
  await page.waitForFunction((t) => document.querySelector(".doc-title")?.value !== t, was, { timeout: 10000 });
  await waitIdle();
};
/** Screen point of a world point, in CSS px relative to the page. */
const toScreen = async (p) => {
  const box = await page.locator(".viewport canvas").first().boundingBox();
  const s = await page.evaluate((q) => window.__openpoly.worldToScreen(q), p);
  return { x: box.x + s.x, y: box.y + s.y };
};

// --- Two part documents --------------------------------------------------
// "Bracket": one 20 mm box. "Pair": a box and a cylinder (two parts).
const doc0 = await page.evaluate(() => window.__openpoly.read({ read: "document" }));
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await rename("Bracket");
await apply({ op: "addPrimitive", kind: "box", params: { width: "20", depth: "20", height: "20" } });
await waitIdle();
await page.locator(".newdoc-btn").click();
await switchedFrom("Bracket");
await rename("Pair");
await apply({ op: "addPrimitive", kind: "box" });
await apply({ op: "addPrimitive", kind: "cylinder" });
await waitIdle();

// --- An assembly ---------------------------------------------------------
await page.locator(".split-btn-caret").click();
await page.locator(".split-btn .mt-menu button", { hasText: "Assembly" }).click();
await switchedFrom("Pair");
await rename("Arm");

await page.locator(".asm-insert").click();
const listed = await page.locator(".insert-doc .docs-name").allTextContents();
check("Insert lists the part documents", listed.includes("Bracket") && listed.includes("Pair"), listed.join(" | "));
check("…and no assemblies", !listed.includes("Arm"));
await page.keyboard.press("Escape");

await insertFrom("Bracket");
check("inserting a part places one instance", (await rows()).length === 1, (await rows()).join(" | "));
const first = (await rows())[0];
check("named after the part, numbered", /<1>$/.test(first), first);
check(
  "the first instance is grounded",
  (await page.locator(".asm-row").first().locator(".asm-ground.active").count()) === 1,
);
await page.screenshot({ path: "/tmp/asm-a1-one.png" });

await insertFrom("Bracket");
check("a second copy is numbered <2>", (await rows())[1]?.endsWith("<2>"), (await rows()).join(" | "));
let rec = await savedRecord();
const t2 = rec.assembly.instances[1].transform;
check("the second copy lands beside the first, not inside it", t2[12] === 30, `x = ${t2[12]}`);
check("and isn't grounded", !rec.assembly.instances[1].grounded);

await insertFrom("Pair", ["Cylinder 1"]);
rec = await savedRecord();
const t3 = rec.assembly.instances[2].transform;
check("a part from another document lands past what's placed, not on top", t3[12] > 30, `x = ${t3[12]}`);
check(
  "choosing one part of a multi-part document inserts just that",
  (await rows()).length === 3,
  (await rows()).join(" | "),
);
await page.screenshot({ path: "/tmp/asm-a1-three.png" });

// --- Picking + moving ----------------------------------------------------
// Click the second copy in the viewport: the Bracket box's own centre (read
// off its saved build), moved by that copy's placement.
await page.keyboard.press("Escape");
const boxCentre = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("open-poly");
      req.onsuccess = () => {
        req.result.transaction("documents").objectStore("documents").getAll().onsuccess = (e) => {
          const v = e.target.result.find((r) => r.name === "Bracket").meshes[0].mesh.faces.vertices;
          const lo = [Infinity, Infinity, Infinity];
          const hi = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < v.length; i += 3)
            for (let k = 0; k < 3; k++) {
              lo[k] = Math.min(lo[k], v[i + k]);
              hi[k] = Math.max(hi[k], v[i + k]);
            }
          resolve(lo.map((l, k) => (l + hi[k]) / 2));
        };
      };
    }),
);
const c2 = await toScreen([boxCentre[0] + t2[12], boxCentre[1] + t2[13], boxCentre[2] + t2[14]]);
await page.mouse.click(c2.x, c2.y);
await page.waitForTimeout(300);
const selRow = await page
  .locator(".asm-row.selected .solid-name")
  .inputValue()
  .catch(() => "");
check("clicking an instance in the viewport selects it", selRow.endsWith("<2>"), selRow);
check("the Move panel opens on it", (await page.locator(".asm-move").count()) === 1);

// Drag the gizmo's centre handle (it moves in the view plane).
const before = (await savedRecord()).assembly.instances[1].transform.slice(12, 15);
await page.mouse.move(c2.x, c2.y);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(c2.x + i * 12, c2.y, { steps: 2 });
await page.mouse.up();
await page.waitForTimeout(300);
const after = (await savedRecord()).assembly.instances[1].transform.slice(12, 15);
const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
check("dragging the gizmo moves the instance", moved > 5, `moved ${moved.toFixed(1)} mm`);
await page.screenshot({ path: "/tmp/asm-a1-moved.png" });

// Undo puts it back.
await page.keyboard.press("Meta+z");
const undone = (await savedRecord()).assembly.instances[1].transform.slice(12, 15);
check(
  "undo puts it back",
  undone.every((v, i) => Math.abs(v - before[i]) < 1e-6),
  undone.join(","),
);

// A grounded instance has no gizmo, only the unground offer.
await page.locator(".asm-row").first().click();
check(
  "a grounded instance offers Unground instead of a gizmo",
  (await page.locator(".asm-move", { hasText: "Unground" }).count()) === 1,
);

// --- Hide, remove --------------------------------------------------------
await page.locator(".asm-row").nth(2).locator(".row-icon[title='Hide']").click();
rec = await savedRecord();
check("hide is saved on the instance", rec.assembly.instances[2].hidden === true);
await page.locator(".asm-row").nth(2).locator(".row-icon[title='Remove from the assembly']").click();
check("✕ removes the instance", (await rows()).length === 2);

// --- Live reference: edit the part, come back ----------------------------
await page.locator(".asm-row").first().dblclick();
await switchedFrom("Arm");
check("double-clicking a row opens its source part", (await page.locator(".doc-title").inputValue()) === "Bracket");
const box = (await page.evaluate(() => window.__openpoly.read({ read: "document" }))).features[0];
await apply({ op: "setParam", featureId: box.id, name: "height", value: "60" });
await waitIdle();
await page.waitForTimeout(900);
await page.locator(".docs-btn").click();
await page.locator(".docs-row", { hasText: "Arm" }).locator(".text-btn", { hasText: "Open" }).click();
await switchedFrom("Bracket");
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/asm-a1-live.png" });
check("back in the assembly", (await rows()).length === 2);

// --- Delete warning ------------------------------------------------------
await page.locator(".docs-btn").click();
await page.locator(".docs-tabs button", { hasText: "All" }).click();
const bracketRow = page.locator(".docs-row", { hasText: "Bracket" }).first();
await bracketRow.locator(".text-btn", { hasText: "Delete" }).click();
const used = await bracketRow
  .locator(".docs-used")
  .textContent()
  .catch(() => "");
check("deleting a part an assembly uses names the assembly", /Used in Arm/.test(used ?? ""), used ?? "");
await page.keyboard.press("Escape");

// --- Unbuilt source: a part document with no saved build -------------------
// Strip the Pair record's meshes, as a document downloaded from Drive has
// none, then insert from it: it must build through the kernel.
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("open-poly");
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction(["documents", "meta"], "readwrite");
        const docs = t.objectStore("documents");
        const meta = t.objectStore("meta");
        docs.getAll().onsuccess = (e) => {
          for (const r of e.target.result) {
            if (r.name !== "Pair") continue;
            delete r.meshes;
            docs.put(r);
            meta.get(r.id).onsuccess = (m) => meta.put({ ...m.target.result, unbuilt: true, partCount: 0 });
          }
        };
        t.oncomplete = () => resolve();
      };
    }),
);
await insertFrom("Pair");
check("an unbuilt part document builds and inserts", (await rows()).length === 4, (await rows()).join(" | "));
const pairSaved = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const req = indexedDB.open("open-poly");
      req.onsuccess = () => {
        req.result.transaction("documents").objectStore("documents").getAll().onsuccess = (e) =>
          resolve(e.target.result.find((r) => r.name === "Pair")?.meshes?.length ?? 0);
      };
    }),
);
check("…and its build is saved back to it", pairSaved === 2, `${pairSaved} meshes`);

// --- Reload: everything comes back --------------------------------------
await page.reload({ waitUntil: "domcontentloaded" });
await waitIdle();
await page.waitForTimeout(800);
check("after reload the instances are all there", (await rows()).length === 4, (await rows()).join(" | "));
await page.screenshot({ path: "/tmp/asm-a1-reload.png" });

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
