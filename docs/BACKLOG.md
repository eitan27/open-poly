# Backlog

## Adjustable cross-section view — SHIPPED 2026-07

One section plane, any plane ref, live drag + numeric offset + flip, stencil
capping, clip-aware picking, persisted across reload, plus the `set_section_view`
MCP op (which is most of the point: `screenshot` only shows the exterior, so
without it the agent can build a bore it can never actually inspect).

**Calls that still bind:**

- **It's view state, not a feature** — it changes no geometry, so it's out of the
  timeline and out of undo. Lives beside `doc` (`document/sectionView.ts` +
  `StoredDoc.sectionView`), not inside the document JSON.
- **Picking must respect the clip.** Three.js clipping is a fragment-shader op;
  the raycaster knows nothing about it, so the pick path needs its own half-space
  test or clicking into the opening selects the invisible back face.
- **Local (per-material) clipping, not global** — global also slices the grid,
  datums, origin marker and view cube. Sketch entities + grid stay exempt.
- **The clip plane never structurally empties**: "off" parks the single
  `THREE.Plane` far away rather than emptying the array, so toggling can't
  trigger a shader recompile.
- **Kernel-exact section curves** (`BRepAlgoAPI_Common` vs a half-space) would
  give snappable cut edges but are far too slow to drag. If ever wanted, layer
  them as a settle pass after the drag ends.

**v2 if asked:** multiple simultaneous planes (corner cuts), exact section
curves. One plane covers the overwhelming majority of real use.

## Sketch inference lines (alignment guides) — SHIPPED 2026-07

Arming a point/line while drawing shows dotted guides, the cursor snaps to them
and to their intersections, and a guide that maps to a real relationship captures
the constraint (H/V/parallel/perpendicular). Pure geometry core is unit-tested
(`src/sketch/inference.ts` + `inference.test.ts`, 13 tests).

