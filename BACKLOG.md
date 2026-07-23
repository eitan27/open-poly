# Backlog

## Proposed: adjustable cross-section view

**Status:** design sketch, not started.

**What:** a section view — pick a plane, drag it through the model, see the interior.
Onshape's "Section view".

### The core call: view state, NOT a feature
It changes nothing about the geometry — not mass properties, not export, not what a
downstream feature sees. So it must **not** go in the timeline (rollback/reorder would
interact with it in ways nobody wants) and **not** in undo. It lives in document meta
(so it survives reload) as a view mode, toggled from the toolbar.

### Interaction
- Plane ref reuses the existing `add_sketch` plane union (`{datum}` / `{planeId}` /
  `{bodyId, faceName}`) — the resolution code and agent schema already exist.
- Default: Front datum through origin; if a face/plane is selected, use that.
- Drag handle along the normal + numeric offset field + flip. **Live drag is the point** —
  the real use is scrubbing through a part hunting for a too-thin wall.

### Rendering, two stages (ship both; stage 1 alone looks like a bug)
1. **GPU clipping.** A `THREE.Plane` on the body materials with
   `renderer.localClippingEnabled = true`. Use **local** (per-material) clipping, not
   global `renderer.clippingPlanes` — global also slices the grid, datum planes, origin
   marker and view cube. Materials are already centralized (`Viewport.tsx:247-265`), so
   assigning the plane to just the body + edge materials is contained.
2. **Capping.** Raw clipping makes solids look hollow (you see the inside of the far
   wall, unlit, no material at the cut). Standard fix is the stencil-buffer trick: render
   back faces to stencil, draw a cap quad through it. Real-time, no kernel work. Fiddly
   with multiple bodies (needs a stencil pass per body to keep per-body colors).

**Kernel-exact alternative** (`BRepAlgoAPI_Common` vs a half-space, or OCCT section
curves) gives true cut edges you could snap/dimension to, but is far too slow to drag and
would re-run every regen. If wanted later, layer it as a "settle" pass: GPU-clip while
dragging, exact curves once the drag ends. Not v1.

### Gotchas
- **Picking must respect the clip.** Three.js clipping is a fragment-shader op — the
  raycaster knows nothing about it. Sectioned, clicking into the opening selects the
  invisible back face. Needs a half-space test in the pick path. Not optional; this is
  what would make the feature feel broken.
- **Sketch mode:** keep the section (sketching on an interior face is a real use), but
  exempt sketch entities + grid from the clip, same as datums.
- **Fat lines:** outlines use `LineSegments2`/`LineMaterial` (`Viewport.tsx:5-6, 252`), a
  custom shader. Clipping works but the plane must be assigned explicitly — easy to miss,
  and you'd get edges floating in the cut-away void.

### Why it matters for the agent (arguably the real prize)
`screenshot` only shows the exterior, so the agent cannot verify interiors — it can build
a bushing and confirm the sketch region area, but never *see* that the bore is right. A
`set_section_view` MCP op (plane ref, offset, flip, on/off) with `screenshot` rendering
through it turns the guide's read→plan→one-op→**verify** loop from "the outside looks
plausible" into real inspection. Cheap once the view state exists — same state the UI
toggle writes. Rare case where agent value and human value point the same way.

### v1 scope
One section plane, any plane ref, live drag + offset + flip, stencil capping in a flat
neutral color, clip-aware picking, persisted in doc meta, plus the MCP op.
**v2:** multiple simultaneous planes (corner cuts), exact section curves. Resist multiple
planes until asked — one plane covers the overwhelming majority of real use.

## Sketch inference lines (alignment guides) + snap-clarity fixes

