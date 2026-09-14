# Backlog

## Split (body) — BUILT ON A BRANCH, NEVER MERGED

Cuts a body into two or more **independent** bodies with a plane, a planar body
face, or a sketch line/arc/spline — SolidWorks/Fusion's "Split Body". Distinct
from `boolean subtract`: subtract _discards_ the removed material, Split _keeps
both_ pieces as separate, independently colorable/hideable/renamable/exportable
Parts. (The sibling "Split Face" — dividing a face without separating the solid
— is a different op and was never built.)

**Status: main has no Split feature.** It was designed, implemented, tested and
verified in full on `claude/cad-feature-comparison-jtqv2n`, and never merged.
That branch was deleted on 2026-09-13 in the open-sourcing cleanup; the code
survives in the **local** tag `archive/split-body` (`66cce61`), deliberately not
pushed so the public repo stays clean — which also means it exists on one
machine only. The notes below were written as a shipped-feature record, so they
describe the BRANCH in the past tense, not main.

Two things that branch also carried DID reach main by other routes — don't
re-derive them: **Shell** (`shellNamed`) and the disconnecting-boolean fix
(`explodeToBodies` landed on main as `splitPartsPass`).

**What actually shipped, vs. the original plan below:**

- **Tool = plane OR sketch entity**, both live: `SplitTool = {kind:"plane",
plane: SketchPlaneRef} | {kind:"entity", sketchId, entityId}`
  (`document/types.ts`). A picked body face freezes to a `SketchPlaneRef`
  snapshot exactly like Mirror's "Body face…" (not a live-tracking
  `RevolveAxisFace` — simpler, and it's the established precedent). A sketch
  **line** reduces exactly to a plane (`document.ts` computes
  `origin`/`normal` from the line + its sketch plane's normal — zero-gap,
  same code path as a plane tool); an **arc/spline** is faceted to a polyline
  and becomes a genuinely curved cut (see kernel note below).
