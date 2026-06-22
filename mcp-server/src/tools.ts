// Registers one MCP tool per Operation + the read tools, deriving each tool's
// input schema from the **shared zod schemas** (single source of truth with the
// browser) so the wire contract can't drift. Every call is forwarded over the
// WS hub to the live tab and the result mapped to MCP content. Conventions:
// millimetres, world is Z-up — restated in tool descriptions for the model.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  operationSchema,
  readQuerySchema,
  OPERATION_NAMES,
  READ_NAMES,
} from "../../src/agent/operations.ts";
import { HubError, type WsHub } from "./wsHub.ts";
import type { ResultMsg } from "../../src/agent/protocol.ts";

/** `.options` is a heterogeneous union of ZodObjects; treat each as a generic
 *  object so `.omit(...)` is callable. */
const asObject = (s: unknown) => s as z.ZodObject<z.ZodRawShape>;

const UNITS = " Conventions: millimetres, world is Z-up. Reference geometry by the stable ids/names from get_scene_summary.";

/** One-line purpose per operation (the convention note is appended). */
const OP_DESCRIPTIONS: Record<string, string> = {
  addPrimitive: "Add a primitive solid body (box | cylinder | sphere); override params with numbers or expressions.",
  addSketch: "Add a 2D sketch on a plane (datum top/front/right, a reference plane, or a body face by name). Entities are sugar shapes (rect/circle/polygon/line/arc/spline/point) in the plane's (u,v) coords; a spline is an open through-point curve handy as a sweep path.",
  addExtrude: "Extrude a sketch region (or a body face) into a solid. mode new|add|remove (remove cuts inward by default); extent blind|symmetric|throughAll|upToFace. throughAll is for remove/cut only and needs a targetId. upToFace stops at the plane of `upTo` ({bodyId, faceName} from get_scene_summary) — distance/flip are ignored and the target face must not be parallel to the extrude direction.",
  addRevolve: "Revolve a sketch region around an axis line in the same sketch by an angle (default 360). Make the axis a construction line and keep the region off the axis. Get the axis entity id from get_scene_summary's sketch entities.",
  addMirror: "Mirror a body across a plane (datum/reference plane/body face) into a new body; the original is kept.",
  addSweep: "Sweep a sketch region (cross-section) along a path entity (line/arc/spline, possibly in another sketch) into a solid. Get the path entityId from get_scene_summary's sketch entities; the profile is placed perpendicular to the path start.",
  addLoft: "Loft through 2+ sketch regions (sections, in the given order) into a solid. Put the sections on different planes (e.g. a base datum + an offset plane).",
  addPlane: "Add an offset reference plane parallel to a base (datum/plane/face) at a signed distance.",
  transform: "Rigid-move a body (translate + single-axis rotate). copy:true keeps the original and emits a moved copy.",
  boolean: "Combine two or more bodies (union/subtract/intersect) by id. For subtract, the first operand is the base.",
  dressUp: "Chamfer or fillet edges of a body, referencing edges by their persistent names from the summary.",
  setParam: "Set a feature parameter to a number or expression (e.g. width = \"plate/2\").",
  setVariable: "Create or update a named variable (drive dimensions with variables, then reference them in params).",
  setAppearance: "Set a body's color (0xRRGGBB), opacity (0..1), and/or hidden flag.",
  rename: "Rename a feature/body so later steps and the human can read it.",
  delete: "Delete a feature (undoable).",
  setRollback: "Move the timeline rollback bar to an index (features at/after it are not regenerated).",
  select: "Set the viewport selection (so a screenshot highlights what you mean).",
  importStep: "Import a body from STEP file text.",
};

const READ_TOOLS: Record<string, { tool: string; description: string }> = {
  document: { tool: "get_document", description: "Return the full document JSON (ground truth)." },
  sceneSummary: { tool: "get_scene_summary", description: "Compact, LLM-first digest: bodies (named faces/edges, bbox), sketches (entities by id+type, regions), planes, variables, rollback, selection. Your primary planning input — read it to get the entity id for a revolve axis, region ids, and face/edge names." },
  selection: { tool: "get_selection", description: "Return the current viewport selection." },
  screenshot: { tool: "screenshot", description: "Render the viewport and return a PNG image (optionally snap to a standard view first). Use it to verify what you built." },
};

const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());

/** Turn a hub ResultMsg (or a thrown HubError) into MCP tool content. */
function toToolResult(res: ResultMsg): CallToolResult {
  if (!res.ok) {
    return { content: [{ type: "text", text: res.error?.message ?? "Request failed." }], isError: true };
  }
  const payload = res.payload as { ok?: boolean } | unknown;
  // Apply results carry their own ok — surface op-level failure as isError so the
  // model self-corrects instead of building on a no-op.
  const isError = !!payload && typeof payload === "object" && (payload as { ok?: boolean }).ok === false;
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

async function forward(hub: WsHub, kind: "apply" | "read", payload: unknown): Promise<ResultMsg> {
  try {
    return await hub.request(kind, payload);
  } catch (err) {
    const kindTag = err instanceof HubError ? err.kind : "invalid_op";
    return { type: "result", id: "", ok: false, error: { message: String((err as Error).message ?? err), kind: kindTag } };
  }
}

/** Register every Operation tool + read tool on the server. */
export function registerBridgeTools(server: McpServer, hub: WsHub): void {
  operationSchema.options.forEach((opt, i) => {
    const opName = OPERATION_NAMES[i];
    const toolName = camelToSnake(opName);
    const inputSchema = asObject(opt).omit({ op: true }).shape;
    server.registerTool(
      toolName,
      { description: (OP_DESCRIPTIONS[opName] ?? `Apply the ${opName} operation.`) + UNITS, inputSchema },
      async (args: Record<string, unknown>) => toToolResult(await forward(hub, "apply", { op: opName, ...args })),
    );
  });

  readQuerySchema.options.forEach((opt, i) => {
    const readName = READ_NAMES[i];
    const meta = READ_TOOLS[readName] ?? { tool: camelToSnake(readName), description: `Read: ${readName}.` };
    const inputSchema = asObject(opt).omit({ read: true }).shape;
    server.registerTool(
      meta.tool,
      { description: meta.description + (readName === "sceneSummary" ? UNITS : ""), inputSchema },
      async (args: Record<string, unknown>) => {
        const res = await forward(hub, "read", { read: readName, ...args });
        if (!res.ok) return toToolResult(res);
        if (readName === "screenshot") {
          const url = res.payload as string | null;
          if (typeof url !== "string" || !url.startsWith("data:image/png;base64,")) {
            return { content: [{ type: "text", text: "No viewport available to capture." }], isError: true };
          }
          return { content: [{ type: "image", data: url.slice(url.indexOf(",") + 1), mimeType: "image/png" }] };
        }
        return toToolResult(res);
      },
    );
  });
}
