// Registers one MCP tool per Operation + the read tools, deriving each tool's
// input schema from the **shared zod schemas** (single source of truth with the
// browser) so the wire contract can't drift. Every call is forwarded over the
// WS hub to the live tab and the result mapped to MCP content. Conventions:
// millimetres, world is Z-up — restated in tool descriptions for the model.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { operationSchema, readQuerySchema, OPERATION_NAMES, READ_NAMES } from "../../src/agent/operations.ts";
import { HubError, type WsHub } from "./wsHub.ts";
import type { ResultMsg } from "../../src/agent/protocol.ts";

/** `.options` is a heterogeneous union of ZodObjects; treat each as a generic
 *  object so `.omit(...)` is callable. */
const asObject = (s: unknown) => s as z.ZodObject<z.ZodRawShape>;

const UNITS =
  " Conventions: millimetres, world is Z-up. Reference geometry by the stable ids/names from get_scene_summary.";

/** One-line purpose per operation (the convention note is appended). */
const OP_DESCRIPTIONS: Record<string, string> = {
  addPrimitive: "Add a primitive solid body (box | cylinder | sphere); override params with numbers or expressions.",
  addSketch:
    "Add a 2D sketch on a plane (datum top/front/right, a reference plane, or a body face by name). Entities are sugar shapes (rect/circle/polygon/line/arc/spline/point/text) in the plane's (u,v) coords; a spline is an open through-point curve handy as a sweep path; a text entity ({shape:'text', p, value, height, rotation?}) is a run of text you can extrude. Coordinates, radii and angles accept a number OR a variable expression string ('innerRad + clearance') — the sketch reflows when that variable changes. Angles (arc start/end, text rotation) are in DEGREES.",
  addExtrude:
    "Extrude a sketch region, a body face, OR a text entity into a solid. For text use profile {sketchId, textId} — the kernel bakes the glyph wires (counters/holes handled). mode new|add|remove (remove cuts inward by default); extent blind|symmetric|throughAll|upToFace|upToNext. throughAll is for remove/cut only and needs a targetId. upToFace stops at the plane of `upTo` ({bodyId, faceName} from get_scene_summary) — distance/flip are ignored and the target face must not be parallel to the extrude direction. upToNext stops at the NEAREST face of the model ahead in the flip-adjusted direction that the profile runs into, conforming to it (a tilted target gives an angled top, not a flat cut; same for upToFace). The next face must FULLY cover the profile — a partial blocker errors. distance ignored; flip reverses the direction; errors if nothing lies ahead that way.",
  addRevolve:
    "Revolve a sketch region OR a planar body face ({bodyId, faceName} — spin a flat face of an existing part; a curved face is rejected) by an angle (default 360; set symmetric:true to span ±angle/2 about the profile plane). The axis is one of: a sketch line {sketchId, entityId} (make it a construction line, region off the axis); a plane {plane:<datum|planeId|bodyFace>} (axis = where it meets the profile plane); a body face {bodyId, faceName} (planar face = that intersection, cylinder/cone face = its own central axis); or a straight body edge {bodyId, edgeName} (the edge itself is the axis line). Get ids/names from get_scene_summary.",
  addMirror:
    "Mirror a 3D body across a plane (datum/reference plane/body face) into a new body; the original is kept. (For mirroring 2D sketch entities, use add_sketch_mirror instead.)",
  addOffset:
    "Offset a single connected chain of sketch edges (lines/arcs, or one circle) by a signed distance, as associative DRIVEN geometry that tracks its sources. sourceIds must form one chain; a closed offset makes a region you can extrude. Output edges show as derived:true in the summary — don't constrain them.",
  addSketchMirror:
    "Mirror sketch entities across a sketch line into associative DRIVEN copies (they track their sources). axisId is a line entity; sourceIds are the entities to reflect. Distinct from add_mirror (which mirrors a whole 3D body across a plane).",
  addSketchPattern:
    "Repeat sketch entities as associative DRIVEN copies: kind 'linear' (count × step dx/dy) or 'circular' (count about a center — an entity point {entityId, at} or raw [u,v]; NO radius input, the seed's distance from the center is the radius). Counts INCLUDE the seed. The idiomatic way to repeat holes/cuts: pattern the profile, then one extrude-remove cuts them all.",
  addPattern:
    "Repeat a 3D body as rigid copies in ONE new compound body (seed kept, like add_mirror): kind 'linear' (dir1 world axis or sketch line + count1/spacing1, optional dir2/count2/spacing2 grid) or 'circular' (axis = world axis / sketch line / cylindrical face {bodyId, faceName} + count; angle default 360 = full circle, else the total sweep, symmetric spreads ±angle/2). Counts INCLUDE the seed; no radius input. For repeated holes prefer add_sketch_pattern + one cut.",
  addSweep:
    "Sweep a sketch region (cross-section) along a path entity (line/arc/spline, possibly in another sketch) into a solid. Get the path entityId from get_scene_summary's sketch entities; the profile is placed perpendicular to the path start.",
  addLoft:
    "Loft through 2+ sketch regions (sections, in the given order) into a solid. Put the sections on different planes (e.g. a base datum + an offset plane).",
  addPlane:
    "Add a reference plane. method (default 'offset'): 'offset' = parallel to base at a signed distance; 'midplane' = halfway between base and refB; 'angle' = base hinged on its u/v axis (angleAxis) by angle degrees; 'through' = through exactly 3 world points. base/refB are datum/plane/face refs; 'through' uses points and ignores base.",
  transform: "Rigid-move a body (translate + single-axis rotate). copy:true keeps the original and emits a moved copy.",
  boolean: "Combine two or more bodies (union/subtract/intersect) by id. For subtract, the first operand is the base.",
  dressUp:
    "Chamfer or fillet edges of a body, referencing edges by their persistent names from the summary. Pass `faces` instead of (or alongside) `edges` to dress every boundary edge of those faces — the reliable way to round a circular rim, since naming a cylinder's flat top beats listing its 96 rim chords. A chamfer takes an optional angle in degrees (0..90, default 45 = symmetric): size is measured along the reference face and the bevel leaves it at that angle; flip:true measures from the edge's other adjacent face instead.",
  shell:
    "Hollow out a body: remove the named faces (they become openings) and leave a wall of `thickness` around what remains, growing inward. `faces` are persistent face names from the summary; omit/empty for a fully sealed hollow shell (no opening).",
  addConstraint:
    "Add a geometric constraint to a sketch, then re-solve. constraint.kind is horizontal|vertical (one line entity), parallel|perpendicular (two lines), equal (two lines OR two circles/arcs), tangent (line+circle/arc or two circles/arcs), coincident (two points), pointOnLine (a point + a line), or midpoint (a point + a line/arc). Points are {entityId, at} — at 'a'/'b' = line/arc ends, 'c' = circle/arc/point center — or {origin:true}. Rejected (with a message naming the culprits) if it conflicts with / is already implied by existing constraints. Entity ids from get_scene_summary; derived and text entities aren't constrainable.",
  addDimension:
    "Add a dimensional constraint to a sketch, then re-solve. dimension.kind is length (a line, value>0), radius (a circle/arc, value>0), angle (two lines, value 0..180 DEGREES), or distance (between two elements a/b — each {on:'point',point} | {on:'line',entity} | {on:'rim',entity}). value accepts a number OR a variable expression ('width/2') — evaluated NOW against the document's variables (define them with set_variable first for a parametric model). Same conflict/redundancy rejection as add_constraint.",
  removeConstraint:
    "Remove a sketch constraint/dimension by id (from get_scene_summary's sketch constraints) — e.g. to clear an over-constraint before adding a different one.",
  setParam: 'Set a feature parameter to a number or expression (e.g. width = "plate/2").',
  setVariable: "Create or update a named variable (drive dimensions with variables, then reference them in params).",
  setAppearance: "Set a body's color (0xRRGGBB), opacity (0..1), and/or hidden flag.",
  rename: "Rename a feature/body so later steps and the human can read it.",
  delete: "Delete a feature (undoable).",
  setRollback: "Move the timeline rollback bar to an index (features at/after it are not regenerated).",
  select: "Set the viewport selection (so a screenshot highlights what you mean).",
  setSectionView:
    "Cut the model with a plane to see the interior (view-only — no undo, no geometry change). plane (datum/planeId/body face) defaults to the current section plane; offset is a signed distance along its normal; flip picks which half is kept. Turn on, then screenshot to inspect a bore/wall/interior a normal screenshot can't show.",
  importStep: "Import a body from STEP file text.",
  importDxf:
    "Import a DXF drawing as an EDITABLE sketch (not an opaque body like import_step). source is the DXF file text; plane places the sketch (datum/planeId/body face); scale multiplies all coordinates (DXF is unitless — 25.4 if the drawing is in inches, else 1 = mm). Handles LINE/CIRCLE/ARC/POLYLINE(bulges)/SPLINE/TEXT; unsupported types are skipped and reported as a warning. Imported geometry is free (unconstrained).",
  openDocument:
    "Switch the working document to `id` (from list_documents). Resolves after its geometry regenerates; undo history resets. Check get_scene_summary's documentId/documentName before assuming which file you're in.",
  newDocument: "Create and open a NEW empty document (optionally named). The previous document is autosaved.",
  renameDocument: "Rename a document (id defaults to the active one). Display-name only — not an undoable model edit.",
  duplicateDocument:
    "Duplicate a document (id defaults to the active one) and open the copy — a safe sandbox before risky edits.",
};

const READ_TOOLS: Record<string, { tool: string; description: string }> = {
  document: { tool: "get_document", description: "Return the full document JSON (ground truth)." },
  sceneSummary: {
    tool: "get_scene_summary",
    description:
      "Compact, LLM-first digest: bodies (named faces/edges, bbox), sketches (entities by id+type, regions, constraints by id+type+refs), planes, variables, rollback, selection. Your primary planning input — read it to get the entity id for a revolve axis, region ids, face/edge names, and constraint ids to remove.",
  },
  selection: { tool: "get_selection", description: "Return the current viewport selection." },
  screenshot: {
    tool: "screenshot",
    description:
      "Render the viewport and return a PNG image (optionally snap to a standard view first). Use it to verify what you built.",
  },
  documents: {
    tool: "list_documents",
    description:
      'All stored documents (id, name, edited time, feature/part counts), most-recently-edited first, with the ACTIVE one flagged. Entry point for "continue the X document" — find it here, then open_document.',
  },
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
    return {
      type: "result",
      id: "",
      ok: false,
      error: { message: String((err as Error).message ?? err), kind: kindTag },
    };
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