- **No `flip` field** — dropped from the original plan. Fragment ordering is
  deterministic (`explodeToBodies`'s descending-volume/bbox-min-corner sort,
  the same convention Boolean's disconnecting-subtract fix shipped), matching
  how Boolean has no "which side" concept either. Rename/recolor a specific
  fragment via the Parts panel or `set_appearance` if you need to tell them
  apart.
- **Kernel: `splitNamed`** (`worker.ts`) — a plane tool uses the two-`Common`
  half-space trick exactly as planned (zero material lost). An entity tool
  has **no `BRepAlgoAPI_Splitter`** to reach for (confirmed absent from this
  OCCT wasm build's bindings) and a curved surface can't boolean reliably as
  a bare face/shell here either — so instead `thickenPolyline` inflates the
  faceted curve into a **hair-thin (5e-4 mm) solid "blade"** (prismed along
  the sketch plane's normal via the existing `prismFromFace`/`ringToBlueprint`
  helpers) and `Cut`s it out. The body loses a negligible sliver where the
  blade passed through instead of a true zero-gap split — verified this stays
  under 0.01 mm on a 40 mm part. Both paths end in `explodeToBodies` (already
  shipped for Boolean) + a `countSolids < 2` check ("the reference doesn't
  cross the body") — volume alone doesn't detect a miss for the `Cut` path
  (an unchanged body has full volume, not zero), which is why the check is on
  solid count, not volume.
- **UI: two-step arming**, exactly as planned but implemented via
  `revolveDialog.armed === "profile"`'s established convention rather than a
  new picking-mode boolean: `splitDialog.armed === "target"` consumes the
  next ORDINARY click (any face/edge/vertex — no `picking` state involved,
  checked directly in `handlePick`); `armed === "tool"` rides the same
  axis-pick stream Revolve's axis arming uses (`pickPurpose: "splitTool"`),
  accepting a sketch line/arc/spline, a body face, or a datum/reference
  plane in one unified click. **⑃ Split**, shortcut `K`.
- **Agent op renamed to `addSplit`** (not bare `split`) mid-design, to match
  the "add" prefix every other body-_producer_ op uses (`addMirror`,
  `addPattern`, …) — `dressUp`/`shell`/`boolean`/`transform` lack the prefix
  because they're in-place modifiers/consumers, a distinction Split didn't
  originally line up against.
- Per-fragment appearance/naming needed **zero new work** — `bodyOverrides` +
  `resolveBodyDisplay`, shipped for Boolean's fix, handled it generically;
  confirmed live in testing (`"Split 1 (2)"`-style derived names, working
  `set_appearance` on a fragment id).
- **Not built** (same gaps the plan called out): live ghost preview during
  arming, the friendlier scored-fallback treatment for a fragment reference
  lost to a later upstream edit (falls through to `requireBody`'s generic
  "source body not found" — functional, not pretty), Split Face, multi-tool
  passes, non-planar/non-sketch-entity surfaces (still needs
  `BRepAlgoAPI_Splitter`, still unavailable).
- Verified against the real OCCT wasm kernel by `scripts/verify-split.mjs`:
  plane split (zero-gap, exact footprint), line-entity split (reduces to
  plane, zero-gap), arc-entity split and spline-entity split (curved blade,
  <0.01 mm material loss on a 40 mm part), edit-in-place, fragment
  appearance persistence, and the "doesn't cross the body" error path.

<details><summary>Original design spec (for reference — see the summary above for what actually shipped and where it diverged)</summary>

### The core call (now shipped as general infrastructure, not Split-specific)

Every existing body-producing feature is 1-feature-id : 1-body-id at the
**Parts-list level** (Phase 1.5's "running-result model" write-up bakes this
in: _"body id = creating-feature id"_), but the underlying shape behind that
one id was **already** routinely a compound of several disjoint solids before
Split existed — Pattern's `compoundOf` (`worker.ts:254`) deliberately bundles
N disjoint solid instances under one body id on every single use, and
`combineBodies` (subtract/intersect) could always disconnect a body (subtract
a box that bisects a plate) and used to still return it as one silent
compound. The real novelty was never "can an op produce disjoint solids" —
it's _decomposing_ that compound into **separate, independently
colorable/hideable/exportable Parts-list bodies** instead of leaving it
bundled, which is exactly the mechanism a Boolean fix needed too (a
disconnecting subtract silently staying one compound body was reported as
wrong behavior, not a Split-only gap) and so **shipped there first, generally
enough for Split to reuse outright:**

- **`explodeToBodies(named)`** (`worker.ts`, next to `combineBodies`) splits
  any (possibly compound) `NamedShape` into one `NamedShape` per
  `TopAbs_SOLID` it contains via `TopExp_Explorer`, partitioning the face-name
  map per piece, in a **deterministic order** (descending volume, ties broken
  by bbox min-corner) so re-splitting unchanged geometry keeps the same
  fragment on the same id run to run. `case "boolean"` calls it whenever
  `countSolids(result.shape) > 1`.
- **Id convention:** fragment 0 keeps the producing feature's own id
  (downstream refs/appearance keep working untouched, no separate "modifier
  vs. producer" distinction needed); fragments 1..N−1 mint
  `"${featureId}~${i}"` (mirrors Pattern's existing `~p{i}` per-instance
  suffix convention, applied to whole bodies instead of sub-names).
- **Per-fragment appearance/name — NOT a per-feature array** (this entry
  originally proposed a `pieces: {color,opacity,hidden}[]` field on the
  feature; that's now superseded by something more general). `Document`
  gained `bodyOverrides?: Record<string, BodyOverride>` — a body-id-keyed
  map, decoupled from which feature (if any) produced the id.
  `resolveBodyDisplay(doc, id)` (`document.ts`) is the single resolver both
  `SolidsList` (Parts panel) and the agent's `get_scene_summary` read
  through: a feature-backed id uses that feature's own fields unchanged; an
  id with no feature falls back to a name derived from the owning feature
  (`"<parent name> (<n+1>)"`, from the `~n` suffix) and a deterministic
  id-hashed color, with any stored `bodyOverrides` entry applied on top.
  `setBodyColor`/`Opacity`/`Hidden`/`renameBody` route to the existing
  per-feature setters for a feature-backed id (zero behavior change) or into
  `bodyOverrides` otherwise; the agent's `setAppearance`/`rename` ops accept
  either kind of id via a `requireBodyId` guard (vs. `requireFeature`, which
  `delete` still correctly uses — a fragment has no independent feature to
  delete, so both the Parts-row ✕ and the agent's `delete` op reject it,
  pointing at editing/deleting the producing feature instead).
- **No core `buildBodies` architecture change was needed** — confirmed by
  actually shipping it: `case "boolean"` already did one `bodies.push`, now
  it loops. The Parts panel was already driven by rendered **meshes**
  (`bodyIds` = `Set(rawMeshes.map(m=>m.id))`), not a 1:1 walk of
  `doc.features`, so `SolidsList` only needed to stop filtering by
  `doc.features` and build rows from `bodyIds` + `resolveBodyDisplay` instead
  — no different in kind from what Split would have needed anyway.
- Verified against the real OCCT wasm kernel by
  `scripts/verify-boolean-split.mjs` (bisecting subtract → 2 disjoint-bbox
  bodies with derived names; fragment appearance/rename persists through
  `bodyOverrides`; deleting a fragment id is rejected; a non-disconnecting
  subtract and a touching union both still yield exactly one body, unchanged).
- **Still open, and STILL Split-specific:** lost fragments on a later
  upstream edit (a fragment that used to exist no longer does, so a
  downstream `targetId` dangles) fall through to `requireBody`'s generic
  "source body not found" — functional (regen fails descriptively, surfaced
  as a timeline error) but not yet the friendlier scored-fallback/warning
  treatment `topoMatch.ts` gives face/edge references. Fine to ship Split
  without it; revisit if it proves annoying in practice.

### Kernel: reuse existing infrastructure almost entirely

No new OCCT concept needed for the v1 (planar) case — this is the same
half-space trick `upToFace`/`upToNext` extrude conforming already uses, which
`BACKLOG.md`'s own shelved cross-section proposal above independently
converged on for its "kernel-exact alternative":

- `halfSpaceBox(q, m, size)` (`worker.ts:980`) already builds a big oriented
  box filling one half-space of a plane through `q` with normal `m` — used
  today to clip an extrude prism flush with a target face's plane.
- `booleanNamed(op, base, tool)` (`worker.ts:1081`) already does `"common"`
  (intersect) and `"cut"` (subtract) with face-name propagation through OCCT
  history — used today by Boolean and by extrude's up-to-face clipping.
- **`explodeToBodies`** (see above) — shipped, reuse directly rather than
  reimplementing the `TopExp_Explorer` walk.
- **`splitNamed(target, planePoint, planeNormal, flip)`** (new, small, the one
  piece Split still needs to write): build `halfSpaceBox` at `+normal` (kept
  side) and `-normal` (removed side, i.e. the same box mirrored) sized by
  `bboxDiagonal(target.shape)` +margin (same `bigReach`-style sizing extrude
  already does); `pieceKept = booleanNamed("common", target, +box)`,
  `pieceCut = booleanNamed("common", target, -box)` (two independent
  `Common`s, not a `Cut`, so BOTH sides keep clean history-based face naming
  off the _original_ target). Fuse `pieceKept`/`pieceCut` into one compound,
  hand it to `explodeToBodies` — fragment count (2, or more on a non-convex
  body) falls out for free, no bespoke logic needed.
- **v1 tool = a plane or a planar body face** (reuse `SketchPlaneRef` +
  `deriveFaceFrame`, exactly Mirror's existing plane-ref union — Mirror's
  dialog is the closest UI/data-model precedent, see below).
- **v2 tool = an arbitrary (non-planar) face/surface or a closed sketch
  profile.** Needs a real `BRepAlgoAPI_Splitter` (OCCT's generalized
  split-by-tool-shapes algorithm) instead of a half-space box — meaningfully
  more machinery (the splitter's own history API differs from
  `BRepAlgoAPI_Common`'s), so it's explicitly out of v1 scope. Don't build it
  until a plane/face split is shipped and used.

### Data model

```ts
export interface SplitFeature extends FeatureBase {
  type: "split";
  /** The body being split (the feature id that produced it). */
  targetId: string;
  /** The cutting plane. */
  plane: SketchPlaneRef;
  /** Which side keeps the target's own id/name/downstream-refs. */
  flip: boolean;
  // No per-piece appearance field — `Document.bodyOverrides` (shipped)
  // already covers it generically, the same way it does for Boolean.
}
```

`resolveFeatures`/`ResolvedFeature` gain a mirrored `"split"` variant exactly
like `"mirror"`/`"shell"` did (bake the plane to `origin`+`normal` via
`frameOf` — nothing else to evaluate, there are no expression-backed params
left now that appearance moved to `bodyOverrides`).

### UI

Closest existing precedent is **Mirror's dialog** (`MirrorDialog`: target +
plane-ref picker, including the "Body face…" arm-a-face-pick flow via
`deriveFaceFrame`) — clone its shape rather than inventing new interaction:
a **⑃ Split** modeling-toolbar button (enabled like `transformTarget`/
`shellTarget` — a single-body selection), a small dialog with the same
plane-ref control Mirror uses + a **Flip** toggle (which side keeps identity)

- a live cyan ghost preview of the cut plane through the body (reuse the
  extrude/revolve ghost pipeline). On commit, the Parts list gains N−1 new rows
  **for free** — `SolidsList` already renders every id in `bodyIds` via
  `resolveBodyDisplay`, so a `case "split"` that pushes N bodies the way
  `case "boolean"` now does needs no Parts-panel work at all; new rows read
  `"Split 1"`, `"Split 1 (2)"`, … automatically. Double-click the timeline row
  re-opens the dialog populated, same edit-in-place pattern as every other
  creation-dialog feature.

No natural bare-letter shortcut is free in the modeling toolbar (the same
constraint Pattern hit — see `src/settings/shortcuts.ts`, which is the whole
table, and whose unit test fails the build if a new entry collides with an
existing one in the same mode); pick an unclaimed letter arbitrarily (e.g.
`K`, free in modeling mode) the way `G` was picked for Shell and `Q` for
construction, rather than forcing a weak mnemonic.

### Agent op

`split {targetId, plane: PlaneRefSpec, flip?}` → `add_split` MCP tool,
auto-registered from the shared zod schema exactly like every other
operation (no `tools.ts` registration-loop change needed, only an
`OP_DESCRIPTIONS.split` entry, mirroring how `shell` was wired). Scene
summary needs no new field — the extra fragment ids just show up as
additional `bodies[]` entries with a resolved name/color, discoverable and
actionable (`set_appearance`/`rename`/further `boolean`/etc., all already
fragment-aware) the same way a Boolean fragment is today.

### v1 scope

Plane (or planar face) split of a single target body into its fragments (2
in the common case, more if the geometry is disconnected by the cut), Flip
to choose the kept identity, edit-in-place, the `split` agent op —
per-fragment appearance/naming is already covered by `bodyOverrides`, nothing
left to build there. **v2:** split by an arbitrary face/surface or a closed
sketch profile (needs `BRepAlgoAPI_Splitter`), the sibling **Split Face**
tool (divide one face into several, no new bodies — a genuinely different
op, closer to a face-level dress-up than to this feature), multi-plane / one
pass with several tools at once.

</details>

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
