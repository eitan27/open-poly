# Open Poly — Agent Modeling Guide

> This is the "skill" an LLM agent loads to model in Open Poly via the MCP tools
> (Phase 9). Tool names match the live command layer (`src/agent/operations.ts`)
> — keep this file in sync with it. Delivered to clients as an MCP **prompt** +
> **resource** (and a `get_modeling_guide` tool).

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
  `add_sketch` (plane + entities in uv — sugar shapes incl. `spline` (open
  through-point curve, a sweep path) and `text` (a run you can extrude); mark an
  entity `construction:true` to make it reference-only — snapping / a revolve
  axis, never extruded), `add_extrude` (profile + distance + mode
  `new|add|remove` + extent `blind|symmetric|throughAll|upToFace`; profile may be
  a region, a body face, or a `text` entity), `add_revolve` (region + axis +
  angle + optional `symmetric`; axis = a sketch line, a plane, or a body face),
  `add_sweep` (region + path entity), `add_loft` (2+ regions),
  `add_offset` / `add_sketch_mirror` (associative DRIVEN sketch geometry —
  offset a chain, or mirror entities across a sketch line), `add_mirror`
  (3D body + plane), `add_plane`, `transform` (translate/rotate, optional
  `copy`), `boolean`, `dress_up` (chamfer/fillet), `set_param`, `set_appearance`,
  `rename`, `delete`, `select`, `import_step`.
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
  (with the `targetId`) instead of guessing a distance. **`throughAll` is for
  cuts only** (`mode: "remove"`) — it's not offered for new/add.
- **Two-sided / centered feature:** `add_extrude` with `extent: "symmetric"` —
  the profile extrudes `distance` equally both ways (centered on the sketch).
- **Extrude up to a face:** `add_extrude` with `extent: "upToFace"` and
  `upTo: { bodyId, faceName }` (a planar face from `get_scene_summary`) — the
  profile grows until it reaches that face's plane; `distance`/`flip` are ignored
  (the face sets both length and direction). The target face must not be parallel
  to the extrude direction. Prefer this over a guessed distance when one body
  should meet another. Two bodies that end up **sharing a face** (touching, no
  overlap) still `boolean` `union` into one — touching counts as joined.
- **Revolved part (shaft, ring, bowl):** `add_sketch` with the **profile region**
  to one side of an axis (mark a sketch axis line `construction:true` so it isn't
  part of the region and isn't a wall); then `add_revolve` with that region + an
  `axis` and an `angle` (360 for a full solid of revolution, less for a partial;
  add `symmetric:true` to grow the partial evenly both ways of the profile
  plane). The **axis** is whichever is handy: a sketch line `{sketchId,
  entityId}` (get the id from `get_scene_summary`); a plane `{plane: …}` (the axis
  is where it meets the profile plane); or a body face `{bodyId, faceName}`
  (planar face → that intersection; a cylinder/cone face → its own axis, e.g. to
  revolve around an existing shaft). The profile must **not cross** the axis.
- **Mirror a body across a plane:** `add_mirror` (body + plane) → a reflected
  **new** body, original kept. Use it for symmetric parts: build one half, mirror
  it, then `boolean` `union` if you need a single body.
- **Swept solid (pipe, tube, extrusion along a curve):** sketch the **cross-
  section region** and a **path** entity — a `line`/`arc` for a simple sweep, or a
  `spline` (open through-point curve) for a freeform path (the path can be in a
  separate sketch). Then `add_sweep` with `profile` + `path: {sketchId, entityId}`
  (get the path's `entityId` from `get_scene_summary`'s sketch entities). The
  profile is auto-oriented perpendicular to the path at its start.
- **Lofted / transitioning solid (e.g. round→square, a funnel):** sketch each
  **section region** on its own plane (use `add_plane` offsets so they're at
  different heights), then `add_loft` with `profiles: [{sketchId, regionId}, …]`
  in order. Sections on the **same** plane won't loft — give them distinct planes.
- **Embossed / engraved text:** `add_sketch` with a `text` entity (`{shape:
  "text", p: <baseline-left>, value: "ACME", height: 8, rotation?}`), then
  `add_extrude` with profile `{sketchId, textId}` — `mode:"new"` for standalone
  letters, `add` to emboss onto a face, `remove` to engrave into one. The kernel
  bakes the glyph outlines with their counters/holes (the inside of an "O" stays
  hollow), so you don't place any curves yourself.
- **Offset / inset a profile:** `add_offset` (one connected chain of edges +
  signed `distance`) makes a parallel DRIVEN copy that tracks the source — e.g.
  inset a wall, or make a concentric ring (offset a circle, then extrude the
  region between). Output edges are `derived:true` in the summary; they're
  driven (not directly editable) — to change them, edit the source.
- **Mirror sketch geometry:** `add_sketch_mirror` (a sketch line `axisId` + the
  `sourceIds` to reflect) for symmetric profiles — draw half, mirror the rest;
  the copies track the originals. (To mirror a whole solid, use `add_mirror`.)
- **Reuse model geometry in a sketch (project/convert):** projecting existing
  body edges onto the sketch plane is available in the UI (Onshape's "Use") and
  is associative, but there's **no agent op for it yet** — reference the geometry
  you need directly (sketch the profile, or use a body face) instead.
- **Round/bevel an edge:** `dress_up` (`fillet`/`chamfer`) referencing the edge by
  its **name** from the scene summary.
- **Combine two bodies:** `boolean` (union/subtract/intersect) by body ids.
- **Place/duplicate a body:** `transform` (translate + single-axis rotate). Set
  `copy: true` to keep the original and emit a moved copy as a new part.
- **Sketch off the base planes:** `add_plane` → sketch on it. Methods: `offset`
  (parallel to a datum/face at a distance — the default), `midplane` (halfway
  between `base` and `refB`), `angle` (base hinged on its `u`/`v` axis by `angle`
  degrees), or `through` (3 world points).
- **Bring in external CAD:** `import_step` with the file's STEP text.

## Best practices

- **Parameterize with variables.** Prefer named variables and expressions
  (`width`, `wall = width/2 - 2`) over magic numbers, so the model stays editable.
  Define the variables first, then reference them in params/dimensions.
  **Variable names must be letters only** — no digits, spaces, underscores, or
  other symbols, not a reserved math name (`pi`, `sin`, …), and unique. Use
  `wallThickness` / `holeDia` / `outerR`, **not** `wall_thickness`, `r1`, or
  `hole2`; an invalid name is rejected.
- **Predictable sketches.** You can't apply explicit constraints or dimensions
  yet, and agent-drawn entities carry none — a sketch *is* exactly the
  coordinates you give. So place points precisely (axis-aligned where you mean
  it, shared coords where things should meet) and parameterize sizes with
  **variables in feature params** (extrude distance, primitive/revolve dims),
  not magic numbers. Explicit sketch constraints/dimensions are on the roadmap —
  `report_issue(missing_feature)` if you're blocked without them.
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
  available tools (e.g. linear/circular pattern, variable-radius fillet, an
  explicit sketch constraint or dimension — horizontal/vertical/parallel/equal/
  distance/… — trim/extend, projecting model edges into a sketch). *(Revolve
  — incl. symmetric + plane/face axes, 3D mirror, sweep, loft, the spline tool,
  **text** + text-extrude, **offset** and **sketch-mirror** (driven), symmetric /
  through-all / up-to-face extrude, and all `add_plane` methods — offset /
  midplane / angle / through-3-points — exist now; use those tools.)* Include the
  goal, what you tried, and a suggested API.
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
