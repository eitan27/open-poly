// Extrude's dialog with a long profile list in a short window: the whole
// dialog scrolls (as Hole's and Screw's do) instead of running off screen.
//
//   URL=http://localhost:5181/ node scripts/verify-extrude-dialog-scroll.mjs
import os from "node:os";
import path from "node:path";
import { launch, openPoly, checker } from "./lib/harness.mjs";

const SHOTS = process.env.SHOTS ?? os.tmpdir();
const { page, errors, close } = await launch({ height: 560 });
const op = openPoly(page);
const { check, done } = checker();
await op.newDocument();

// Twenty separate circles: twenty profiles, twenty rows.
const entities = Array.from({ length: 20 }, (_, i) => ({
  shape: "circle",
  c: [(i % 5) * 12, Math.floor(i / 5) * 12],
  r: 4,
}));
const sk = await op.applySettled({ op: "addSketch", plane: { datum: "top" }, entities });
const ids = await page.evaluate((id) => {
  const r = window.__openpoly.read({ read: "document" });
  const d = r.document ?? r;
  return d.features.find((f) => f.id === id).entities.map((e) => e.id);
}, sk.createdId);
await op.apply({
  op: "select",
  refs: ids.map((entityId) => ({ kind: "sketchEntity", sketchId: sk.createdId, entityId })),
});
await page.evaluate(() => document.activeElement?.blur());
await page.waitForTimeout(200);
await page.keyboard.press("e");
const dlg = page.locator(".extrude-dialog");
await dlg.waitFor({ timeout: 5000 });
await page.waitForTimeout(800);
const m = await dlg.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return {
    rows: el.querySelectorAll(".bool-operand-row").length,
    top: r.top,
    bottom: r.bottom,
    win: window.innerHeight,
    scroll: el.scrollHeight,
    client: el.clientHeight,
  };
});
await page.screenshot({ path: path.join(SHOTS, "extrude-dialog-scroll.png") });
check("a row per profile", m.rows === 20, JSON.stringify(m));
check("the dialog stays inside the window", m.top >= 0 && m.bottom <= m.win, JSON.stringify(m));
check("…and scrolls as a whole", m.scroll > m.client, JSON.stringify(m));
// Its last field is reachable by scrolling.
const create = dlg.locator(".ed-primary");
await create.scrollIntoViewIfNeeded();
check("Create can be scrolled to", await create.isVisible());
// The dev server proxies /api/drive to a Pages Function that isn't running
// locally; its 502s are environment noise.
const real = errors.filter((e) => !/502|Bad Gateway/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
await close();
done();
