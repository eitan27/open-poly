// A Transform can rotate about a picked line, not just a world axis.
//
// The distinction under test is the whole point of the feature: a world axis
// runs through the body's own centre, so the body SPINS on the spot; a picked
// sketch line or body edge is its own line, so the body HINGES around it and
// lands somewhere else. Both are checked by where the body ends up, plus the
// UI path that fills the axis slot and the guards that refuse a bad pick.
//
// Run: `npm run dev`, then `URL=http://localhost:5173/ node scripts/verify-transform-axis.mjs`.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });
const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 200; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const bboxOf = async (id) => (await read({ read: "sceneSummary" })).bodies.find((b) => b.id === id)?.bbox;

// --- 1. A world axis still spins the body on the spot ----------------------
const scene = await read({ read: "sceneSummary" });
const box = scene.bodies[0];
const start = box.bbox;
check("starting box sits on the ground", near(start.min[2], 0), JSON.stringify(start));

const spin = await apply({ op: "transform", targetId: box.id, angle: "90", axis: "z" });
await waitIdle();
const spun = await bboxOf(box.id);
check(
  "world Z spins in place — the body stays centred where it was",
  spun && near(spun.min[2], 0) && near(spun.max[2], start.max[2]),
  JSON.stringify(spun),
);
check(
  "…and the footprint swapped X for Y (it really did turn)",
  spun && near(spun.max[0], start.max[1]) && near(spun.max[1], start.max[0]),
  JSON.stringify(spun),
);
await apply({ op: "delete", featureId: spin.createdId });
await waitIdle();

// --- 2. A body edge HINGES the body around that edge -----------------------
// The bottom edge shared by the -y and -z faces: at y = min, z = 0, along X.
const edgeName = box.edges.find((e) => /\/-y∩.*\/-z$/.test(e) || /\/-z∩.*\/-y$/.test(e));
check("the box has a nameable bottom edge to hinge on", Boolean(edgeName), String(edgeName));
const hinge = await apply({
  op: "transform",
  targetId: box.id,
  angle: "90",
  axis: { bodyId: box.id, edgeName },
});
check("the hinge transform applied", hinge.ok, JSON.stringify(hinge));
await waitIdle();
const hinged = await bboxOf(box.id);
// Rotating 90° about that edge tips the box over: what was its height (z) is
// now its depth (y), and the edge itself — y = start.min[1], z = 0 — is the one
// line that cannot have moved.
check(
  "the hinge edge stayed put (z = 0 still touched)",
  hinged && near(hinged.max[2], 0, 1e-6),
  JSON.stringify(hinged),
);
check(
  "…the body swung BELOW the ground, which a spin could never do",
  hinged && hinged.min[2] < -1,
  JSON.stringify(hinged),
);
check(
  "…its height became its depth",
  hinged && near(hinged.max[2] - hinged.min[2], start.max[1] - start.min[1]),
  `${hinged?.max[2] - hinged?.min[2]} vs ${start.max[1] - start.min[1]}`,
);
check(
  "…and the edge's own y is still an extreme of the body",
  hinged && (near(hinged.min[1], start.min[1]) || near(hinged.max[1], start.min[1])),
  JSON.stringify(hinged),
);
const errs = (await read({ read: "sceneSummary" })).errors ?? {};
check("no feature errored", Object.keys(errs).length === 0, JSON.stringify(errs));

// --- 3. The reference survives a round trip through the document -----------
const doc = await read({ read: "document" });
const feat = doc.features.find((f) => f.id === hinge.createdId);
check(
  "the axis is stored as an edge reference, by persistent name",
  feat?.axis?.edge?.edgeName === edgeName,
  JSON.stringify(feat?.axis),
);
check(
  "…with a fingerprint to re-find it after a rename",
  Number.isFinite(feat?.axis?.edge?.length),
  JSON.stringify(feat?.axis?.edge),
);