**Shipped visual language** (worth preserving — it's the thing that makes snaps
readable, and it's easy to erode):

- Solid blue fat line = real geometry; dashed blue = construction (same width and
  colour, only the dash differs); thin amber dashed = inference guide (a helper,
  not real geometry); purple = derived/associative.
- Anchor square, snap dot and guide share the amber; the constraint badge
  (—/|/⊥/∥) near the cursor is neutral. Snapping onto a construction edge
  highlights it dashed. The opaque preview line renders above the guide so it
  occludes a coincident one.

**Design calls that still bind:** arming is dwell-based, not instant (or you
spray guides); cap ~3 armed refs with a TTL; a constraint only forms against an
**active-sketch entity** — against a body edge it's snap-only, matching Onshape
when there's nothing to constrain.

**Known rough edges (small):**

- **Hysteresis** — the one deferred MVP item. Snap stickiness so competing guides
  don't flicker; best judged by real use.
- The multi-click preview polyline shows no marker at the in-progress vertex
  unless a guide/snap is active.

## Kernel: booleans fail on ANALYTIC primitive curved surfaces (not all curves)

**Status:** investigated 2026-07; **re-verified via a validation spike 2026-07-25/26 — the
finding stands, faceting is required** (see "Re-investigated" below). Root cause of why
extruded circles/arcs are faceted. Not a fix — a finding + the shipped workaround.

### The finding (all tested in-app)

This OCCT wasm build fails booleans **specifically on analytic primitive surfaces vs a
plane** — NOT on curvature in general:

| Boolean                                                     | Result                                  |
| ----------------------------------------------------------- | --------------------------------------- |
| box − box, box ∪ box                                        | ✅ works                                |
| faceted-cylinder − box (an extruded-circle cut today)       | ✅ works                                |
| **primitive cylinder (`gp_Cyl`) − box / ∪ box**, any offset | ❌ `StdFail_NotDone`                    |
| **sphere − box**                                            | ❌ `StdFail_NotDone`                    |
| coaxial cylinders subtract                                  | ❌ `StdFail_NotDone`                    |
| **B-spline swept solid (circle-along-spline) − box**        | ✅ works (4-face smooth tube)           |
| B-spline swept tube ∪ scoop (the shipped chute)             | ✅ works (just slow — see `BOOL_FUZZY`) |

So it's the surface **representation**, not curvature: an analytic `gp_Cyl`/sphere against
a plane chokes OCCT's boolean here; a B-spline curved surface booleans fine.

### Why this shapes the app

- **Extrude builds its profile face from the faceted `outline` polyline** (never the exact
  `segments` that sweep/loft pass), so an extruded **circle OR arc is a polygonal prism** —
  e.g. an extruded half-disc is 51 faces. That's deliberate cover: the faceted (planar)
  wall keeps cuts/bosses working.
- **Making extrude smooth by passing `segments`** (tried, reverted) turns the wall into an
  analytic `gp_Cyl` → the exact surface type that can't be booleaned → every circle cut/boss
  breaks. Confirmed a primitive cylinder − box also fails, so it's not the construction.
- **Sweep/loft are smooth AND booleanable** because they emit B-spline surfaces.

### FIXED 2026-07 — the primitive cylinder + body-face extrudes are faceted too

The remaining analytic-cylinder holes are closed by extending the faceting the app already
did for extruded circles:

- **`buildPrimitive` cylinder = a faceted `CIRCLE_FACETS`-gon prism** (`facetedCylinderShape`
  in `worker.ts`), not `makeCylinder`'s `gp_Cyl`. So `cylinder − box`, `cylinder ∪ box`,
  and cutting/bossing a cylinder's own cap all boolean fine now. Looks identical to an
  extruded circle (already faceted); diameter readout preserved by teaching
  `extrudedCircleRadius` to read a primitive cylinder's `radius` param.
- **Extruding a curved body face** (`facetedProfileFace`) rebuilds the profile as a faceted
  planar face (sampling the boundary wires via OCCT `GCPnts_TangentialDeflection`) before
  prisming, so the extruded wall is planar → booleanable. Straight-edged faces are untouched.
- **Revolve is a faceted loft too** (`facetedRevolveFromFace`): a ruled `BRepOffsetAPI_
ThruSections` through `CIRCLE_FACETS` rotated copies of the profile's outer wire, instead
  of `BRepPrimAPI_MakeRevol`'s analytic surfaces of revolution. So a revolve body now
  cuts/fuses like any other (extruding a revolve face used to fail `StdFail_NotDone`). Falls
  back to analytic `MakeRevol` for the two cases the ruled loft can't do — a profile with
  **holes** (ThruSections is one wire/section) or one **touching the axis** (pole degenerates);
  those stay smooth-but-unbooleanable, as before. NB replicad `outerWire()`/`innerWires()`
  DELETE their receiver — always call on a `.clone()`.
- `NurbsConvert`/`ShapeCustom` are NOT in this wasm build (checked), so B-spline conversion
  of analytic surfaces isn't available — faceting is the fix within this build. **Sphere is
  still analytic** (`makeSphere`) so sphere booleans still fail; faceting a sphere needs a
  UV-meshed solid, not a 2D-prism, so it's left for later. Verified by
  `scripts/verify-circular-extrude.mjs` (cylinder + curved-face + revolve cases).

### Shipped workaround (diameter readout only)

`measure.ts` `extrudedCircleRadius` traces a face named `{extrudeId}/start|end|side{n}`
back to its source sketch circle and reads the radius, re-derived every regen (tracks
variable + timeline edits). Correct diameters on faceted extruded circles without touching
geometry. Geometry stays a faceted prism.

### Re-investigated 2026-07-25/26 — validation spike CONFIRMS faceting is required

Before building a "logical-face layer" to fix the circular selection/snapping UX, we
questioned whether the analytic-boolean blocker still held. Ran a real spike: gated all
faceting behind an `ANALYTIC_CURVES` flag (`facetedCylinderShape`→`makeCylinder`, skip
`facetedProfileFace`, skip `facetedRevolveFromFace`, send exact arc `segments` on
extrude/revolve profiles), flipped it ON, and ran `scripts/verify-circular-extrude.mjs`
against the live app.

**Result: 5 real `StdFail_NotDone` failures** — `cylinder − box`, `cylinder ∪ box`,
`extrude cylinder cap (remove)`, `cut a face of a 360°/90° revolve` — i.e. exactly the
finding above. Faceting is required; the spike was reverted, nothing shipped.

**False-negative trap (record this):** those analytic booleans FAIL in the full app pipeline
but PASS in isolation. A Node harness AND a direct in-browser call of the _same_ ops
(`makeCylinder − makeBaseBox`, sphere − box, coaxial subtract, even the exact
`cyl(18,40) ∪ box(20,20,60)` / `− box(12,12,80)` geometry) all returned `done=true` valid
solids — and stayed green after replicating `translate(0,0,0)`, face-naming, and per-face
meshing. Only the full pipeline (`buildBodies` fold + running body set + history propagation)
reproduces the failure; the exact ingredient that trips OCCT is unidentified. **Do not judge
whether faceting can be dropped by an isolated boolean probe — it will lie.**

**Consequence:** the circular/cylindrical selection + snapping UX must be solved with a
logical-face layer OVER the facets (group facet faces/edges into one logical cylinder/circle;
synthesize analytic centre/radius), NOT by switching to analytic geometry.

### Promising avenue for true round holes/bosses (not attempted)

The blocker is the analytic `gp_Cyl`, not curvature. Building an extruded circle as a
**B-spline** wall (pipe/sweep-style construction rather than a straight prism of an analytic
circle) may give a smooth wall that _also_ cuts — the way the swept tube does. Separate
investigation; more promising than "faceting is forced." A newer OCCT wasm that fixes the
analytic-vs-plane boolean would also solve it. `BOOL_FUZZY` at 0.01 does NOT help (algorithm
failure, not tolerance).

_Version check 2026-07-25:_ we are on the latest replicad — `replicad@0.23.1` /
`replicad-opencascadejs@0.23.0` (pinned since commit 0, never bumped) — bundling OCCT
~7.7–7.8; latest OCCT is 7.9.3 (Dec 2025). There is **no drop-in newer wasm**: OCCT 7.9.x
means a custom `opencascade.js` build, and whether it fixes this is speculative — stock OCCT
booleans cylinder−box fine (and so does this build _in isolation_), so the pipeline-specific
failure may not be a version bug at all.

## Shelved: viewport geometry reuse (Opt A) + lazy-regen-on-load (Opt B)

**Status:** shelved on branch `shelved/viewport-geom-reuse-and-lazy-regen`
(commits `c3b1839` = Opt A, `183d370` = Opt B), off `feat/step-import-oom-and-reference`.

**Why shelved:** isolated micro-benchmarks showed gains (A saved ~1.5–8 ms CPU +
11–69 MB GPU re-upload per unchanged body per regen; B skipped the whole initial
regen on load), but **in real use the UI felt slower and CPU worked harder** with
both applied. Backed out until we understand the regression; the transfer/typed-array
and per-face-mesh work (through `5d71c08`) is unaffected and stays.

### What they were

- **Opt A — reuse geometry for unchanged bodies.** Worker stamps each mesh with its
  content hash (`ShapeMeshPayload.key = b.key`); the viewport caches three.js geometry
  per body (`SceneState.bodyGeoms`) and reuses it when the key is unchanged, instead of
  disposing + rebuilding every body's geometry each regen.
- **Opt B — lazy regen on load.** When a document boots with a cached mesh, paint it and
  SKIP the initial full regen (`deferInitialRegenRef`); the first edit re-triggers a
  normal regen.

### Hypotheses for the regression (investigate before re-attempting)

- **B likely backfires via a cold worker cache.** The worker's `meshCache` is keyed by
  `b.key`. Before B, the on-load regen _warmed_ that cache, so later edits got cache hits
  for unchanged bodies (e.g. the heavy import) and were cheap. B skips that regen, so the
  cache starts empty — the **first edit after reload re-tessellates the whole 80k-face
  import from scratch** (slow + CPU spike) at a worse moment than a background load regen.
  Reload-then-edit is the common flow, so this probably dominates the "feels slower."
- **A only helps if `ShapeMeshPayload.key` is actually stable across regens for unchanged
  bodies.** If `b.key` churns (e.g. changes when an unrelated feature edits), A never
  reuses AND adds per-regen `Map`/dispose bookkeeping + allocations — pure overhead.
  Check the reuse hit-rate first (the `?perf` log prints `N rebuilt, M reused`); if
  `M` is ~0 while editing with the board loaded, the key isn't stable and A is all cost.
- The two may compound (B leaves things cold; A churns).

### How to re-attempt / verify properly

- Measure **end-to-end in the browser**, not isolated pieces: use `?perf` (regen
  round-trip + viewport rebuild/reuse counts) and the DevTools Performance panel to
  capture actual frame times + CPU during the real flows.
- Test specifically: **reload → immediately edit** (B's worst case), and **edit a small
  feature with the heavy board loaded** (A's target case — confirm `M reused` > 0).
- For B, consider warming the worker cache in the background _without_ blocking, or
  persisting/reusing the import's built body across reloads, rather than deferring the
  whole regen.

### How to restore

`git cherry-pick c3b1839 183d370` onto the working branch, or work directly on the
`shelved/viewport-geom-reuse-and-lazy-regen` branch.
