// Throwaway L1 validation: stand up the local WS hub, open the app in headless
// Chromium (the tab dials the hub on its own), then drive a couple of requests
// through the bridge and check the results. Proves browser⟷hub round-trips +
// the serial request pipeline end to end.
//
//   URL=http://localhost:5174/ node scripts/bridge-e2e.mjs
import { WebSocketServer } from "ws";
import { chromium } from "playwright";

const PORT = 7373;
const URL = process.env.URL ?? "http://localhost:5174/";

const pending = new Map(); // request id -> resolve
let helloResolve;
const helloSeen = new Promise((r) => (helloResolve = r));
let sock = null;
let nextId = 1;

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (ws) => {
  sock = ws;
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "hello") {
      console.log("[hub] hello:", JSON.stringify({ sessionId: msg.sessionId, conventions: msg.conventions }));
      helloResolve(msg);
    } else if (msg.type === "result") {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
});
console.log(`[hub] listening on ws://127.0.0.1:${PORT}`);

const request = (kind, payload) =>
  new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, resolve);
    sock.send(JSON.stringify({ type: "request", id, kind, payload }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`request ${id} timed out`));
    }, 10000);
  });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(URL, { waitUntil: "domcontentloaded" });

await Promise.race([
  helloSeen,
  new Promise((_, rej) => setTimeout(() => rej(new Error("tab never connected to hub")), 15000)),
]);

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};

// 1) apply: add a box
const r1 = await request("apply", { op: "addPrimitive", kind: "box", name: "BridgeBox" });
check("apply addPrimitive -> ok", r1.ok && r1.payload?.ok === true, JSON.stringify(r1.payload));
const boxId = r1.payload?.createdId;

// 2) read: scene summary reflects it. Bodies come from kernel meshes, and
// applyOperation doesn't await regen until L3 — so poll a few times to let the
// worker settle (proves the read path, not instantaneous consistency).
let names = [];
for (let i = 0; i < 12; i++) {
  const r2 = await request("read", { read: "sceneSummary" });
  names = (r2.payload?.bodies ?? []).map((b) => b.name);
  if (names.length) break;
  await new Promise((r) => setTimeout(r, 300));
}
check(
  "read sceneSummary sees the box (after regen)",
  names.includes("Renamed") || names.includes("BridgeBox"),
  JSON.stringify(names),
);

// 3) apply: rename, then confirm via document read (serial ordering)
const r3 = await request("apply", { op: "rename", featureId: boxId, name: "Renamed" });
check("apply rename -> ok", r3.ok && r3.payload?.ok === true);
const r4 = await request("read", { read: "document" });
const renamed = (r4.payload?.features ?? []).find((f) => f.id === boxId)?.name;
check("document read shows rename (serial order held)", renamed === "Renamed", String(renamed));

// 4) invalid op surfaces a structured error, not a crash
const r5 = await request("apply", { op: "setParam", featureId: "missing", name: "width", value: "1" });
check(
  "invalid op -> ok:false not_found",
  r5.ok && r5.payload?.ok === false && r5.payload?.errorKind === "not_found",
  JSON.stringify(r5.payload),
);

// 5) badge shows connected
const badge = await page.locator(".agent-badge").count();
check("Agent connected badge visible", badge === 1);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await browser.close();
wss.close();
process.exit(failures === 0 ? 0 : 1);
