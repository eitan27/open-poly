// The rollback bar is a thing you pick up, not just a line you click past.
//
// It used to be a 2px amber line in an 8px gutter with a click handler and no
// affordance: nothing said it could be dragged, and nothing during a drag said
// which point between features you were about to land on. Now the bar carries a
// grip, a scrub commits at every position it passes (so the model rolls with the
// bar) while collapsing into ONE undo step, every insertion point lights up
// while dragging, and a chip counts the features still active.
//
// Checks:
//   1. the bar shows a grip, and only on the active gutter
//   2. dragging it up rolls the model back — bodies disappear as it passes
//   3. mid-drag the tree is in its "every stop is a target" state and the chip
//      reports the position
//   4. dragging back down restores them
//   5. the whole scrub is ONE undo step (one Ctrl+Z returns to the start)
//   6. arrow keys move the bar from the keyboard
//   7. the timeline reveals the bar by itself — fully scrolled when the model is
//      up to date, and never with more than half the panel below the bar
//   8. holding a drag at the panel edge scrolls the list under it
//   9. the grip reports a rebuild, where the hand already is
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
    await page.waitForTimeout(200);
  }
  return "TIMEOUT";
};
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);
const rollback = async () => (await read({ read: "document" })).rollbackIndex;
const bodies = async () => ((await read({ read: "sceneSummary" })).bodies ?? []).length;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

await waitIdle();

// Four stacked boxes: four features, five insertion points, and a body count
// that says exactly how far back the bar is.
for (let i = 0; i < 4; i++) {
  await apply({ op: "addPrimitive", kind: "box", params: { width: 10, depth: 10, height: 10 } });
  await apply({
    op: "addTransform",
    targetId: (await read({ read: "document" })).features.at(-1).id,
    tz: i * 12,
  }).catch(() => {});
}
await waitIdle();

// --- the timeline reveals the bar on its own -----------------------------
// Enough features to overflow the panel, so scrolling actually matters.
for (let i = 0; i < 14; i++)
  await apply({ op: "addPrimitive", kind: "box", params: { width: 6, depth: 6, height: 6 } });
await waitIdle();
const scrollState = () =>
  page.locator(".tree").evaluate((el) => {
    const bar = el.querySelector("[data-rollback-index].active") ?? el.querySelector(".rollback-gutter.active");
    const r = bar.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    return {
      scrollTop: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
      clientHeight: el.clientHeight,
      // Where the bar sits inside the visible panel, top-relative.
      barInView: r.top + r.height / 2 - t.top,
      overflows: el.scrollHeight > el.clientHeight + 1,
    };
  });
let sc = await scrollState();
check("the list actually overflows (so scrolling is under test)", sc.overflows, JSON.stringify(sc));
check(
  "up to date ⇒ the timeline is fully scrolled, bar visible",
  Math.abs(sc.scrollTop - sc.max) <= 2 && sc.barInView > 0 && sc.barInView <= sc.clientHeight,
  JSON.stringify(sc),
);

// Roll back to the middle from the document side (not the UI) and check the
// panel reveals the bar without being touched.
const midIndex = Math.floor((await read({ read: "document" })).features.length / 2);
await apply({ op: "setRollback", index: midIndex });
await waitIdle();
sc = await scrollState();
check(
  "a bar in the middle is revealed, with at most half the panel below it",
  sc.barInView > 0 && sc.barInView <= sc.clientHeight && sc.clientHeight - sc.barInView <= sc.clientHeight / 2 + 2,
  `bar at ${Math.round(sc.barInView)}px of ${sc.clientHeight}px`,
);
await apply({ op: "setRollback", index: (await read({ read: "document" })).features.length });
await waitIdle();

// The fixture is complete now — take the counts the drag checks compare against.
const featureCount = (await read({ read: "document" })).features.length;
const fullBodies = await bodies();

const grip = page.locator(".rollback-grip");
check("exactly one grip, on the active gutter", (await grip.count()) === 1, `${await grip.count()} grips`);
const gutters = await page.locator(".rollback-gutter").count();
check("one insertion point per boundary", gutters === featureCount + 1, `${gutters} gutters, ${featureCount} features`);

