// Verifies DXF import end-to-end against the running dev app: pick a DXF via the
// Parts "Import ▾" flyout, confirm the placement dialog, and check that a native
// sketch with the expected editable entities is created on the chosen plane.
import { launch, openPoly } from "./lib/harness.mjs";

const { page, close } = await launch({ deviceScaleFactor: 2, collectErrors: false });
const { waitIdle, apply, read } = openPoly(page);
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(__dirname, "sample.dxf");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await apply({ op: "newDocument" });
await waitIdle();

// --- Open the Import flyout and choose "DXF sketch…" -----------------------
await page.locator(".parts-import > button").click();
await page.waitForTimeout(150);
check(
  "Import flyout shows a DXF option",
  (await page.locator(".mt-menu button", { hasText: "DXF sketch" }).count()) > 0,
);
// Feed the hidden DXF file input (clicking the menu item just opens the picker).
await page.setInputFiles('input[accept=".dxf,.DXF"]', SAMPLE);
await page.waitForTimeout(300);

// --- The placement dialog appears with a parse preview ---------------------
const dialog = page.locator(".feature-dialog", { hasText: "Import DXF sketch" });
check("DXF placement dialog opened", (await dialog.count()) > 0);
const hint = (await dialog.locator(".ed-hint").textContent()) ?? "";
check("Preview counts entities", /entit/.test(hint), hint.trim());
// $INSUNITS = 4 (mm) → units preselected to Millimeters.
const units = await dialog.locator("select").nth(1).inputValue();
check("Units preselected from $INSUNITS", units === "mm", `got "${units}"`);

// --- Confirm the import ----------------------------------------------------
await dialog.locator("button", { hasText: "Import" }).click();
await waitIdle();

// --- A sketch feature with editable geometry now exists --------------------
const docFeatures = await page.evaluate(() =>
  window.__openpoly.document().features.map((f) => ({ type: f.type, n: f.entities?.length })),
);
console.log("features:", JSON.stringify(docFeatures));
const sketch = docFeatures.find((f) => f.type === "sketch");
check("A sketch feature was created", !!sketch);
check("Sketch has imported entities", (sketch?.n ?? 0) >= 6, `entities=${sketch?.n}`);
const kinds = await page.evaluate(() => {
  const sk = window.__openpoly.document().features.find((f) => f.type === "sketch");
  const c = {};
  for (const e of sk?.entities ?? []) c[e.type] = (c[e.type] ?? 0) + 1;
  return c;
});
console.log("entity kinds:", JSON.stringify(kinds));
check("Includes an arc (from the polyline bulge / ARC)", (kinds.arc ?? 0) >= 1);
check("Includes a spline", (kinds.spline ?? 0) >= 1);
check("Includes text", (kinds.text ?? 0) >= 1);
void read;

await page.screenshot({ path: join(__dirname, "..", "dxf-import.png") });
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await close();
process.exit(failures ? 1 : 0);
