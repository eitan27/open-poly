# Backlog

## Split (body) — TODO

Cut one body into two or more **independent** bodies with a plane, a planar body
face, or a sketch line/arc/spline — SolidWorks/Fusion's "Split Body". Distinct
from `boolean subtract`, which discards the removed material: Split keeps both
pieces as separate, independently colorable/hideable/renamable/exportable Parts.
("Split Face" — dividing a face without separating the solid — is a different
op, closer to a face-level dress-up. Not this feature.)

**Most of the infrastructure is already on main — reuse it, don't re-derive it.**
Boolean needed the same decomposition (a subtract that bisects a plate used to
stay one silent compound body), so it shipped there first, generally enough:

- `splitPartsPass` / `explodeToBodies` (`worker.ts`) explodes a compound
  `NamedShape` into one per `TopAbs_SOLID`, partitioning the face-name map, in a
  deterministic order (descending volume, ties by bbox min-corner) so an
  unchanged re-split keeps each fragment on the same id.
- **Id convention:** fragment 0 keeps the producing feature's id, so downstream
  refs and appearance keep working; the rest mint `"${featureId}~${i}"`.
- `Document.bodyOverrides` + `resolveBodyDisplay` already give per-fragment
  colour/name/hidden generically, body-id-keyed and independent of which feature
  produced the id. The Parts panel builds rows from rendered mesh ids, not from
  `doc.features`, so N−1 new rows appear with no Parts-panel work.
- `halfSpaceBox` and `booleanNamed` (`worker.ts`) are the kernel primitives.

**Kernel.** Two paths, and the second is the one with teeth:

- **Plane (or planar face):** two independent `Common`s against opposing
  half-space boxes sized off `bboxDiagonal` + margin — _not_ a `Cut`, so both
  sides keep clean history-based face naming off the original target. Zero gap.
- **Sketch entity:** a **line reduces exactly to a plane** (derive
  origin/normal from the line and its sketch plane's normal; same code path).
  An **arc or spline** does not, and there is no `BRepAlgoAPI_Splitter` in this
  OCCT wasm build — confirmed absent from the bindings — nor will a bare curved
  face/shell boolean reliably here. Facet the curve, inflate it into a hair-thin
  (~5e-4 mm) solid blade prismed along the sketch plane's normal, and `Cut` it.
  Costs a negligible sliver instead of a true zero-gap split: measured under
  0.01 mm on a 40 mm part.
- **Guard on solid count, not volume.** A `Cut` that misses the body leaves it
  at full volume, so only `countSolids(result) < 2` detects "the reference
  doesn't cross the body".

**Data model.** `SplitTool = {kind:"plane", plane: SketchPlaneRef} |
{kind:"entity", sketchId, entityId}`; a picked body face freezes to a
`SketchPlaneRef` snapshot, as Mirror's "Body face…" does. `resolveFeatures`
gains a `"split"` variant like `"mirror"`/`"shell"`. **No `flip` field** —
fragment order is already deterministic, and Boolean has no "which side"
concept either; tell fragments apart by renaming one in the Parts panel.

**UI.** Clone Mirror's dialog rather than inventing interaction: target + the
same plane-ref control. Two-step arming fits the existing `armed` convention
(`armed === "target"` consumes the next ordinary click; `armed === "tool"`
rides the axis-pick stream Revolve uses, taking a sketch entity, body face or
datum plane in one unified click). No bare letter has a good mnemonic — pick a
free one the way `G` went to Shell, and let `shortcuts.test.ts` catch a clash.

**Agent op:** `addSplit` — the `add` prefix is what body _producers_ use
(`addMirror`, `addPattern`); the bare names are in-place modifiers. Auto-
registers from the shared zod schema; only needs an `OP_DESCRIPTIONS` entry.
Scene summary needs no new field — fragments surface as ordinary `bodies[]`.

**Known gaps to accept or fix.** A fragment reference orphaned by a later
upstream edit falls through to `requireBody`'s generic "source body not found"
rather than the scored fallback `topoMatch.ts` gives faces and edges —
functional, not friendly. No ghost preview during arming. v2, needing a real
`BRepAlgoAPI_Splitter`: split by an arbitrary surface or closed profile, and
multi-tool passes.

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

**Gap: that workaround covers extrudes only.** `measure.ts` has two ways to
recover a radius the B-rep no longer carries — feature params for a primitive
cylinder, and `extrudedCircleRadius` above for an extruded sketch circle. A
**revolve has neither**, and nor does a loft. So selecting a revolved tube's bore
or its annular cap shows Area and nothing else: `faceSurfacesFrom` finds no
circular wire to classify (a revolved tube is ~384 flat faces), and no fallback
picks it up. The cap still reports the right _area_, because `clusterArea` sums
the facet cluster — which is why this reads as "the diameter row is missing"
rather than as anything being wrong.

Not a regression: it has been true since revolve started faceting, and the
checks in `scripts/verify-face-diameter.mjs` that used to assert an analytic
annulus were written before that and were simply stale (fixed 2026-09-14; they
now assert the gap and point here). The fix, if it is worth doing, is a third
fallback of the same shape: trace a revolved face back to its profile + axis and
compute the radius. Small and self-contained — the reason it has stayed open is
that nothing surfaces it until someone selects a bore.

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

## Viewport geometry reuse + lazy regen on load — TODO, and a trap

Two independent render/startup optimizations. **Both have been measured in
isolation and both look good there; the warning below is the whole point of
this entry.**

- **Opt A — reuse geometry for unchanged bodies.** The worker stamps each mesh
  with its content hash (`ShapeMeshPayload.key`); the viewport caches three.js
  geometry per body (`SceneState.bodyGeoms`) and reuses it when the key is
  unchanged, instead of disposing and rebuilding every body's geometry each
  regen. Isolated gain: ~1.5–8 ms CPU and 11–69 MB of GPU re-upload per
  unchanged body per regen.
- **Opt B — lazy regen on load.** When a document boots with a cached mesh,
  paint it and skip the initial full regen (`deferInitialRegenRef`); the first
  edit triggers a normal one. Isolated gain: the entire load regen.

**The trap: built together, they made the UI feel slower and work the CPU
harder in real use.** Settle both hypotheses before writing either:

- **B probably backfires through a cold worker cache.** The worker's `meshCache`
  is keyed by `b.key`, and the on-load regen is what _warms_ it, so later edits
  get cache hits for unchanged bodies. Skip that regen and the cache starts
  empty — the first edit after a reload re-tessellates the whole 80k-face import
  from scratch, at a far worse moment than a background load regen.
  Reload-then-edit is the common flow, so this likely dominates.
- **A only pays if `ShapeMeshPayload.key` is stable across regens** for bodies
  that did not change. If it churns, A never reuses anything and still adds
  per-regen `Map`/dispose bookkeeping. **Check the hit rate first:** `?perf`
  logs `N rebuilt, M reused`. If `M` is ~0 while editing with a heavy document
  loaded, the key is not stable and A is all cost — don't build it.

**Measure end to end in the browser**, not in isolation: `?perf` plus the
DevTools Performance panel, over the two flows that matter — reload then
immediately edit (B's worst case), and a small edit with a heavy import loaded
(A's target case, where `M reused` must be > 0).

For B specifically, prefer warming the worker cache in the background _without_
blocking, or persisting the import's built body across reloads, over deferring
the regen at all.
