// The agent building an assembly (agent/assemblyOps.ts) through the same
// window.__openpoly bridge the MCP server drives, with no clicks: two part
// documents, a new assembly, insert_instance ×2 (the first grounded),
// add_mate by face names from the summary (the arm seats on the base at the
// angle given), the panel showing it, Ctrl+Z undoing it like a hand-made one,
// a mate the solver can't hold reported and deleted, and delete removing an
// instance; then two arms geared together, driven by set_mate_value from
// either end and by an assembly variable. NB if the local open-poly MCP hub is running, this headless tab
// connects to it and can take the bridge from your own tab; reload yours after.
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

// --- Two parts and an assembly, all by the agent's ops -------------------------
const doc0 = await read({ read: "document" });
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await apply({ op: "renameDocument", name: "AgentBase" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "40", depth: "40", height: "10" } });
await apply({ op: "newDocument", name: "AgentArm" });
await apply({ op: "addPrimitive", kind: "box", params: { width: "30", depth: "8", height: "4" } });
await waitIdle();
const made = await apply({ op: "newDocument", name: "AgentBuild", kind: "assembly" });
await waitIdle();
check("new_document makes the assembly", made.ok && (await summary()).kind === "assembly");
const docs = await read({ read: "documents" });
const idOf = (name) => docs.find((d) => d.name === name)?.id;

const ins1 = await apply({ op: "insertInstance", documentId: idOf("AgentBase") });
const ins2 = await apply({ op: "insertInstance", documentId: idOf("AgentArm"), name: "Arm" });
let s = await summary();
check("insert_instance places both", ins1.ok && ins2.ok && s.instances.length === 2, JSON.stringify([ins1, ins2]));
check("…the first grounded, the second named", s.instances[0].grounded && s.instances[1].name === "Arm");
check("…the arm beside the base", s.instances[1].bbox.min[0] >= s.instances[0].bbox.max[0]);
check(
  "…and the summary has their parts' faces",
  s.parts.every((p) => p.faces?.length === 6),
  JSON.stringify(s.parts.map((p) => p.problem ?? p.faces?.length)),
);
const facesOf = (inst) => s.parts.find((p) => p.key === inst.part).faces;
const [base, arm] = s.instances;
const top = facesOf(base).find((f) => f.endsWith("/+z"));
const bottom = facesOf(arm).find((f) => f.endsWith("/-z"));

// --- add_mate by name --------------------------------------------------------------
const m = await apply({
  op: "addMate",
  type: "revolute",
  a: { instanceId: base.id, face: top },
  b: { instanceId: arm.id, face: bottom },
  values: { rz: 30 },
});
s = await summary();
const mate = s.mates[0];
check("add_mate makes a revolute", m.ok && mate?.type === "revolute" && mate.id === m.createdId, JSON.stringify(m));
check("…at the angle given", mate?.free[0].dof === "rz" && mate.free[0].value === 30);
check(
  "…seating the arm on the base",
  s.instances[1].mated && Math.abs(s.instances[1].bbox.min[2] - 10) < 1e-3,
  JSON.stringify(s.instances[1].bbox),
);
check("…and the panel lists it", (await page.locator(".asm-mate-row").count()) === 1);

// --- Undo and redo, as for a hand-made mate --------------------------------------------
await page
  .locator(".viewport canvas")
  .first()
  .hover({ position: { x: 5, y: 5 } });
await page.keyboard.press("Control+z");
await page.waitForTimeout(500);
check("Ctrl+Z undoes the agent's mate", (await summary()).mates.length === 0);
await page.keyboard.press("Control+Shift+z");
await page.waitForTimeout(500);
check("…and Ctrl+Shift+Z redoes it", (await summary()).mates.length === 1);

// --- Errors --------------------------------------------------------------------------
const missing = await apply({
  op: "addMate",
  type: "fastened",
  a: { instanceId: base.id, face: "nope" },
  b: { instanceId: arm.id, face: bottom },
});
check(
  "a face that isn't there is refused, by name",
  !missing.ok && /No face "nope"/.test(missing.error),
  missing.error,
);
check("…changing nothing", (await summary()).mates.length === 1);

await apply({ op: "groundInstance", instanceId: arm.id });
const stuck = await apply({
  op: "addMate",
  type: "fastened",
  a: { instanceId: base.id, face: facesOf(base).find((f) => f.endsWith("/+x")) },
  b: { instanceId: arm.id, face: bottom },
});
check(
  "a mate that can't hold between two grounded parts is the op's failure",
  !stuck.ok && stuck.createdId && stuck.featureErrors?.[stuck.createdId],
  JSON.stringify(stuck),
);
const del = await apply({ op: "delete", featureId: stuck.createdId });
check("delete removes it", del.ok && (await summary()).mates.length === 1);

const delArm = await apply({ op: "delete", featureId: arm.id });
s = await summary();
check("delete removes an instance with its mates", delArm.ok && s.instances.length === 1 && s.mates.length === 0);

const refused = await apply({ op: "addPrimitive", kind: "box" });
check("part modelling is refused, naming the assembly tools", !refused.ok && /add_mate/.test(refused.error));

// --- Values, relations and variables: two arms geared on the base ------------------
const armA = (await apply({ op: "insertInstance", documentId: idOf("AgentArm"), name: "ArmA" })).createdId;
const armB = (await apply({ op: "insertInstance", documentId: idOf("AgentArm"), name: "ArmB" })).createdId;
const hinge = async (instanceId, x) =>
  (
    await apply({
      op: "addMate",
      type: "revolute",
      a: { instanceId: base.id, face: top, offset: { x } },
      b: { instanceId, face: bottom },
    })
  ).createdId;
const rA = await hinge(armA, -10);
const rB = await hinge(armB, 10);
const gear = await apply({
  op: "addRelation",
  type: "gear",
  driver: { mateId: rA, dof: "rz" },
  driven: { mateId: rB, dof: "rz" },
  value: 2,
});
check("add_relation gears the second arm to the first", gear.ok, JSON.stringify(gear));
check("…and the panel lists it", (await page.locator(".asm-relation-row").count()) === 1);
const angle = (sum, id) => sum.mates.find((m) => m.id === id).free[0];
await apply({ op: "setMateValue", mateId: rA, dof: "rz", value: 15 });
s = await summary();
check(
  "set_mate_value turns the driver, and the gear the driven arm",
  angle(s, rA).value === 15 && angle(s, rB).value === -30 && angle(s, rB).drivenBy === gear.createdId,
  `${angle(s, rA).value}, ${angle(s, rB).value}`,
);
const back = await apply({ op: "setMateValue", mateId: rB, dof: "rz", value: -50 });
s = await summary();
check("a value set on the driven arm turns its driver", back.ok && angle(s, rA).value === 25, `${angle(s, rA).value}`);
const v = await apply({ op: "setVariable", name: "swing", expression: "40" });
await apply({ op: "setMateValue", mateId: rA, dof: "rz", value: "swing" });
s = await summary();
check(
  "set_variable makes an assembly variable a mate value can name",
  v.ok &&
    s.variables.some((x) => x.name === "swing" && x.value === 40) &&
    angle(s, rA).expression === "swing" &&
    angle(s, rB).value === -80,
  JSON.stringify(s.variables),
);
await apply({ op: "setVariable", name: "swing", expression: "10" });
s = await summary();
check("…and changing it turns both arms", angle(s, rA).value === 10 && angle(s, rB).value === -20);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
await browser.close();
process.exit(failures ? 1 : 0);
