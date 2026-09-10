// Extrude's two silent-failure guards: a degenerate DISTANCE, and a TARGET that
// isn't there.
//
// Distance: `prismFromFace` passed the evaluated value straight to MakePrism, so
// 0 surfaced as a raw OCCT exception (a decoded type name + a heap pointer) and a
// NEGATIVE value silently built the body backwards. Validation now lives on the
// resolve path (every route into the document shares it) plus a synchronous check
// in the dialog, mirroring the dress-up and Shell fields.
//
// Target: a `remove` whose target resolved to no body deleted its cut tool
// silently — no error, no visible effect. The dialog can't produce that (Create
// is gated on a target), but a target that disappears AFTER the fact can:
// deleted, suppressed, reordered above the extrude, or merged into another body
// by an earlier boolean. The worker now fails the feature instead.
//
// Checks, in order:
//   1-2. agent addExtrude with distance 0 / negative → a readable error, no body
//   3.   a positive distance still builds
//   4-7. the dialog disables Create on a bad distance and says why, re-enabling
//        on a good one — with no raw OCCT text on screen
//   8.   a remove whose target is deleted fails the feature instead of vanishing
//   9.   a remove with no target at all is refused
import { chromium } from "playwright";
const URL = process.env.URL ?? "http://localhost:5175/";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await (await browser.newContext({ viewport: { width: 1660, height: 920 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__openpoly, null, { timeout: 30000 });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 250; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error|fail/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return s;
    await page.waitForTimeout(300);
  }
  return "TIMEOUT";
};
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const scene = () => read({ read: "sceneSummary" });
const bodyCount = async () => ((await scene()).bodies ?? []).length;

await waitIdle();

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// A 40x40 square on the front datum: one closed region to extrude.
const sk = await apply({
  op: "addSketch",
  plane: { datum: "front" },
  entities: [{ shape: "rect", center: [0, 0], w: 40, h: 40 }],
});
await waitIdle();
const before = await bodyCount();

for (const [label, distance] of [
  ["zero", 0],
  ["negative", -8],
]) {
  const r = await apply({ op: "addExtrude", profile: { sketchId: sk.createdId }, distance });
  await waitIdle();
  const after = await bodyCount();
  const msg = String(r?.error ?? r?.message ?? "");
  const readable = /greater than zero|greater than 0/i.test(msg);
  const raw = /OCCT|Standard_|exception \d/i.test(msg);
  check(
    `agent addExtrude distance ${label} is refused readably`,
    (r?.ok === false || readable) && !raw && after === before,
    `error=${JSON.stringify(msg).slice(0, 90)} bodies ${before}→${after}`,
  );
  // Undo whatever the failed op left in the timeline, so the next case starts clean.
  const doc = await read({ read: "document" });
  const ex = (doc.features ?? []).filter((f) => f.type === "extrude");
  for (const f of ex) await apply({ op: "delete", featureId: f.id });
  await waitIdle();
}

{
  const r = await apply({ op: "addExtrude", profile: { sketchId: sk.createdId }, distance: 12 });
  await waitIdle();
  check(
    `a positive distance still builds`,
    r?.ok !== false && (await bodyCount()) === before + 1,
    `bodies=${await bodyCount()}`,
  );
  const doc = await read({ read: "document" });
  for (const f of (doc.features ?? []).filter((f) => f.type === "extrude"))
    await apply({ op: "delete", featureId: f.id });
  await waitIdle();
}

// --- The dialog ---------------------------------------------------------
// Select the sketch's region and open Extrude, then drive the Distance field.
const region = (await scene()).sketches?.find((x) => x.id === sk.createdId)?.regions?.[0];
await apply({
  op: "select",
  refs: [{ kind: "sketchFace", sketchId: sk.createdId, regionId: region?.id ?? "r0" }],
}).catch((e) => console.log("select failed:", String(e).slice(0, 120)));
await page.waitForTimeout(300);
const extrudeBtn = page.locator('button[title*="Extrude" i], button:has-text("Extrude")').first();
await extrudeBtn.click();
await page.waitForTimeout(700);

const dialog = page
  .locator(".dialog, .ed, [role=dialog]")
  .filter({ has: page.locator("text=Distance") })
  .first();
const distanceInput = page.locator(".ed-field:has(span:text-is('Distance')) input").first();
const createBtn = page.locator("button.ed-primary").first();

if ((await distanceInput.count()) === 0) {
  check("extrude dialog opened with a Distance field", false, "field not found — dialog markup changed?");
} else {
  await distanceInput.fill("0");
  await page.waitForTimeout(400);
  const disabled = await createBtn.isDisabled();
  const warning = ((await page.locator(".ed-warning").allTextContents()) ?? []).join(" ");
  check(
    "dialog disables Create on a 0 distance and says why",
    disabled && /greater than 0/i.test(warning),
    `disabled=${disabled} warning=${JSON.stringify(warning).slice(0, 80)}`,
  );
  check("no raw OCCT text is shown to the user", !/OCCT|Standard_|exception \d/i.test(warning), warning.slice(0, 60));

  await distanceInput.fill("-3");
  await page.waitForTimeout(400);
  check("negative is refused too", await createBtn.isDisabled());

  await distanceInput.fill("15");
  await page.waitForTimeout(700);
  const enabled = !(await createBtn.isDisabled());
  const cleared = ((await page.locator(".ed-warning").allTextContents()) ?? []).join(" ");
  check(
    "a good distance re-enables Create and clears the message",
    enabled && !/greater than 0/i.test(cleared),
    `enabled=${enabled} warning=${JSON.stringify(cleared).slice(0, 60)}`,
  );
}

// --- The target guard ---------------------------------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
{
  // A box to cut, and a small square sketched on its face's plane to cut with.
  const box = await apply({ op: "addPrimitive", kind: "box", params: { width: 40, depth: 40, height: 40 } });
  await waitIdle();
  const cutSketch = await apply({
    op: "addSketch",
    plane: { datum: "top" },
    entities: [{ shape: "rect", center: [0, 0], w: 10, h: 10 }],
  });
  await waitIdle();
  const cut = await apply({
    op: "addExtrude",
    profile: { sketchId: cutSketch.createdId },
    distance: 60,
    mode: "remove",
    targetId: box.createdId,
    flip: true,
  });
  const built = await waitIdle();
  check("a remove with a live target builds", cut?.ok !== false && !/error|fail/i.test(built), `status=${built}`);

  // Now pull the target out from under it.
  const del = await apply({ op: "delete", featureId: box.createdId });
  await waitIdle();
  const errs = del?.featureErrors ?? (await read({ read: "document" }))?.featureErrors ?? {};
  const msg = String(errs[cut.createdId] ?? "");
  const shown = ((await page.locator(".tree-row.error").allTextContents()) ?? []).join(" ");
  check(
    "a remove whose target was deleted fails loudly instead of vanishing",
    /target body no longer exists/i.test(msg) || /error/i.test(await waitIdle()),
    `featureError=${JSON.stringify(msg).slice(0, 90)} timelineErrorRows=${JSON.stringify(shown).slice(0, 40)}`,
  );

  const doc = await read({ read: "document" });
  for (const f of (doc.features ?? []).filter((f) => f.type === "extrude"))
    await apply({ op: "delete", featureId: f.id });
  await waitIdle();

  // A remove with no target at all — only the agent can ask for this.
  const orphan = await apply({
    op: "addExtrude",
    profile: { sketchId: cutSketch.createdId },
    distance: 20,
    mode: "remove",
  });
  await waitIdle();
  const oErrs = orphan?.featureErrors ?? {};
  const oMsg = String(orphan?.error ?? oErrs[orphan?.createdId] ?? "");
  check(
    "a remove with no target is refused, not silently dropped",
    /needs a target body/i.test(oMsg),
    `error=${JSON.stringify(oMsg).slice(0, 90)}`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
