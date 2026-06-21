# Open Poly — Agent Modeling Guide

> **Status: DRAFT.** This is the "skill" an LLM agent loads to model in Open Poly
> via the MCP tools (Phase 9). Tool names below match the planned command layer
> and will be finalized once L0/L2 land — keep this file in sync with the actual
> tools. Delivered to clients as an MCP **prompt** + **resource** (and a
> `get_modeling_guide` tool).

You are operating **Open Poly**, a parametric, feature-tree CAD app, by calling
tools. A human is watching the same browser. Model deliberately and verifiably.

## Mental model

- A document is an **ordered timeline of features** that regenerates top-to-bottom
  into **bodies** (parts). Editing a feature re-runs it and everything after.
- Features are either **body producers** (primitive, extrude-new, boolean,
  transform-copy, import) or **in-place modifiers** that keep a body's identity
  (extrude add/remove, chamfer, fillet, transform). Sketches and reference planes
  produce no body — they're inputs.
- **Topological naming** is real: faces/edges have **persistent names** that
  survive edits, so reference them by name, not by guessing geometry.

## Conventions (always)

- **Units: millimetres. World is Z-up** (the XY/"Top" plane is the ground).
- Reference geometry by **stable handles**, never raw coordinates when a handle
  exists: feature **ids**, persistent **face/edge names**, sketch **region ids**,
  plane refs (`{datum}` / `{planeId}` / `{bodyId, faceName}`). Get these from
  `get_scene_summary` — don't invent them.
- One sketch's 2D entities live in that sketch's plane **(u, v)** coordinates.

## The work loop (do this every time)

1. **Read first.** Call `get_scene_summary` (and `get_document` if you need exact
   params). Never act on assumed state.
2. **Plan** the smallest next step.
3. **Act** — usually **one** operation. Do not fire many blind ops.
4. **Verify** — check the op result/regen status for errors, and **`screenshot`**
   to confirm the geometry looks right.
5. **Iterate.** Build the part incrementally, checking as you go.

If an op errors, read the message, fix the cause, and retry — don't loop blindly.

## Tools (overview)

- **Read:** `get_scene_summary`, `get_document`, `get_selection`, `screenshot`.
- **Create/modify (each maps to one document operation):** `add_primitive`,
  `add_sketch` (plane + entities in uv; mark an entity `construction:true` to make
  it reference-only — used for snapping / as a revolve axis, never extruded),
  `add_extrude` (profile + distance + mode `new|add|remove` + extent
  `blind|symmetric|throughAll`), `add_revolve` (region + axis line + angle),
  `add_mirror` (body + plane), `add_plane`, `transform` (translate/rotate,
  optional `copy`), `boolean`, `dress_up` (chamfer/fillet), `set_param`,
  `set_appearance`, `rename`, `delete`, `select`, `import_step`.
- **Feedback:** `report_issue` — see below.

All mutations route through undo, so the human can revert anything you do.

## Recipes

- **Block / cylinder / sphere:** `add_primitive`.
- **Profile → solid:** `add_sketch` on a plane/face with entities (use the sugar
  shapes — rect/circle/polygon — instead of placing every line), then
  `add_extrude` with `mode: "new"`.
- **Boss on a face:** sketch on the body face → `add_extrude`. Extruding a sketch
  that sits on a solid's face (or a body face directly) **defaults to `add`** onto
  that solid and goes **outward**.
- **Pocket / hole:** same, but `mode: "remove"` — a removal cuts **into** the body
  by default (the direction is implicitly inward; the `flip` flag reverses it).
  For a hole/pocket that must pass entirely through, set `extent: "throughAll"`
  (with the `targetId`) instead of guessing a distance.
- **Two-sided / centered feature:** `add_extrude` with `extent: "symmetric"` —
  the profile extrudes `distance` equally both ways (centered on the sketch).
- **Revolved part (shaft, ring, bowl):** `add_sketch` with the **profile region**
  to one side of an axis **line** (mark the axis `construction:true` so it isn't
  part of the region and isn't a wall); then `add_revolve` with that region +
  `axis: {sketchId, entityId}` (get the line's `entityId` from the sketch's
  `entities` in `get_scene_summary`) and an `angle` (360 for a full solid of
  revolution, less for a partial). The profile must **not cross** the axis.
- **Mirror a body across a plane:** `add_mirror` (body + plane) → a reflected
  **new** body, original kept. Use it for symmetric parts: build one half, mirror
  it, then `boolean` `union` if you need a single body.
- **Round/bevel an edge:** `dress_up` (`fillet`/`chamfer`) referencing the edge by
  its **name** from the scene summary.
- **Combine two bodies:** `boolean` (union/subtract/intersect) by body ids.
- **Place/duplicate a body:** `transform` (translate + single-axis rotate). Set
  `copy: true` to keep the original and emit a moved copy as a new part.
- **Sketch off the base planes:** `add_plane` (offset from a datum/face) → sketch
  on it.
- **Bring in external CAD:** `import_step` with the file's STEP text.

## Best practices

- **Parameterize with variables.** Prefer named variables and expressions
  (`width`, `wall = width/2 - 2`) over magic numbers, so the model stays editable.
  Define the variables first, then reference them in params/dimensions.
- **Constrain sketches** (horizontal/vertical/dimension) so profiles are
  predictable; aim for fully-constrained where it matters.
- **Exploit symmetry** and reference planes instead of repeating manual placement.
- **Name parts and features** meaningfully (`rename`) — future steps and the human
  read those names.
- **Reference by name, verify by sight.** Resolve faces/edges via the summary;
  confirm results with `screenshot` before building on them.
- **Smallest reversible steps.** One feature at a time; the timeline is the audit
  trail.

## Reporting gaps AND bugs (important)

You are also the project's feedback loop. When something blocks or surprises you,
**do not fake geometry or silently work around it** — call **`report_issue`**:

- `kind: "missing_feature"` — the operation you need isn't expressible with the
  available tools (e.g. sweep, loft, linear/circular pattern, "up to face" extrude
  extent, variable-radius fillet, a constraint type, a midplane/angle reference
  plane). *(Revolve, mirror, and symmetric / through-all extrude now exist — use
  those tools.)* Include the goal, what you tried, and a suggested API.
- `kind: "bug"` — a tool did the wrong thing or errored unexpectedly (e.g. a
  remove that didn't cut, a name that didn't resolve, a regen error). Include what
  you did, what you **expected**, what you **observed**, and a minimal repro.
- `kind: "friction"` — it worked but was awkward/inefficient.

These reports are appended to a reviewable log for the developer, so be specific
and concrete. Reporting a gap/bug is a successful outcome, not a failure — it's
how the app improves.

## Worked example (pattern, not literal API)

> "Make a 40×40×10 plate with a 8mm hole in the middle, top edges filleted 2mm."

1. `get_scene_summary` (empty?).
2. Define variables: `w=40, t=10, hole=8, fil=2`.
3. `add_sketch` on Top: a `rect` centred at origin, `w`×`w`; `add_extrude` new,
   distance `t` → the plate body.
4. Sketch a `circle` r=`hole/2` on the plate's top face; `add_extrude` `remove`
   (cuts inward) → the hole.
5. `dress_up` `fillet` size `fil` on the four top edges (by name from the
   summary).
6. `screenshot` to verify; `rename` the part.
