// Full L2 validation: act as an MCP client (spawn the stdio server, which starts
// the WS hub), open the app in Playwright (the tab dials the hub), then call MCP
// tools and check they flow through to the live tab and back — including image
// content for screenshot and the modeling-guide / report_issue tools.
//
//   URL=http://localhost:5173/ node scripts/mcp-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5173/";

// 1) Spawn the MCP server over stdio (it starts the hub on :7373).
const transport = new StdioClientTransport({ command: "npx", args: ["tsx", "mcp-server/src/index.ts"] });
const client = new Client({ name: "mcp-e2e", version: "0.0.0" });
await client.connect(transport);

// 2) Open the app tab (it auto-connects to the hub).
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.locator(".agent-badge").waitFor({ timeout: 20000 });

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const textOf = (r) => r.content.find((c) => c.type === "text")?.text ?? "";

// tools are advertised
const tools = (await client.listTools()).tools.map((t) => t.name);
check(
  "tools advertised (ops + reads + guide + report_issue)",
  [
    "add_primitive",
    "add_sketch",
    "add_extrude",
    "get_scene_summary",
    "screenshot",
    "get_modeling_guide",
    "report_issue",
  ].every((n) => tools.includes(n)),
  `${tools.length} tools`,
);

// apply: add a box
const r1 = await client.callTool({ name: "add_primitive", arguments: { kind: "box", name: "McpBox" } });
const op1 = JSON.parse(textOf(r1));
check("add_primitive -> ok", !r1.isError && op1.ok === true, textOf(r1));
const boxId = op1.createdId;

// read: a SINGLE read right after the awaited apply must already see the body —
// L3 makes apply await regen, so no polling is needed.
const rsum = await client.callTool({ name: "get_scene_summary", arguments: {} });
const names = (JSON.parse(textOf(rsum)).bodies ?? []).map((b) => b.name);
check("get_scene_summary sees McpBox on first read (regen awaited)", names.includes("McpBox"), JSON.stringify(names));

// screenshot returns image content
const rs = await client.callTool({ name: "screenshot", arguments: { view: "iso" } });
const img = rs.content.find((c) => c.type === "image");
check(
  "screenshot -> PNG image content",
  !rs.isError && !!img && img.mimeType === "image/png" && img.data.length > 1000,
);

// invalid op surfaces a structured, isError result (model can self-correct)
const re = await client.callTool({ name: "set_param", arguments: { featureId: "missing", name: "width", value: 1 } });
const op2 = JSON.parse(textOf(re));
check(
  "set_param missing -> isError + not_found",
  re.isError === true && op2.ok === false && op2.errorKind === "not_found",
  textOf(re),
);

// a KERNEL build failure (bogus edge) surfaces only because we await regen —
// this is what lets an agent see a bad op and self-correct.
const rk = await client.callTool({
  name: "dress_up",
  arguments: { kind: "fillet", targetId: boxId, edges: ["does-not-exist"], size: 1 },
});
const op3 = JSON.parse(textOf(rk));
check(
  "dress_up bad edge -> isError + kernel_error (regen-await)",
  rk.isError === true && op3.ok === false && op3.errorKind === "kernel_error",
  textOf(rk),
);

// modeling guide + report_issue (don't go through the hub)
const rg = await client.callTool({ name: "get_modeling_guide", arguments: {} });
check("get_modeling_guide returns the guide", textOf(rg).includes("Open Poly") && textOf(rg).includes("work loop"));
const ri = await client.callTool({ name: "report_issue", arguments: { kind: "friction", goal: "L2 e2e smoke" } });
check("report_issue acks", !ri.isError && textOf(ri).toLowerCase().includes("logged"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
await browser.close();
await client.close();
process.exit(failures === 0 ? 0 : 1);