// --- 4. A curved edge is refused, with a usable message --------------------
const cyl = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: "8", height: "10" } });
await waitIdle();
const withCyl = await read({ read: "sceneSummary" });
const cylBody = withCyl.bodies.find((b) => b.id === cyl.createdId);
const rim = cylBody?.edges?.find((e) => /rim|circle/i.test(e)) ?? cylBody?.edges?.[0];
if (rim) {
  const bad = await apply({
    op: "transform",
    targetId: box.id,
    angle: "45",
    axis: { bodyId: cylBody.id, edgeName: rim },
  });
  // A faceted cylinder's rim chords ARE straight, so this only has to not crash
  // and not produce a broken feature; a genuinely curved edge is rejected.
  check(
    "a rim-edge axis either works or is refused cleanly",
    bad.ok === true || typeof bad.error === "string",
    JSON.stringify(bad),
  );
  if (bad.ok) await apply({ op: "delete", featureId: bad.createdId });
  await waitIdle();
}
const missing = await apply({
  op: "transform",
  targetId: box.id,
  axis: { bodyId: cyl.createdId, edgeName: "no/such/edge" },
});
check(
  "an unknown edge name is a clear error, not a broken feature",
  missing.ok === false && /not found/i.test(missing.error ?? ""),
  JSON.stringify(missing),
);

// --- 5. The UI path: arm the axis slot and click an edge -------------------
await apply({ op: "delete", featureId: hinge.createdId });
await apply({ op: "delete", featureId: cyl.createdId });
await waitIdle();
await apply({ op: "select", refs: [{ kind: "feature", id: box.id }] });
await page.waitForTimeout(200);
await page
  .getByRole("button", { name: /transform/i })
  .first()
  .click();
const dialog = page.locator(".extrude-dialog");
await dialog.waitFor({ state: "visible", timeout: 5000 });
// Move the dialog clear of the viewport centre so the picks land on the body.
const hb = await dialog.locator("[data-drag-handle]").first().boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(1150, 700, { steps: 8 });
await page.mouse.up();
await dialog.getByRole("button", { name: "Rotate" }).click();
await page.waitForTimeout(300);
// ONE axis control, in two levels: a segmented pair picks the KIND of axis, and
// only that kind's detail is on screen (X/Y/Z, or the pick slot — never both).
// Buttons rather than a <select>: see the comment in App.tsx — a native popup
// menu swallows the first click of the pick this arms.
check("the axis control is buttons, not a dropdown", (await dialog.locator("select").count()) === 0);
const axisKind = dialog.locator(".ed-modes").nth(1);
const axisOptions = await axisKind.locator("button").allTextContents();
check("…offering the two kinds of axis, and only those", axisOptions.length === 2, axisOptions.join(" / "));
check(
  '…without saying "world", which would read as through the origin',
  !/world/i.test(axisOptions.join(" ")),
  axisOptions.join(" / "),
);
check(
  "…starting on the body-center axis",
  ((await axisKind.locator("button.active").textContent()) ?? "").includes("center"),
  (await axisKind.locator("button.active").textContent()) ?? "",
);
const alongRow = dialog.locator(".ed-modes").nth(2);
check("…showing X/Y/Z for it", await alongRow.isVisible(), (await alongRow.textContent()) ?? "");
check("…and no pick slot competing with them", (await dialog.locator(".ed-pick-btn").count()) === 0);
await alongRow.getByRole("button", { name: "Y" }).click();
await page.waitForTimeout(300);
const alongY = await read({ read: "document" });
check(
  "choosing Y sets the world direction through the center",
  alongY.features.filter((f) => f.type === "transform").at(-1)?.axis === "y",
  JSON.stringify(alongY.features.filter((f) => f.type === "transform").at(-1)?.axis),
);
await axisKind.getByRole("button", { name: "Line or edge" }).click();
await page.waitForTimeout(300);
check("switching to a picked axis puts X/Y/Z away", (await dialog.locator(".ed-modes").count()) === 2);
const banner = (await page.locator(".sketch-banner.pick span").textContent())?.trim() ?? "";
check("the pick banner names what counts as an axis", /sketch line|body edge/i.test(banner), banner);

