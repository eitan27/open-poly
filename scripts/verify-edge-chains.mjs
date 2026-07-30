// A stored edge selection covering only PART of a rim must still dress the whole
// rim.
//
// A faceted round wall's rim is N tiny straight segments. Clicking it selects the
// whole ring, but the feature saves the literal segment names it had at the time.
// Change how finely walls are faceted and that list quietly means something else:
// a rim saved as 48 names, on a wall now cut into 96, still resolves — every name
// exists — but it is half the rim, so you get half a chamfer with no error and no
// warning. Measured on a real document before the fix: 194 faces on reopen where
// a fresh build gives 290.
//
// Rather than replay that across a code change, this asks the question directly:
// dress HALF a rim's segments and dress ALL of them, and require the same body.
// Same code, same document, one variable.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5175/";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await (await browser.newContext({ viewport: { width: 1660, height: 920 } })).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
// The expansion notice is a per-feature regen warning (the timeline's badge), not
// a console line — the apply result carries it back.
const noticeOf = (r) => JSON.stringify(r?.warnings ?? {}).match(/stored selection covered[^"]*/)?.[0] ?? null;
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
await waitIdle();
const apply = (o) => page.evaluate((x) => window.__openpoly.apply(x), o);
const read = (q) => page.evaluate((x) => window.__openpoly.read(x), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A boss on a box gives a genuine faceted rim: the ring where the two meet is a
// tangent-continuous chain of ~96 chords, which is exactly the case that used to
// be stored as a literal list.
async function build(label, take) {
  await apply({ op: "newDocument", name: label });
  await waitIdle();
  const box = await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "40" } });
  await waitIdle();
  const boss = await apply({ op: "addPrimitive", kind: "cylinder", params: { radius: "10", height: "30", z: "40" } });
  await waitIdle();
  const fused = await apply({ op: "boolean", kind: "union", operands: [box.createdId, boss.createdId] });
  await waitIdle();
  const sc = await read({ read: "sceneSummary" });
  const body = sc.bodies.find((b) => b.id === fused.createdId) ?? sc.bodies[0];
  const ring = (body?.edges ?? []).filter((e) => e.includes(`${box.createdId}/+z`) && e.includes(boss.createdId));
  const chosen = take(ring);
  const fil = await apply({ op: "dressUp", kind: "fillet", targetId: body.id, edges: chosen, size: "3" });
  const st = await waitIdle();
  const after = await read({ read: "sceneSummary" });
  const b2 = after.bodies.find((b) => b.id === body.id);
  return { ring: ring.length, chosen: chosen.length, ok: fil.ok, status: st, faces: b2?.faces?.length, edges: b2?.edges?.length, notice: noticeOf(fil) };
}

const whole = await build("whole-ring", (r) => r);
console.log(`whole ring: ${whole.chosen}/${whole.ring} segments -> faces=${whole.faces} edges=${whole.edges} ok=${whole.ok}`);
check("the joint ring is a real chain of many segments", whole.ring > 8, `${whole.ring} segments`);
check("dressing the whole ring builds", whole.ok && /up to date/.test(whole.status), whole.status);
check("…and needs no expansion", whole.notice === null, String(whole.notice));

const half = await build("half-ring", (r) => r.filter((_, i) => i % 2 === 0));
console.log(`half ring:  ${half.chosen}/${half.ring} segments -> faces=${half.faces} edges=${half.edges} ok=${half.ok}`);
check("dressing half the ring builds", half.ok && /up to date/.test(half.status), half.status);
check(
  "…and says so, rather than fixing it silently",
  half.notice !== null,
  String(half.notice),
);
check(
  "half a stored ring produces the SAME body as the whole ring",
  half.faces === whole.faces && half.edges === whole.edges,
  `half: ${half.faces} faces / ${half.edges} edges vs whole: ${whole.faces} / ${whole.edges}`,
);

// A straight edge is its own chain and must be untouched by any of this.
await apply({ op: "newDocument", name: "straight" });
await waitIdle();
const b = await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "40" } });
await waitIdle();
const sc = await read({ read: "sceneSummary" });
const one = (sc.bodies.find((x) => x.id === b.createdId)?.edges ?? []).filter((e) => e.includes("+z") && e.includes("+x"));
const ch = await apply({ op: "dressUp", kind: "chamfer", targetId: b.createdId, edges: one.slice(0, 1), size: "4" });
await waitIdle();
const after = await read({ read: "sceneSummary" });
check(
  "a single straight box edge is chamfered alone, not expanded",
  ch.ok && noticeOf(ch) === null && after.bodies.find((x) => x.id === b.createdId)?.faces?.length === 7,
  `faces=${after.bodies.find((x) => x.id === b.createdId)?.faces?.length} (6 + 1 bevel), notice=${noticeOf(ch)}`,
);

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