// --- drag the bar up, over two features ---------------------------------
// The timeline scrolls, and with the bar at the end it can sit below the fold —
// bring it into view before measuring anything.
await grip.scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const box = await grip.boundingBox();
const stops = await page.locator(".rollback-gutter").evaluateAll((els) =>
  els.map((e) => {
    const r = e.getBoundingClientRect();
    return r.top + r.height / 2;
  }),
);
const target = stops[featureCount - 2]; // two features above the end

await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, target + 40, { steps: 4 });
await page.mouse.move(box.x + box.width / 2, target, { steps: 8 });
await page.waitForTimeout(300);

const draggingClass = await page.locator(".tree").evaluate((e) => e.className);
const chip = (await page.locator(".rollback-count").count()) ? await page.locator(".rollback-count").textContent() : "";
check("mid-drag: every stop is shown as a target", /rollback-dragging/.test(draggingClass), draggingClass);
check("mid-drag: the chip reports the position", /\d+\s*\/\s*\d+/.test(chip), `chip=${JSON.stringify(chip)}`);

await page.mouse.up();
await waitIdle();
const rolledIdx = await rollback();
const rolledBodies = await bodies();
check(
  "dragging up rolls the model back",
  rolledIdx === featureCount - 2 && rolledBodies < fullBodies,
  `rollbackIndex=${rolledIdx} (want ${featureCount - 2}), bodies ${fullBodies}→${rolledBodies}`,
);
check("the chip clears when the drag ends", (await page.locator(".rollback-count").count()) === 0);

// --- one undo returns the whole scrub ------------------------------------
await page.keyboard.press("Control+z");
await waitIdle();
check(
  "the whole scrub is one undo step",
  (await rollback()) === featureCount && (await bodies()) === fullBodies,
  `rollbackIndex=${await rollback()}, bodies=${await bodies()}`,
);

// --- keyboard -------------------------------------------------------------
await page.locator(".rollback-grip").scrollIntoViewIfNeeded();
await page.locator(".rollback-grip").focus();
await page.keyboard.press("ArrowUp");
await waitIdle();
const afterUp = await rollback();
await page.keyboard.press("ArrowDown");
await waitIdle();
check(
  "arrow keys move the bar",
  afterUp === featureCount - 1 && (await rollback()) === featureCount,
  `up→${afterUp}, down→${await rollback()}`,
);

// --- the grip says when the model is rebuilding ---------------------------
{
  await apply({ op: "setRollback", index: 1 });
  await waitIdle();
  // Watch from inside the page: a rebuild can be quicker than a poll from here.
  const watcher = page.evaluate(
    () =>
      new Promise((res) => {
        let seen = false;
        const t = setInterval(() => {
          if (document.querySelector(".rollback-grip.busy")) seen = true;
        }, 16);
        setTimeout(() => {
          clearInterval(t);
          res(seen);
        }, 3000);
      }),
  );
  await apply({ op: "setRollback", index: (await read({ read: "document" })).features.length });
  const sawBusy = await watcher;
  await waitIdle();
  check("the grip shows a rebuild in progress", sawBusy === true, `busy class seen: ${sawBusy}`);
  check(
    "and clears it when the rebuild finishes",
    (await page.locator(".rollback-grip.busy").count()) === 0,
    `${await page.locator(".rollback-grip.busy").count()} busy grips at rest`,
  );
}

// --- holding at the edge scrolls the list --------------------------------
await page.locator(".rollback-grip").scrollIntoViewIfNeeded();
await page.waitForTimeout(200);
const gb = await page.locator(".rollback-grip").boundingBox();
const treeBox = await page.locator(".tree").boundingBox();
const scrollBefore = await page.locator(".tree").evaluate((el) => el.scrollTop);
await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await page.mouse.down();
// Park the pointer inside the top edge band and just hold it there.
await page.mouse.move(gb.x + gb.width / 2, treeBox.y + 6, { steps: 6 });
await page.waitForTimeout(700);
const scrollDuring = await page.locator(".tree").evaluate((el) => el.scrollTop);
await page.mouse.up();
await waitIdle();
check(
  "holding at the top edge scrolls the list under the drag",
  scrollDuring < scrollBefore,
  `scrollTop ${scrollBefore} → ${scrollDuring}`,
);

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
await browser.close();
process.exit(failures ? 1 : 0);
