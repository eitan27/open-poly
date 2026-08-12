// M4 verification: the agent's multi-document tools, driven end-to-end through
// window.__openpoly (the same command layer the MCP server forwards to):
// list → new(name) → build → summary carries documentId/Name → open other →
// context flips → duplicate → rename → bogus id errors.
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1660, height: 920 }, deviceScaleFactor: 2 })
).newPage();
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });

const waitIdle = async () => {
  let stable = 0;
  for (let i = 0; i < 100; i++) {
    const s = (await page.locator(".status").textContent())?.trim() ?? "";
    stable = /up to date|error/i.test(s) ? stable + 1 : 0;
    if (stable >= 3) return;
    await page.waitForTimeout(300);
  }
  throw new Error("app never settled");
};
await waitIdle();
await page.waitForFunction(() => window.__openpoly);

const apply = (op) => page.evaluate((o) => window.__openpoly.apply(o), op);
const read = (q) => page.evaluate((o) => window.__openpoly.read(o), q);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Baseline: one clean named doc with a box.
const doc0 = await read({ read: "document" });
for (const f of [...doc0.features].reverse()) await apply({ op: "delete", featureId: f.id });
await apply({ op: "renameDocument", name: "AgentBase" });
await apply({ op: "addPrimitive", kind: "box" });
await waitIdle();

// 1. Summary carries the document identity.
let summary = await read({ read: "sceneSummary" });
check(
  "summary carries documentId + documentName",
  Boolean(summary.documentId) && summary.documentName === "AgentBase",
  `${summary.documentId?.slice(0, 8)} / ${summary.documentName}`,
);
const baseId = summary.documentId;

// 2. list_documents: active flagged, counts present.
let docs = await read({ read: "documents" });
check(
  "documents read lists the base doc as active",
  docs.some((d) => d.id === baseId && d.active && d.name === "AgentBase" && d.featureCount === 1),
  JSON.stringify(docs).slice(0, 200),
);

// 3. newDocument with a name → empty active doc, named; base autosaved.
const nw = await apply({ op: "newDocument", name: "AgentScratch" });
check("newDocument ok with createdId", nw.ok && Boolean(nw.createdId), JSON.stringify(nw));
summary = await read({ read: "sceneSummary" });
check("new doc is active and empty", summary.documentName === "AgentScratch" && summary.featureCount === 0);
await apply({ op: "addPrimitive", kind: "cylinder" });
await waitIdle();

// 4. openDocument back to base — content + identity flip.
const op = await apply({ op: "openDocument", id: baseId });
check("openDocument ok", op.ok, JSON.stringify(op).slice(0, 120));
summary = await read({ read: "sceneSummary" });
check(
  "context flipped back to AgentBase with its box",
  summary.documentId === baseId && summary.documentName === "AgentBase" && summary.featureCount === 1,
);

// 5. Re-opening the active doc is a cheap no-op.
const noop = await apply({ op: "openDocument", id: baseId });
check("re-open of active doc is ok/no-op", noop.ok === true);

// 6. duplicateDocument (default: active) opens the copy.
const dup = await apply({ op: "duplicateDocument" });
summary = await read({ read: "sceneSummary" });
check(
  "duplicate opened the copy with the same content",
  dup.ok &&
    summary.documentId === dup.createdId &&
    summary.documentName === "Copy of AgentBase" &&
    summary.featureCount === 1,
  summary.documentName,
);

// 7. renameDocument (default: active).
await apply({ op: "renameDocument", name: "AgentRenamed" });
summary = await read({ read: "sceneSummary" });
check("rename applied to the active doc", summary.documentName === "AgentRenamed");
docs = await read({ read: "documents" });
check(
  "list reflects the rename",
  docs.some((d) => d.name === "AgentRenamed" && d.active),
);

// 8. Bogus ids error with not_found.
const bad1 = await apply({ op: "openDocument", id: "ghost" });
const bad2 = await apply({ op: "duplicateDocument", id: "ghost" });
check(
  "unknown ids error as not_found",
  !bad1.ok && bad1.errorKind === "not_found" && !bad2.ok && bad2.errorKind === "not_found",
  bad1.error,
);

console.log(failures === 0 ? "=== ALL CHECKS PASSED ===" : `=== ${failures} CHECK(S) FAILED ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
