// Drives the Gear dialog end to end: the ghost appears on open, follows field
// edits, Create builds the body; a second gear meshes with the first (takes its
// module) and follows it when the first is resized; an internal gear builds.
// Screenshots go to $SHOTS (default: the OS temp dir).
//
//   URL=http://localhost:5180/ node scripts/verify-gear.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ deviceScaleFactor: 2 });
const op = openPoly(page);
const { check, done } = checker();
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `gear-${name}.png`) });

await op.newDocument();

const dialog = page.locator(".gear-dialog");
const fieldInput = (label) => dialog.locator(".ed-field", { hasText: label }).locator("input").first();
const fieldSelect = (label) => dialog.locator(".ed-field", { hasText: label }).locator("select").first();

async function openGear() {
  // The toolbar may have folded Gear into its overflow; the search-by-title
  // works either way.
  const btn = page.locator('button[title^="Gear ("]').first();
  if (await btn.isVisible().catch(() => false)) await btn.click();
  else {
    await page.locator('button[title*="More"]').first().click();
    await page.locator('[title^="Gear ("]').first().click();
  }
  await dialog.waitFor();
}

// 1. Open, by its shortcut (O): the ghost is there before touching anything.
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("o");
await dialog.waitFor({ timeout: 3000 });
await page.waitForTimeout(1500);
await shot("1-open");
check("dialog opens on the default plane", (await dialog.textContent()).includes("(default)"));
check("readout shows the default circles", (await dialog.textContent()).includes("Pitch Ø 40"));

// 2. Edit: teeth 12 → undercut note; profile shift clears it.
await fieldInput("Teeth").fill("12");
await page.waitForTimeout(800);
check("readout follows teeth", (await dialog.textContent()).includes("Pitch Ø 24"));
check("undercut is flagged at 12 teeth", /undercut/i.test(await dialog.textContent()));
await dialog.locator(".gear-advanced-toggle").click();
await fieldInput("Profile shift").fill("0.4");
await page.waitForTimeout(800);
check("profile shift clears the undercut note", !/undercut/i.test(await dialog.textContent()));
await fieldInput("Profile shift").fill("0");
await fieldInput("Teeth").fill("20");
await fieldSelect("Bore").selectOption("dflat");
await page.waitForTimeout(1200);
await shot("2-dflat");

// A bad value: error, Create disabled.
await fieldInput("Bore Ø").fill("50");
await page.waitForTimeout(500);
check("an oversize bore is refused", /root diameter/.test(await dialog.textContent()));
check("Create is disabled while it's refused", await dialog.locator(".ed-primary").isDisabled());
await fieldInput("Bore Ø").fill("5");
await fieldInput("Across flat").fill("4.5");
await page.waitForTimeout(500);

await dialog.locator(".ed-primary").click();
await op.settle();
let feats = await op.features();
const gear1 = feats.find((f) => f.type === "gear");
check("Create adds a gear feature", !!gear1, JSON.stringify(feats.map((f) => f.type)));
check("the gear builds without error", (await op.featureErrors()).length === 0, (await op.featureErrors()).join("; "));
check("one body", (await op.bodyCount()) === 1);
await shot("3-created");

// The bore's walls carry fixed names (bore0…, boreFlat), not side numbers that
// move with the tooth count.
const faceNames = async (id) => {
  const sc = await op.scene();
  const body = sc.bodies.find((b) => b.id === id);
  // The summary folds numbered runs ("<id>/bore{n} (n = 0–77)"); unfold them.
  return (body?.faces ?? []).flatMap((f) => {
    const m = /^(.*)\{n\} \(n = (.*)\)$/.exec(f);
    if (!m) return [f];
    return m[2].split(", ").flatMap((r) => {
      const [lo, hi = lo] = r.split("–").map(Number);
      return Array.from({ length: hi - lo + 1 }, (_, i) => `${m[1]}${lo + i}`);
    });
  });
};
let names = await faceNames(gear1.id);
check("bore walls are named bore<n>", names.includes(`${gear1.id}/bore0`), names.slice(0, 5).join(", "));
check("the D-flat's flat is named boreFlat", names.includes(`${gear1.id}/boreFlat`));
await op.apply({ op: "setParam", featureId: gear1.id, name: "teeth", value: "23" });
await op.settle();
names = await faceNames(gear1.id);
check(
  "bore names survive a tooth-count change",
  names.includes(`${gear1.id}/bore0`) && names.includes(`${gear1.id}/boreFlat`),
);
await op.apply({ op: "setParam", featureId: gear1.id, name: "teeth", value: "20" });
await op.settle();

