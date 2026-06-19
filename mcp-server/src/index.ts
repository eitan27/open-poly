// Open Poly MCP server (Phase 9 L2). Two faces in one Node process: a stdio MCP
// server for the LLM client, and a localhost WebSocket hub the browser tab dials
// into. An LLM tool call → forwarded over WS to the tab → applied via the command
// layer → result back to the LLM. Plus the modeling guide (as a tool, resource,
// and prompt) and a report_issue feedback loop.
//
// Launch: `npx tsx mcp-server/src/index.ts` (see README for client config).
// IMPORTANT: stdout is the JSON-RPC channel — all logging uses stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WsHub } from "./wsHub.ts";
import { registerBridgeTools } from "./tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = resolve(here, "../../src/agent/modeling-guide.md");
const ISSUES_PATH = resolve(here, "../issues.log.jsonl");

const readGuide = (): string => {
  try {
    return readFileSync(GUIDE_PATH, "utf8");
  } catch {
    return "The modeling guide is unavailable.";
  }
};

const hub = new WsHub();
const server = new McpServer({ name: "open-poly", version: "0.1.0" });

// One tool per Operation + the read tools (forwarded over the hub).
registerBridgeTools(server, hub);

// The modeling guide — delivered three ways so any client picks it up.
server.registerResource(
  "modeling-guide",
  "openpoly://modeling-guide",
  { title: "Open Poly modeling guide", description: "How to model in Open Poly via these tools.", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: readGuide() }] }),
);
server.registerTool(
  "get_modeling_guide",
  { description: "Return the Open Poly modeling guide: mental model, conventions (mm, Z-up, reference-by-name), the read→plan→one-op→verify loop, recipes, and best practices. Read this first.", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: readGuide() }] }),
);
server.registerPrompt(
  "modeling_guide",
  { description: "Load the Open Poly modeling playbook as context." },
  () => ({ messages: [{ role: "user", content: { type: "text", text: readGuide() } }] }),
);

// First-class feedback loop: the agent reports gaps/bugs instead of faking
// geometry. Appended to a reviewable JSONL log for the developer.
server.registerTool(
  "report_issue",
  {
    description:
      "Report a gap or bug instead of faking geometry or silently working around it. Use when an operation you need isn't expressible (missing_feature), a tool did the wrong thing (bug), or something worked but was awkward (friction). Reporting is a successful outcome.",
    inputSchema: {
      kind: z.enum(["missing_feature", "bug", "friction"]),
      goal: z.string().describe("What you were trying to achieve."),
      tried: z.string().optional().describe("What you tried (tools/args)."),
      expected: z.string().optional(),
      observed: z.string().optional(),
      suggested: z.string().optional().describe("A suggested API/behavior."),
    },
  },
  async (args) => {
    const entry = { ts: new Date().toISOString(), ...args };
    try {
      appendFileSync(ISSUES_PATH, JSON.stringify(entry) + "\n");
    } catch (e) {
      console.error("[mcp] failed to write issue log:", (e as Error).message);
    }
    console.error("[mcp] issue reported:", entry.kind, "-", entry.goal);
    return { content: [{ type: "text", text: `Logged a "${args.kind}" report. Thank you — surfacing a gap/bug is a successful outcome, not a failure.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] open-poly server ready (stdio). Open the Open Poly tab to connect it.");

const shutdown = () => {
  hub.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