// The box's front-bottom edge, around (778, 505) in the default iso view.
await page.mouse.move(778, 505);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(700);
const filled = await dialog.locator(".bool-operand-row").first().textContent();
check("clicking an edge fills the axis slot", /edge/i.test(filled ?? ""), String(filled));
check(
  "…and the kind stays on the picked axis",
  ((await axisKind.locator("button.active").textContent()) ?? "").includes("Line or edge"),
  (await axisKind.locator("button.active").textContent()) ?? "",
);
const uiDoc = await read({ read: "document" });
const uiFeat = uiDoc.features.filter((f) => f.type === "transform").at(-1);
check("…and stores it as an edge reference", Boolean(uiFeat?.axis?.edge?.edgeName), JSON.stringify(uiFeat?.axis));

// Dragging the ring writes an angle back into the dialog.
const angleInput = dialog.locator("input").first();
const before = (await angleInput.inputValue()).trim();
await page.mouse.move(742, 470);
await page.mouse.down();
for (let i = 1; i <= 16; i++) await page.mouse.move(742 + i * 3, 470 - i * 5);
await page.mouse.up();
await waitIdle();
const after = (await angleInput.inputValue()).trim();
check(
  "dragging the ring turns the body about the picked edge",
  Number(after) !== Number(before) && Number.isFinite(Number(after)),
  `${before} -> ${after}`,
);
const dragged = await read({ read: "document" });
const draggedFeat = dragged.features.filter((f) => f.type === "transform").at(-1);
check(
  "…and the feature holds the angle the gizmo showed",
  near(Number(draggedFeat?.angle), Number(after), 1e-6),
  `${draggedFeat?.angle} vs ${after}`,
);
const finalErrs = (await read({ read: "sceneSummary" })).errors ?? {};
check("still no feature errors", Object.keys(finalErrs).length === 0, JSON.stringify(finalErrs));

// Going back to the body-centre axis drops the picked one — the point of
// folding both into one control is that they can't both be in force.
await axisKind.getByRole("button", { name: "Body center" }).click();
await page.waitForTimeout(500);
check(
  "going back to the body center clears the picked axis",
  (await dialog.locator(".bool-operand-row").count()) === 0,
);
check("…and brings X/Y/Z back", await dialog.locator(".ed-modes").nth(2).isVisible());
const backToWorld = await read({ read: "document" });
const worldAxis = backToWorld.features.filter((f) => f.type === "transform").at(-1)?.axis;
check("…with the feature holding a world direction again", typeof worldAxis === "string", JSON.stringify(worldAxis));

// Re-arm one more time, for the gizmo's own behaviour while a pick is pending.
// Last, because the drag below orbits the camera (which is right — you must be
// able to swing the view around while choosing what to click).
await axisKind.getByRole("button", { name: "Line or edge" }).click();
await page.waitForTimeout(300);
// The gizmo must stand down while the pick is armed. Its handles are invisible
// donuts and cones several times fatter than what they draw — the rotate picker
// is a full torus around the pivot — so a live gizmo covers the very geometry
// the user has been asked to click, swallowing the press into a zero-distance
// drag: the click looks like it did nothing and only a second one, nudged clear
// of the handle, gets through. A drag straight across the pivot must therefore
// rotate nothing and leave the slot still waiting.
const angleWhileArmed = dialog.locator("input").first();
const armedAngle = (await angleWhileArmed.inputValue()).trim();
await page.mouse.move(843, 474);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(843 + i * 6, 474 - i * 4);
await page.mouse.up();
await page.waitForTimeout(500);
check(
  "a drag over the gizmo does nothing while a pick is armed",
  (await angleWhileArmed.inputValue()).trim() === armedAngle,
  `${armedAngle} -> ${(await angleWhileArmed.inputValue()).trim()}`,
);
check("…and the slot is still waiting for the pick", (await dialog.locator(".ed-pick-btn.active").count()) === 1);

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
