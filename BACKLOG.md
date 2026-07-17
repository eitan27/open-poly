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