// 3. A second gear meshing with the first, moved over by the centre distance.
await openGear();
await fieldInput("Teeth").fill("31");
await fieldSelect("Size by").selectOption({ label: gear1.name });
await page.waitForTimeout(600);
const text = await dialog.textContent();
check("meshed gear shows the partner's module", /Module 2 mm/.test(text), text.slice(0, 200));
check("and the center distance, on its own line", /Center distance between gears 51 mm/.test(text));
// Meshing places it beside its partner by default: no Centre X, no Rotation.
check("Place beside is on once it meshes", await dialog.locator(".gear-place-beside").isChecked());
await fieldInput("Angle").fill("0");
await page.waitForTimeout(1200);
await shot("4-pair-ghost");
await dialog.locator(".ed-primary").click();
await op.settle();
check("two bodies", (await op.bodyCount()) === 2);
check("pair builds without error", (await op.featureErrors()).length === 0, (await op.featureErrors()).join("; "));
await shot("5-pair");

// 4. Resizing gear 1 carries to gear 2 (module follows).
feats = await op.features();
const gear2 = feats.filter((f) => f.type === "gear")[1];
await op
  .apply({ op: "setParam", featureId: gear1.id, name: "module", value: "1.5" })
  .catch((e) => ({ err: String(e) }));
await op.settle();
const scene = await op.scene();
const bb = (id) => scene.bodies.find((b) => b.id === id)?.bbox;
const b2 = bb(gear2.id);
if (b2) {
  const width = b2.max[0] - b2.min[0];
  // 31 teeth × 1.5 + 2 × 1.5 addendum = 49.5 across the tips.
  check("gear 2 follows gear 1's module", Math.abs(width - 49.5) < 0.6, `width=${width}`);
  // …and stays beside it: 1.5 × (20 + 31) / 2 = 38.25 from gear 1's centre.
  const b1 = bb(gear1.id);
  const centre = (b) => (b.min[0] + b.max[0]) / 2;
  const gap = centre(b2) - centre(b1);
  check("…and moves to stay beside it", Math.abs(gap - 38.25) < 0.6, `centres ${gap.toFixed(2)} apart`);
} else check("gear 2 has a bbox in the scene summary", false, JSON.stringify(scene.bodies?.[1] ?? {}).slice(0, 200));

// 5. An internal gear.
await op.newDocument();
await openGear();
await fieldSelect("Type").selectOption("internal");
await fieldInput("Teeth").fill("60");
await page.waitForTimeout(1500);
await shot("6-ring-ghost");
await dialog.locator(".ed-primary").click();
await op.settle();
check(
  "ring gear builds",
  (await op.bodyCount()) === 1 && (await op.featureErrors()).length === 0,
  (await op.featureErrors()).join("; "),
);
await shot("7-ring");
{
  const ringId = (await op.features()).find((f) => f.type === "gear").id;
  const n = await faceNames(ringId);
  check("the ring's rim walls are named rim<n>", n.includes(`${ringId}/rim0`), n.slice(0, 5).join(", "));
}

// 6. Double-click the timeline row re-opens it for editing.
await page.locator(".tree-row", { hasText: "Gear 1" }).first().dblclick();
await dialog.waitFor();
check("edit re-opens with its settings", (await fieldInput("Teeth").inputValue()) === "60");
await fieldInput("Teeth").fill("48");
await page.waitForTimeout(400);
await dialog.locator(".ed-primary").click();
await op.settle();
const ring = (await op.features()).find((f) => f.type === "gear");
check("edit applies", ring?.params?.teeth === "48", JSON.stringify(ring?.params));

// The dev server proxies /api/drive to a Pages Function that isn't running
// locally; its 502s are environment noise, not the gear's.
const real = errors.filter((e) => !/502|Bad Gateway/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
await close();
done();