**Status:** SHIPPED 2026-07 (Part 0 + Part 1 MVP, deployed). Only **hysteresis** remains
(deferred — snap stickiness so competing guides don't flicker; best judged by real use).
Commits: `e7a1dae` (Part 0), `c9c24df` inference core + tests, `840df13` viewport wiring,
`5855717` parallel/perp constraint capture, `741328f` badge, `ed214ae` bounded guide,
`5ff2feb` anchor square + fat guide, `d9167bd` fat preview line, `6e087ae`/`6a8a275`/
`ce78081`/`837791c` styling (construction fat-dashed, guide amber+thin, dashed construction
snap highlight, neutral badge, preview occludes guide). Pure geometry core is unit-tested
in `src/sketch/inference.ts` + `inference.test.ts` (13 tests); the rest is viewport
rendering verified in-app.

**Shipped visual language** (see also the line/vertex table below, kept in the code):
- Solid blue fat line = real sketch geometry; dashed blue fat line = construction (same
  width/colour, only the dash differs); thin amber dashed = inference guide (a helper, not
  real); purple = derived/associative.
- Anchor square + snap dot + guide line share the amber; the constraint badge (—/|/⊥/// near
  the cursor) is neutral. Snapping onto a construction edge highlights it dashed.
- The opaque preview line renders above the guide (renderOrder 10.5) so it occludes a
  coincident guide.

**Known follow-ups / rough edges (small):**
- Guides can render while the **Select** tool is active (not only while drawing) — minor,
  gate to draw-tools if it bothers.
- The multi-click preview polyline doesn't show a marker at the in-progress vertex unless a
  guide/snap is active (see the vertex table).
- Hysteresis (the one deferred MVP item).

<details><summary>Original design spec (for reference)</summary>

**Status:** designed 2026-07 (this spec), not started. Two parts — a small visual-clarity
fix that should land FIRST, then the inference system.

### Part 0 — snap visual clarity (small, prerequisite)
Sketch mode forces every body to 16% opacity (`sketchDimActive` → `opacity = 0.16`,
`Viewport.tsx:2230`). Snapping is already **coplanar-only** (candidates pass an `onPlane`
test, `Viewport.tsx:~2583`, 0.05mm tol) — you can NEVER snap to a parallel face's edge — but
the see-through body makes it LOOK ambiguous. Purely cosmetic fixes:
- **Tint the active sketch face** (faint fill on the exact face being sketched) so the plane
  is unmistakable. Primary fix.
- **Light up the whole coplanar edge on an edge-snap** (not just today's dot `snapMarker`),
  so you see it's a real in-plane edge and its extent.
Do this before inference — guides only feel good when you can see what you're snapping to.

### Part 1 — inference lines
While drawing, hovering a key point/line **arms** it as a reference; moving away shows dotted
**guide lines**; the cursor snaps onto a guide; where two guides cross, that **intersection
is snappable**; and a guide that maps to a real relationship captures the **constraint**.

**Fits existing code.** `resolveSnap` (`Viewport.tsx:~1516`) already does a weak version:
step 3 computes H/V of the draft segment relative to the last point (`ref`) and
`handleSketchClick` (`App.tsx:3659`) captures it as a `horizontal`/`vertical` constraint.
Inference generalizes both. Reuses `snapPointsRef`/`snapLinesRef` (coplanar candidates),
`SNAP_PX=12`, `ANGLE_SNAP` (~3.4°), `snapMarker`, and the hv→constraint path.

**Two mechanically-different snap kinds (don't conflate):**
- **Positional guide** — a line THROUGH an armed point; snapping means the cursor lies on it.
  From a bare point: horizontal + vertical. From a point-on-line: also perpendicular +
  parallel/collinear through that point.
- **Directional (angle) snap** — the segment being drawn matches a direction, pivoting on the
  fixed draft start; the cursor sweeps a ray. This is today's H/V step generalized: check the
  draft angle against {0°, 90°} PLUS {θ, θ+90°} of each **armed line** → parallel / perpendicular
  to an existing line. (Arming = dwell-hover a line's body; highlight it.) This is the
  "draw a wall parallel to another wall" case and is high value.

**Arming model.** Dwell (~120–200ms) to arm a point or a line, Onshape-style (not instant, or
you spray guides). The draft's last point is always an implicit anchor. Cap ~3 armed refs
(LRU); age out after a few seconds; clear on tool change / Escape.

**Guide-intersection snapping.** For each pair of active guides, snap to their intersection
(skip near-parallel); also guide×coplanar-edge and guide×draft-segment intersections. An
intersection carries BOTH meanings.

**Precedence (highest first), with hysteresis so it doesn't flicker/jump:**
1. exact vertex/key point → 2. guide∩guide and guide∩edge intersection → 3. on a coplanar
edge → 4. single positional guide → 5. directional/angle snap (H/V/parallel/perp — same tier
as today's H/V) → 6. free. Once snapped, require extra px past tolerance before releasing.

**Constraint capture** (via existing `addSketchConstraints`): H→`horizontal`, V→`vertical`,
perp-guide→`perpendicular`, parallel(guide or angle)→`parallel`; an intersection captures both.
Confirmed available: horizontal/vertical/parallel/perpendicular/equal/tangent/coincident/
pointOnLine/midpoint. **Two gaps to decide before MVP:** (a) **collinear** to an edge — no such
constraint; express as `parallel`+`pointOnLine` or add one. (b) A constraint only forms when the
reference is an **active-sketch entity** (we have its id, like today's `activeId ? e.id`);
against a **body edge** (parallel-to-a-body-edge, point-alignment) it's **snap-only** (places the
geometry, no persistent constraint) — matches Onshape when there's nothing to constrain. Option:
auto-project the body edge into the sketch first, then constrain. Default MVP: snap-only.

**Rendering.** Dotted guide (dashed `LineMaterial`, muted, distinct color per meaning),
constant-pixel dashes; an inference **badge** near the cursor (`—`/`|`/`⊥`/`∥`) so captured
constraints are predictable; intersection marker reuses `snapMarker` in a distinct color;
fade in on arm, out on disarm.

**Data / structure.** `inferenceAnchorsRef: { uv; lineDir?; sourceId?; armedAt }[]`. Pure,
unit-testable helpers: `guidesForAnchor`, `snapToGuides`, `guideIntersections`, and an
arbitration `resolveSnapV2` extending the current return with a `meanings` field.

**MVP scope (agreed):** hovered-point positional guides (H/V + perp/parallel from a
point-on-line); **armed line-direction references → parallel/perpendicular angle snap of the
drawn segment**; guide∩guide + guide∩edge intersection; capture H/V/perp/parallel; dotted
guides + badges; precedence + hysteresis.
**v2:** tangent guides, arc/circle quadrant anchors, point-to-point alignment (+ optional
auto construction line), symmetry inference, collinear constraint.

**Tests.** Unit (pure): guide generation per anchor kind, cursor→guide projection + tol,
guide/guide & guide/edge intersection, arbitration precedence + hysteresis, meaning→constraint
mapping. e2e: draw a line, hover another line's endpoint, move perpendicular → assert dotted
guide + a `perpendicular` constraint; arm a line, draw parallel → assert `parallel`; two
anchors → assert intersection snaps.

**Risks.** (1) FEEL — precedence + hysteresis tuning needs iteration in the real app, not just
unit tests. (2) Clutter — the arm-dwell, ~3-ref cap, and TTL are what keep it from being a
light show; err toward fewer, stickier guides. (3) The two constraint gaps above.

</details>

## Kernel: booleans fail on ANALYTIC primitive curved surfaces (not all curves)

**Status:** investigated 2026-07; root cause of why extruded circles/arcs are faceted.
Not a fix, a finding + the shipped workaround.

### The finding (all tested this session, in-app)
This OCCT wasm build fails booleans **specifically on analytic primitive surfaces vs a
plane** — NOT on curvature in general:

| Boolean | Result |
|---|---|
| box − box, box ∪ box | ✅ works |
| faceted-cylinder − box (an extruded-circle cut today) | ✅ works |
| **primitive cylinder (`gp_Cyl`) − box / ∪ box**, any offset | ❌ `StdFail_NotDone` |
| **sphere − box** | ❌ `StdFail_NotDone` |
| coaxial cylinders subtract | ❌ `StdFail_NotDone` |
| **B-spline swept solid (circle-along-spline) − box** | ✅ works (4-face smooth tube) |
| B-spline swept tube ∪ scoop (the shipped chute) | ✅ works (just slow — see `BOOL_FUZZY`) |

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

### Promising avenue for true round holes/bosses (not attempted)
The blocker is the analytic `gp_Cyl`, not curvature. Building an extruded circle as a
**B-spline** wall (pipe/sweep-style construction rather than a straight prism of an analytic
circle) may give a smooth wall that *also* cuts — the way the swept tube does. Separate
investigation; more promising than "faceting is forced." A newer OCCT wasm that fixes the
analytic-vs-plane boolean would also solve it. `BOOL_FUZZY` at 0.01 does NOT help (algorithm
failure, not tolerance).

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
  `b.key`. Before B, the on-load regen *warmed* that cache, so later edits got cache hits
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
- For B, consider warming the worker cache in the background *without* blocking, or
  persisting/reusing the import's built body across reloads, rather than deferring the
  whole regen.

### How to restore
`git cherry-pick c3b1839 183d370` onto the working branch, or work directly on the
`shelved/viewport-geom-reuse-and-lazy-regen` branch.
