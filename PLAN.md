# Open Poly — Architecture & Delivery Plan

A local-first, browser-based parametric CAD. This document
captures the core technical decision (which engine/kernel), the architecture, and
a phased roadmap to deliver the requested feature set.

---

## 0. The most important decision: the geometry kernel

The kernel must be a real **B-rep** (boundary representation) engine so that
faces, edges, and vertices are first-class, selectable topology — the whole UX
is "click this face, fillet that edge," which mesh/CSG engines can't give.

**The kernel — OpenCascade (OCCT):** the de-facto open-source B-rep CAD kernel
(it powers FreeCAD, KiCad's 3D viewer, etc.). It is compiled to WebAssembly as
**`opencascade.js`**, so it runs entirely in the browser. It gives you,
directly:

| Your feature        | OCCT API |
|---------------------|----------|
| Sketch → face       | `BRepBuilderAPI_MakeEdge/MakeWire/MakeFace` |
| Extrude             | `BRepPrimAPI_MakePrism` |
| Revolve             | `BRepPrimAPI_MakeRevol` |
| Sweep               | `BRepOffsetAPI_MakePipe` / `MakePipeShell` |
| Loft                | `BRepOffsetAPI_ThruSections` |
| Fillet              | `BRepFilletAPI_MakeFillet` |
| Chamfer             | `BRepFilletAPI_MakeChamfer` |
| Boolean (union/cut/intersect) | `BRepAlgoAPI_Fuse/Cut/Common` |
| Mirror / pattern transforms   | `gp_Trsf` + `BRepBuilderAPI_Transform` |
| Selection (faces/edges) | `TopExp_Explorer`, `TopoDS` topology |
| Tessellation for rendering | `BRepMesh_IncrementalMesh` → triangles |
| Export                | `STEPControl_Writer`, `StlAPI_Writer`, IGES |

**Rendering** is then just **three.js** (WebGL): you tessellate OCCT shapes into
triangle buffers and hand them to three.js. OCCT is the *kernel*; three.js is the
*viewport*. These are two different layers — don't conflate them.

**Accelerator (recommended):** **`replicad`** is a small MIT-licensed TypeScript
wrapper over `opencascade.js` with an ergonomic fluent API
(`draw().circle().sketchOnPlane().extrude(10)`) plus ready-made tessellation and
STEP/STL export. (`CascadeStudio` is an older reference project showing
`opencascade.js` + three.js wired together.)

### Kernel strategy for the long term: own a thin facade
Decision: **define our own `Kernel` interface that the whole app talks to, back it
with `opencascade.js` directly, and use `replicad` as an accelerator + reference —
never as the load-bearing core.** Rationale:

- replicad is tuned for **code-CAD** (programmatic models), which is a *different
  problem* from an **interactive feature-tree modeler with topological selection**.
  The mismatch bites exactly at our hardest requirement — **topological naming**,
  which needs OCCT history maps (`BRepAlgoAPI::Modified/Generated/IsDeleted`,
  `TopExp_Explorer`, sub-shape indexing) that replicad mostly doesn't surface.
- replicad is effectively single-maintainer (bus-factor risk for a multi-year
  codebase), and the auto-generated opencascade.js bindings don't expose all of
  OCCT — serious features eventually need a custom WASM build with extra bindings.
- But going 100% raw on day one is needless pain: OCCT WASM objects require
  **manual memory management** (every intermediate `TopoDS_Shape`/`gp_*` is an
  Emscripten-heap object you must `.delete()` or you leak the heap). replicad's
  dispose/GC-scope pattern and its tessellation-with-face-groups code are exactly
  what we'd otherwise spend weeks rediscovering.

**The hybrid plan:**
1. Define a `Kernel` interface (`extrude`, `revolve`, `fillet`, `boolean`,
   `tessellate → {positions, faceGroups}`, `exportStep`, …). The app, worker
   messages, and document model talk **only** to this — replicad/OCCT never leak
   into app code.
2. **Phases 0–2:** implement the facade on top of replicad to move fast; **read
   replicad's source as a teacher** (memory management, tessellation), borrowing
   patterns (MIT permits it).
3. **Phase 3+:** progressively replace the facade's internals with **direct
   `opencascade.js`** wherever we need history tracking, sub-shape mapping, or
   features replicad doesn't expose — using one disciplined "allocation scope" per
   operation so raw OCCT doesn't leak. Because everything always went through our
   boundary, this is an incremental swap, not a rewrite.

### 2D sketch constraint solver
Constraints (coincident, parallel, perpendicular, horizontal/vertical, equal,
distance, angle, radius, tangent, symmetric) need a **geometric constraint solver
(GCS)**, separate from the 3D kernel.
- **`planegcs`** — a WASM/TypeScript port of FreeCAD's GCS, purpose-built for
  exactly this. Recommended. *(Check its license — FreeCAD's GCS lineage is
  LGPL; confirm it's compatible with your project's license before committing.)*
- Fallback for MVP: a hand-rolled Newton–Raphson solver over constraint residual
  equations. Fine for a few constraint types; you'll outgrow it fast.

---

## 1. Recommended tech stack

- **Language:** TypeScript end-to-end.
- **Build/dev:** Vite.
- **UI:** React. (Keep the viewport in plain three.js or use react-three-fiber —
  either is fine; plain three.js gives you more direct control of picking.)
- **Viewport:** three.js (OrbitControls or custom arcball; raycaster for picking).
- **Kernel:** `opencascade.js` via `replicad`.
- **Constraints:** `planegcs`.
- **State:** plain React `useState` + a small custom `useHistory` hook for the
  document/undo-redo (no Zustand so far — the document is a single immutable
  value, which keeps state trivial; revisit if app state grows).
- **Persistence:** **IndexedDB directly** via a tiny `src/storage/db.ts` wrapper
  (local-first; documents saved in-browser). No Dexie — the store is one object
  store of plain JSON `Document` records, simple enough to not need a library.
- **Concurrency:** Run **OCCT and the solver in a Web Worker.** The WASM kernel
  is heavy and regeneration can take 100s of ms — never block the UI thread.
  The main thread holds the document model + UI; the worker holds the kernel and
  returns tessellated buffers (transfer ArrayBuffers, don't copy).
- **Packaging:** ships as a static web app; optionally wrap in Tauri/Electron
  later for a desktop build and native file dialogs. Not needed for v1.

---

## 2. Core architecture — the parametric model

This is the heart of a parametric CAD and what makes it feel like a real modeler.

### Document = an ordered timeline of features
A document is an **ordered list of features** (the timeline / feature tree).
Each feature is conceptually a **pure function**:

```
feature(inputParams, references, variableScope) -> Shape(s)
```

**Regeneration** = replay the list top to bottom, threading the resulting bodies
forward. Editing feature *N*'s parameters re-runs *N* and everything after it.
A **rollback bar** regenerates only up to feature *k*.

### Variables / expressions
A document-level **symbol table** of named variables with expressions
(`width = 40`, `slot = width / 2 - 3mm`). Evaluated (topologically, to catch
cycles) before features run. Any numeric feature parameter or sketch dimension
can be an expression referencing variables. Keep a small, safe expression
evaluator with units support.

### The hard part: topological naming (call this out early)
When a downstream feature says "fillet edge X," and you edit an upstream feature,
the edges get re-created — does "edge X" still mean the same edge? This is the
**topological naming problem**, the genuine hard problem of parametric CAD
(FreeCAD fought it for years).

Pragmatic approach for this project:
- Use OCCT's **history tracking** — boolean ops (`BRepAlgoAPI`), fillets, prisms
  expose `Modified()/Generated()/IsDeleted()` mappings between input and output
  topology. Thread these through regeneration to remap references.
- Where history is unavailable, fall back to **geometric matching** (match a
  stored reference to the nearest face/edge by normal/centroid/type).
- Store references as **stable feature-scoped IDs**, never raw OCCT indices.
- Accept that v1 will sometimes "lose" a reference on big edits; surface it as a
  fixable error in the tree rather than silently corrupting the model.

> **Status (2026-07-06):** all three layers are in. History propagation since
> Phase 3; the **geometric fallback + surfacing** landed as the N3 robustness
> pass — see "Topological naming" under Phase 3 for the details
> (`src/kernel/topoMatch.ts`, fingerprints on refs, `RegenOutcome.warnings`,
> amber ⚠ timeline badges, descriptive lost-reference errors).

### Selection round-trip
Picking in the viewport must map back to kernel topology:
1. When tessellating an OCCT shape, **tag each triangle group with the face ID**
   and each rendered edge polyline with the edge ID.
2. three.js raycaster hit → look up the tagged ID → that's the topological
   reference stored in the feature that consumes the selection.

---

## 3. Data model (sketch)

```ts
Document {
  id, name
  variables: Variable[]            // name + expression
  features: Feature[]              // the ordered timeline
  rollbackIndex: number
}

Feature =
  | Sketch        { plane | faceRef, entities[], constraints[], dimensions[] }
  | Extrude       { sketchRef, profileRefs[], distance, op: NEW|ADD|CUT, symmetric, draft? }
  | Revolve       { sketchRef, axisRef, angle, op }
  | Sweep         { profileRef, pathRef, op }
  | Loft          { profileRefs[], guideRefs?, op }
  | Fillet        { edgeRefs[], radius }
  | Chamfer       { edgeRefs[], distance, angle? }
  | Boolean       { targetRef, toolRefs[], op: UNION|SUBTRACT|INTERSECT }
  | Pattern       { type: LINEAR|CIRCULAR, seedRefs[], count, spacing/angle, axisRef }
  | Mirror        { seedRefs[], planeRef }

SketchEntity = Line | Circle | Arc | Rectangle | Polygon | Point | Spline
Constraint   = Coincident | Horizontal | Vertical | Parallel | Perpendicular |
               Tangent | Equal | Concentric | Symmetric | Distance | Angle | Radius
```

Each feature stores **references** (to sketches, faces, edges, axes, planes), its
**parameters** (numbers or expressions), and a **boolean op** where relevant.

---

## 4. Phased roadmap

Ordered so each phase produces something runnable and demoable. Estimates are
rough relative sizing, not calendar promises.

> **Progress (2026-06-18):** Phases 0–4 are essentially complete on `main`.
> Phase 2 (sketching + planegcs constraints + interactive length dimension +
> full selection/measurement). Phase 3 (the **running-result model**: extrude
> New/Add/Remove with an explicit target body, chamfer + fillet) plus **proper
> topological naming** via OCCT construction history. Phase 4 (**STEP/STL
> export** in mm). **Boolean** union/subtract/intersect between bodies is done
> and ported onto the running-fold + naming model. Plus colour/Parts panel,
> per-part opacity + hide toggle, a viewport modeling toolbar, delete-key, and
> project renamed **Open Poly**. **IndexedDB autosave + restore is now in** (a
> refresh keeps your work). **Reference planes (offset method) are in** — the
> ⧉ Plane button creates a parametric offset plane you can sketch on. **Transform
> (move + rotate bodies, Phase 5.5) is in** — a ✥ Transform gizmo + panel that
> rigidly moves a body in place (keeps its id + names). **Transform copy** and
> **STEP import** (⤓ Import STEP → a first-class named body) are also in. Likely
> next high-value items remain below.
>
> **Progress (2026-06-21):** a large feature + UX batch landed on `main` —
> **Revolve** and **Mirror** (Phase 5/6); **multi-profile extrude** + **symmetric**
> and **through-all** extents + a **live cyan tool-only ghost preview**;
> **construction geometry**, a **constraints list + delete + over-constraint ⚠**,
> and **double-click-to-edit** in the timeline (Phase 2); **isolate** + **selection
> filters** (Phase 7); plus a sidebar polish pass (collapsible Variables, datums
> folded into the timeline).
>
> **Progress (2026-06-22):** **Sweep + Loft + a Spline sketch tool** shipped
> (Phase 6 now complete) — sweep a region along a line/arc/spline path
> (`BRepOffsetAPI_MakePipeShell`), loft through 2+ regions
> (`BRepOffsetAPI_ThruSections`), both with **OCCT history-based face naming**
> (side faces per profile/section edge + start/end caps), and a `∿` spline tool
> for freeform sweep paths.
>
> **Progress (2026-06-22, later):** the bulk of the **Phase 8.5 UI/UX batch**
> landed on `main` — extrude **extent dropdown** + **up-to-face** extent,
> **click-to-populate Boolean** dialog, **keyboard shortcuts** (mode-gated, full
> coverage; construction = `Q`), tighter Variables heading — plus **extrude by
> selecting a region's enclosing edges**, **reference-plane hover highlight**, a
> **Boolean union fix for touching / shared-face bodies** (solid-count
> validation), and a **Front-plane (left-handed) mirror fix** for
> sweep/extrude/revolve/loft. Remaining high-value items: Phase 8.5 **#1**
> (movable Constraints/Parameters panel) and **#5** (timeline formatting); more
> plane methods; a **multi-document manager**. **LLM agent integration (Phase 9 —
> fully specced below)** is underway on `feat/phase9-agent` (L0–L3 done).
>
> **Progress (2026-06-24):** another **sketch-constraint batch** landed on `main`
> — **tangent**, **coincident** (+ point-on-line + origin-anchoring), and auto
> **point-on-line / midpoint** on snapped endpoints; the **origin is fixed
> ground**; **arcs are now solver-aware** and **equal** extends to arcs; plus
> **variable-name validation** + **dimension var-name autocomplete**, a **dashed
> construction-line highlight** (`Q` syncs the toolbar toggle), and two fixes
> (length-dimension side-flicker on symmetric sketches; loops that close at the
> origin now enclose).
>
> **Drag-to-move unconstrained sketch geometry — ✅ SHIPPED to `main`
> (2026-07-02; branch `claude/sketch-unconstrained-dragging` merged + deleted).**
> With the Select tool you can drag a vertex, an entity body, or an enclosed
> region across the plane; each frame re-solves from a pre-drag snapshot so
> constraints stay satisfied while free DOF follow the cursor (one undo step per
> drag). The grabbed vertex is **pinned to the cursor** for the solve (via
> `solveSketch`'s new `lockedPoints`) so free neighbours follow it — fixing the
> reported axis-lock where e.g. a vertical line's free end could only drag
> vertically; pinning falls back to an unpinned solve if it over-constrains.
> **Grabbable vertices now show small dots** (line-coloured, blue↔green with the
> constrained state) and the hover/selection marker is translucent so the dot
> shows through and tracks a live drag. Line styling is a **blue
> (under-constrained) → green (fully constrained)** shift.
>
> **Progress (2026-07-06):** four batches merged to `main`. **Topological-naming
> robustness** (N3): geometric fallback matching (`kernel/topoMatch.ts`) when a
> persistent name churns, surfaced as timeline warnings + `OpResult.warnings`
> for the agent (see Phase 3's naming write-up). **Regen-performance caching**
> (`perf/regen-caching`): content-hash-keyed `builderCache`/`meshCache` so an
> unchanged body skips re-solve/re-mesh, plus debounced regen, progressive
> body streaming, and a tuned boolean fuzzy tolerance (~45% faster). **The
> multi-document manager** (Phase 8.7, M1–M4): Documents dialog, editable
> title, thumbnails, `.json` import/export, corrupt-record recovery, and
> agent `list/open/new/rename/duplicate_document` tools. **Associative
> face-sketches** dropped from the backlog entirely (tested against
> Onshape — it doesn't follow the host body either; parity, not a gap).

### Phase 0 — Foundation spike *(prove the stack)* — ✅ DONE
- Vite + TS + React shell: top bar, left feature-tree panel, central viewport,
  bottom-right context panel.
- `opencascade.js`/`replicad` running **in a Web Worker**.
- Render a hard-coded box: tessellate in worker → transfer buffers → three.js.
- Camera (orbit/pan/zoom), grid, origin triad. *(Selectable base planes moved to
  Phase 2.0 prep.)*
- **Exit criteria:** edit a number in the UI, see the box regenerate. ✅

### Phase 1 — Timeline + variables engine — ✅ DONE
- Document model, ordered feature list, regeneration pipeline, rollback bar.
- Variable table + expression evaluator. *(Units deferred.)*
- Undo/redo via history with **edit coalescing** (typing in a field = one step).
- Feature-tree UI: reorder, rename, suppress, edit, delete, error badges.
- Stand-in features: box/cylinder/sphere **primitives** (independent bodies) until
  sketch-based features arrive.

### Phase 1.5 — Running-result regeneration model — ✅ DONE (folded into Phase 3)
The kernel now **folds operations over a running set of bodies** (`worker.ts`
`buildBodies`): a sketch/face profile becomes a solid, extrude New adds a body,
extrude Add/Remove fuse/cut in place, boolean combines operands, chamfer/fillet
modify a body. A body is keyed by the id of the feature that **created** it
(primitive / New extrude / boolean); **in-place modifiers preserve the target's
id**, so the body keeps its identity (name, colour) through chamfer/Add/Remove.
- **Body identity:** kept pragmatically as "body id = creating-feature id"
  rather than a separate body-record with its own ids — a full decoupling would
  actually worsen Parts naming (a union should read "Union 1", not "Box 1"), so
  it's intentionally not done. The one visible gap (selecting an in-place
  modifier didn't highlight its body) is fixed by resolving modifier→affected
  body for the **viewport highlight** only (`highlightBodyIds`); tree/params keep
  showing the modifier feature.

### Phase 2 — Sketching (geometry + constraints) — ✅ core DONE
Pick a datum plane or planar face → sketch mode (camera normal-to); draw a
profile, constrain it, and it becomes a region that extrude/revolve/sweep/loft
consume. Exit criterion — a fully-constrained closed profile that updates when a
driving variable changes — is **met**.

**Done — navigation & entry**
- Clickable/snappable **origin point**; the three datum **planes** (Top/Front/
  Right) rendered faintly, hover/click-selectable (selecting one starts a sketch);
  **standard view navigation** (digits `1`–`7`). (A true interactive ViewCube is a
  later nicety.)
- Pick a plane/planar face → sketch (camera normal-to); **snapping** (endpoints /
  midpoints / origin / coplanar edges); delete; **double-click** a timeline row to
  edit its feature.

**Done — drawing tools**
- **line, rectangle** (2-corner + center), **circle** (center + 3-pt), **arc**
  (3-pt), regular **polygon**, **spline** (smooth through-point curve; the `∿`
  tool, **Esc** to finish).
- **Construction toggle** — mark any entity as reference geometry (used for
  dimensions/constraints/snapping, ignored by region detection, never extruded;
  dashed amber). Toolbar toggle while drawing **and** per-selection convert.
- **Spline** doubles as a **sweep path** and a **closed-region boundary**
  (`detectSketchRegions` treats arcs + splines as graph edges). Sweep & loft
  rebuild the profile from **exact curve segments** (`regionProfileSegments`);
  extrude/revolve still build the face from the tessellated (faceted) polyline —
  a later enhancement (see backlog).
- **Offset** (`O`), **Mirror** (`M`), **Project/Convert** ("Use", `U`), and
  **Text** (`T`) — the 2026-06-29 tool expansion. Offset/Mirror/Project are
  **parametric/associative**: stored as `DerivedOp`s (`document/derived.ts`),
  their generated outputs are tagged `derivedFrom`, excluded from the solver,
  non-constrainable, drawn purple as "driven", and **recompute when their sources
  change**. Project is live-associative (persistent edge **names** +
  re-project-after-rebuild, change-detection guarded). **Text** is a `text`
  SketchEntity (opentype glyph outlines, bundled Inter TTF), re-editable in place
  and **extrudable** (`ExtrudeProfile {kind:"sketchText"}`; counters/holes via
  replicad `textBlueprints`).
- Sketch-mode **shortcuts**: Select `S`, Line `L`, Rect `R`/`Shift+R`, Circle
  `C`/`Shift+C`, Polygon `P`, Arc `A`, Spline `Shift+S`, Offset `O`, Mirror `M`,
  Use `U`, Text `T`, Dimension `D`, construction `Q` (full scheme in
  `KEYBOARD_SHORTCUTS.md`).

**Done — constraints & dimensions** (`planegcs`, `src/sketch/solver.ts`)
- **Auto H/V capture** on draw (including a line-rect's closing edge + all four
  rectangle edges); **drawing auto-solves** on every commit (chained lines
  continue from the solved endpoint); **fully-constrained → green**; the manual
  Solve button is gone. The **origin is fixed ground** in the solver.
- **Conflict/redundant rejection:** a dimension or constraint the solver can't
  satisfy — a conflict, a failed/invalid solve, a degenerate ~0-length line, or an
  already-implied one — is **rejected** (never saved as a dead constraint) with a
  named banner.
- **Dimensions:** length, **radius**, **angle** (the true interior angle, not the
  supplement). Each renders as a **drafting annotation** (`ui/DimensionOverlay.tsx`
  — witness lines + arrows; radius leader; angle arc; right-angle corner box),
  positioned imperatively each frame (no React re-render). Values accept a number
  / expression / variable; **double-click** to edit, **click + Delete** to remove.
- **Geometric constraints** (toolbar buttons, enabled on the matching selection):
  horizontal / vertical (manual, on a single selected line — `H`/`V`), parallel,
  perpendicular, equal (length/radius, any line/circle/arc mix), tangent
  (line/circle/arc), coincident (also point-on-line + origin-anchoring), midpoint.
  Point-on-line / midpoint are **auto-attached** when a drawn endpoint snaps onto
  an edge or its midpoint; H/V are also applied implicitly by the rectangle and
  axis-aligned line drawing.
- **Arcs and circles are solver-mapped** (centre + endpoints + radius + angles),
  so they constrain and move as real curves. A **Constraints list** (sidebar while
  sketching) shows each with a per-row ✕ delete; over-constraint shows a red ⚠
  conflict badge.

**Backlog (deferred)**
- **Trim / extend.**
- **Cancel a sketch edit (discard changes)** — re-editing applies live via
  `setDoc`, and only a brand-new *empty* sketch cancels on exit; backing out of
  edits to an *existing* sketch needs snapshot-on-entry + restore on Esc (Finish
  keeps changes).
- **Dimensions:** point-to-point / point-to-line distance, the **diameter**
  variant, and **live expression-linked** values (a value is stored as a resolved
  number, not a link that re-evaluates when its variable changes).
- **Geometric constraints not yet mapped:** concentric, symmetric, collinear, and
  a general fix/lock of an arbitrary entity.
- **Splines** still pass through the solver **unconstrained** (only line / arc /
  circle are mapped).
- **Point identity is by coordinate key** (`solver.ts`): coincident endpoints
  merge by rounded position, robust only until a solve moves them — a real
  point-based sketch model is wanted before heavy constraint editing (it blocks
  p2p distance + robust coincident editing).
- **Project tool gaps:** **vertex** projection is **best-effort** — vertices have
  no stable cross-rebuild identity, so a projected vertex re-projects its stored
  world point (tracks the sketch plane, **not** changes to the source body),
  unlike projected **edges** which are fully associative; and there is **no
  agent/MCP op for Project yet** (UI-only — see Phase 9).
- Extrude/revolve build faces from the **faceted** polyline for curved profiles
  (sweep/loft already use exact curves).
- **Discoverability:** the Constraints + Parameters panels sit below Parts —
  relocating them into a movable panel is **UI/UX backlog #1** (Phase 8.5).

### Phase 3 — First solids: Extrude + Chamfer/Fillet — ✅ DONE
This phase built the **running-result model** (Phase 1.5): the kernel folds
operations over a running set of bodies, and **proper topological naming** went
in — face names seeded on primitives and propagated through extrude (MakePrism)
and booleans (fuse/cut/common) via OCCT construction history; edge names derived
from adjacent faces — so face/edge references survive rebuilds and parametric
edits. Built with raw `oc.*` (BRepPrimAPI_MakePrism, BRepAlgoAPI, BRepFilletAPI)
behind the `Kernel` facade. Item-by-item status is inline below.

- **Extrude (headline)** — ✅ DONE (with the noted gaps):
  - **Profiles:** ✅ sketch regions (`sketchFace`) and planar body faces.
    **Multi-profile — ✅ DONE:** select several regions/faces → one dialog
    extrudes them all in a single undo step (`extrudeProfiles[]` in `App.tsx`).
    **Enclosed-edges — ✅ DONE:** selecting a region's **bounding edges** (instead
    of the face) also extrudes it — `regionsEnclosedBy` maps a set of selected
    sketch edges to the region they enclose (handy when the face is tiny). A
    circle counts via its single edge.
  - **Result mode** (in the dialog): ✅ **New** / **Add** (join) / **Remove**
    (cut). Add/Remove require choosing an explicit **target body** in the dialog.
    Defaults to **Add** onto a solid when the sketch sits on that solid's face
    (drawn on it, or coplanar + overlapping a face), else **New** — overridable.
  - **Direction:** ✅ flip toggle. **Symmetric/two-sided — ✅ DONE**
    (`ExtrudeExtent="symmetric"` → two opposite prisms fused; flip hidden).
  - **End condition / extent** (a **dropdown**): ✅ **Blind** (expression-backed
    distance), ✅ **Symmetric**, ✅ **Through-all** (**remove/cut only** —
    bbox-sized tool clipped by the boolean; the option is hidden for new/add),
    ✅ **Up-to-face** (stop at a chosen planar face — backlog #3),
    ✅ **Up-to-next** (any mode, like up-to-face; stops at the nearest face of the
    model ahead in the flip-adjusted direction that the profile runs into —
    plane-crossing distance + perpendicular bbox overlap over every body's planar
    faces; directional so Flip genuinely reverses it, distance ignored; errors if
    nothing lies ahead that way, OR — like every CAD — if the next face only
    PARTIALLY covers the profile rather than fully blocking it). **Both up-to-face and
    up-to-next CONFORM to the target face** (a long prism cut flush with the
    face's plane via an oriented half-space box), so a target that isn't
    perpendicular to the extrude axis yields an angled/matching top rather than a
    flat approximation.
  - **Dialog:** ✅ anchored mini-dialog (mode + target + extent + distance +
    flip). **Live ghost preview — ✅ DONE:** the dialog regenerates a throwaway
    doc and renders the **swept tool only** (the changing portion) as a
    translucent cyan ghost (`previewTool` in the kernel) while existing bodies
    keep their own colour; one ghost per profile, updates live with the params.
- **Chamfer + Fillet** — ✅ DONE: edge dress-up via `BRepFilletAPI`, edges
  referenced by **persistent name**. *(Chamfer two-distance/angle variants:
  TODO; currently single distance / single radius.)*
- **Topological naming** — ✅ DONE (the real version, via OCCT history; see the
  phase intro above). **Robustness layer (N3, 2026-07-06) — ✅ DONE:** when a
  name is gone (an upstream edit split/merged topology, churning `#n` suffixes),
  references now **fall back to a scored geometric match** against a fingerprint
  baked at pick time — faces: centroid + normal (`UpToFaceRef`/`bodyFace`/
  `RevolveAxisFace` gained `normal?`); edges: persistent name → suffix-stripped
  base name → bbox-centre + length (`DressUpFeature.edgeRefs`). Matching is pure
  math in `src/kernel/topoMatch.ts` (Node-tested; scale-relative rejection
  thresholds so a lost reference errors descriptively instead of silently
  grabbing the wrong face/edge). Every re-match or partial loss is **surfaced as
  a per-feature warning** (kernel → `RegenOutcome.warnings` → amber ⚠ badge in
  the timeline); a dress-up with some edges lost proceeds on the survivors and
  says so. **Primitives now name ALL faces** (axis name else `f{n}`), so
  cylinder/sphere rims are chamfer/fillet-able (previously the unnamed side face
  made their edges unreferenceable); prism leftovers get the same `f{n}`
  fallback. E2E-verified by `scripts/verify-naming.mjs` (cylinder rim fillet;
  churned `#1` edge name re-matched + ⚠; bogus name → descriptive error) and
  `scripts/verify-naming-face.mjs` (boolean-split `+z#1` profile face un-split
  by an upstream edit → pad re-attaches geometrically + ⚠).
  *Residual follow-ups (agent path, Phase 9):* (a) ✅ DONE — `commands.ts`'s
  `dressUp` case now bakes `edgeRefs` fingerprints (mid+length) from the mesh
  `edgeGroups` (`edgeFingerprintByName`, mirroring `App.tsx`'s
  `edgeFingerprint`; unknown names stay name-only), so agent-created dress-ups
  get the geometric rescue pass too; (b) ✅ DONE — `RegenOutcome.warnings`
  now threads through `RegenSettle` (App's regen effect + `agentWarningsRef`)
  into every apply's `OpResult.warnings`, so the MCP tool result itself tells
  the LLM a reference was re-matched (modeling guide's work-loop section says
  to verify, not ignore).
- **Selection round-trip** (sketch region / body face / body edge → kernel →
  meshed body back) — ✅ exercised end to end.

### Phase 4 — Export (validate end-to-end) — ✅ DONE
- **Export STL** (mesh) and **STEP** (B-rep, declared in mm) per part, from the
  Parts panel. `Kernel.exportBody` replays the fold and serialises the chosen
  result body. Image snapshot still TODO.
- **Import STEP — ✅ DONE.** An **⤓ Import STEP** button by the Parts heading
  loads a `.step`/`.stp` file as a body.
  - **Feature:** `ImportFeature` (a body *producer*, like a primitive) stores the
    STEP **text** on the feature — JSON-serializable, so it round-trips through
    IndexedDB / `.json`. UI: `<input type=file>` → `file.text()` → `addImport`.
  - **Kernel:** `importStepNamed` reads it via OCCT `STEPControl_Reader` (sync —
    writes the text straight to the in-memory FS), `cast(OneShape())` → a body
    keyed by the feature id (random colour like other new bodies). Folds in via
    `buildBodies`. (Multi-solid STEP comes in as one body/compound for now;
    one-body-per-solid is a future refinement.)
  - **Topological names seeded on import:** axis-aligned planar faces get an axis
    name (`id/+z`) via `axisFaceName`, the rest a stable unique index name
    (`id/fN`) — so downstream extrude-on-face / chamfer / the agent can reference
    imported geometry.
  - It's then a **first-class body**: colour / opacity / hide, transform, boolean,
    dress-up, and re-export (Parts panel) all work; named in the Parts list /
    timeline / param editor.
  - **Caching the parsed shape — ✅ DONE** (a side effect of the general
    incremental-regen work: `import` goes through the same content-hash-keyed
    `buildCached`/`builderKey` as every other builder, so an unchanged STEP
    source isn't re-parsed every regen). **Still TODO:** drag-and-drop a file
    onto the viewport; one-body-per-solid (multi-solid STEP still comes in as
    one compound).

### Phase 5 — Boolean + Reference planes + Pattern + Mirror *(Boolean + offset planes ✅; rest TODO)*
- Boolean between separate bodies: union / subtract / intersect — **done**
  (`BooleanFeature`, name propagation). The dialog is **click-to-populate** —
  operands fill in as bodies are clicked in the viewport (click to add in order,
  click again or ✕ to remove). Union accepts bodies that merely **touch / share
  a face** (validated by **solid count**, since touching bodies share no volume
  and so look identical to disjoint by volume); subtract/intersect still use a
  volume verdict.
- **Reference / construction planes (create plane).** A parametric `PlaneFeature`
  placed via the **⧉ Plane** toolbar button (right of New Body) → a pick flow
  (select a plane/face to base it on) → a dialog. Methods:
  - **Offset** — parallel to a base datum / face / earlier plane, by a (signed,
    expression-backed) distance. **✅ DONE.** `resolvePlanes()` derives the
    frame (`frameOf(base)` translated along its normal, in timeline order so a
    plane can sit on an earlier plane); `SketchPlaneRef` gained a
    `{kind:"plane"}` variant; planes render as translucent amber quads and are
    **selectable for sketching** (offset is editable → re-derives on change).
  - **Midplane — ✅ DONE.** Halfway between two references (datum / face /
    reference plane). Origin at the midpoint of the two frame origins, normal the
    aligned average (the second normal is flipped if it faces away, so two faces
    pointing at each other still give a sensible between-plane). `midplaneFrame`.
  - **At an angle — ✅ DONE.** The base hinged on its own u- or v-axis (through
    the base origin) by an angle in degrees (expression-backed, re-derives on
    change). `angledFrame` (Rodrigues rotation). *(Hinging on an arbitrary picked
    edge/axis rather than the base's own axis is a future refinement.)*
  - **Through geometry — ✅ DONE (3 points).** Plane through three picked points
    (body vertices or sketch points); origin = first point, normal =
    (p1-p0)×(p2-p0), collinear points rejected. `planeThrough3Points`. *(Other
    inputs — line+point, two parallel edges — are future.)*
  - The **⧉ Plane dialog is now method-first**: a Method dropdown (Offset /
    Midplane / At angle / Through 3 points) with per-method pick buttons (base /
    second reference / 3 points) + inputs; `ParamEditor` shows the right fields per
    method. `PlaneFeature` gained `method` + `refB`/`angleAxis`/`angle`/`points`
    (legacy planes with no `method` resolve as offset).
  (Showing planes in a separate datums list is **not planned** — appearing in the
  timeline + viewport is enough.)
- Linear pattern (1- and 2-direction), circular pattern (axis + count + angle).
  **✅ DONE — at BOTH levels** (see PATTERNS_PLAN.md for the full design):
  - **Sketch patterns** — `linearPattern` / `circularPattern` `DerivedOp`s
    (associative, expression-backed, counts include the seed, clamped at
    `MAX_PATTERN_INSTANCES`). Tools live in a sketch-toolbar flyout (`X` /
    `Shift+X`): sources seed from the selection or accumulate by click,
    circular arms its center on the first click (entity points/origin →
    `PointRef`; empty space → a construction point), live dashed previews,
    floating count/step/angle box. The idiomatic way to repeat cuts — pattern
    the profile, one extrude-remove.
  - **Body pattern** — `PatternFeature` (`⁙ Pattern`, `X`): linear run/grid
    (world-axis or sketch-line directions × spacing, optional second
    direction) or circular ring (axis = world axis / sketch line /
    cylindrical face; revolve-style Full(360°)/Angle + Symmetric). The copies
    are rigid `applyTrsf` clones with per-instance `~p{i}` name suffixes,
    compounded into ONE body keyed by the feature (seed kept, like Mirror).
    Live ghost preview clones the seed's tessellated mesh — no kernel round
    trip. Agent parity: `add_sketch_pattern` + `add_pattern` MCP tools.
  - *Still open:* per-instance skip, fuse-with-seed option, multi-seed, and
    body-edge direction references.
- **Mirror across a plane/planar face — ✅ DONE.** A `MirrorFeature` reflects a
  body across a datum / reference plane into a **new** body (original kept) via
  `gp_Trsf.SetMirror` (reuses `applyTrsf`; names re-key 1:1). `⇋ Mirror` button
  + plane-pick dialog. **Mirror about a planar body face ✅ DONE:** the dialog's
  plane dropdown has a **"Body face…"** option that arms a face pick (`Select a
  face` button, like up-to-face); the picked face's plane is derived via
  `deriveFaceFrame` (centroid + `faceNormal`) and stored as a `kind:"face"` ref
  (a frozen frame snapshot — won't follow the source body if it later changes).
  **Non-planar faces are rejected** (`faceNormal` returns null when the face
  verts aren't coplanar within 0.05mm, so a cylinder side can't be picked).
- Patterns/booleans multiply topology — re-stress naming/selection here.

### Phase 5.5 — Transform (move + rotate bodies) — ✅ DONE
- A **Transform** feature that translates (X/Y/Z, expression-backed) and rotates
  (angle about a world X/Y/Z axis through a pivot baked from the body's bbox
  centre) a selected body. It's an **in-place modifier** — keeps the target
  body's id (and topological names), like chamfer/fillet — so it lives in the
  **Timeline** (not Parts) and downstream features still reference it.
- UI: a **✥ Transform** toolbar button (enabled when one body is selected); a
  **TransformControls gizmo** driven by an invisible proxy (1 mm / 5° snap;
  orbit suspended while dragging), plus a floating Move/Rotate panel + numeric
  fields in the parameter editor. Gizmo drags write back as expressions (one
  undo step per drag); Cancel/Esc drops the feature.
- Kernel: `transformNamed` applies `gp_Trsf` (rotate-about-pivot then translate)
  via `BRepBuilderAPI_Transform_2` + `ModifiedShape`, re-keying the topological
  name map by each face's image so the body's names survive the move.
- **Copy ✅ DONE:** a "Keep original" checkbox makes the transform emit the
  moved/rotated body as a NEW part (own colour) instead of moving in place.
- **Live drag preview ✅ DONE (perf):** dragging the gizmo used to re-run the full
  running-fold regen over every body each frame, so in a many-solid doc it stalled
  the kernel for the whole drag. A rigid motion preserves topology 1:1, so the drag
  now re-poses **only the moved body's** three.js objects with a matrix
  (`current · committed⁻¹`, matching the kernel's rotate-about-pivot-then-translate)
  and never touches the kernel; the drag commits **once, on release** (the only
  regenerate). The commit's delta is pinned across the stale rebuilds the doc change
  triggers and released the instant the body's mesh ref changes (real re-baked
  geometry), so there's no flash back to the origin. The panel's numeric readout
  stays live via a display-only state that never feeds the kernel. Verified on a
  40-body doc: 0 regens during the drag, 1 on release; no flash-back.
- **TODO:** scale; rotation about a datum axis / body edge / arbitrary
  point+direction (today: world axis through the bbox-centre pivot); a pivot
  that re-derives if the body changes upstream (today it's baked at creation).
- **Perf follow-up — ✅ DONE** (`perf/regen-caching`, merged): the worker now
  caches unchanged bodies' OCCT shapes (`builderCache`, keyed by a content
  hash of the resolved feature + its inputs) and their tessellations
  (`meshCache`), swept each regen to what was actually used — so a commit
  that only touches one body no longer re-solves/re-meshes the rest of the
  timeline. Also landed in the same pass: regen debouncing (coalesces edit
  bursts, `REGEN_DEBOUNCE_MS`), progressive/streamed body painting
  (`regenerate-progress`), and a tuned boolean fuzzy tolerance (~45% faster
  booleans). Tessellation **LOD is still not built** (no distance/zoom-based
  mesh simplification) — the caching above addresses the "unnecessary
  rework" cost, not "how much geometry to draw."

### Phase 6 — Sweep + Loft + Revolve — ✅ DONE
- **Sweep — ✅ DONE.** A `SweepFeature` sweeps a **sketch region** along a **path
  entity** (line / arc / **spline**, possibly in a different sketch) — `⊃ Sweep`
  enables when a region + a path entity are selected. Kernel `sweepBody` uses raw
  OCCT `BRepOffsetAPI_MakePipeShell` (profile placed perpendicular to the spine
  start). The **profile is rebuilt from exact curve segments** (so a circular/arc
  cross-section sweeps as a smooth tube, not a 48-facet polygon) and a **spline
  path's spine is rebuilt from the exact cubic-Bézier spans the sketch draws**
  (`splineBeziers`; an arc path fits one interpolating B-spline) — so the solid
  follows the drawn curve exactly. **History-based naming** (one side face per
  profile edge via `Generated`, + `start`/`end` caps).
  *(Twist / multiple profiles along the path: future.)*
- **Loft — ✅ DONE.** A `LoftFeature` lofts through **2+ sketch regions** (ordered
  by timeline position) — `⌧ Loft` enables when ≥2 regions are selected. Kernel
  `loftBody` uses raw OCCT `BRepOffsetAPI_ThruSections` (solid) with
  **history-based naming** (lateral faces via `GeneratedFace` per section edge, +
  caps). *(Ruled option / guide rails / point-capped ends: future.)*
- **Spline sketch tool — ✅ DONE** (was UI/UX backlog #8). A `spline`
  `SketchEntity` (smooth Catmull-Rom through control points): the `∿` sketch tool
  (click points, **Esc** to finish), rendered/snapped/measured; an open curve
  used mainly as a **sweep path**. The on-screen curve and the swept spine share
  one definition — `splineBeziers` (the Catmull-Rom curve as exact cubic-Bézier
  spans) — so the solid's centerline matches the drawn path exactly.
- **Revolve — ✅ DONE** (dialog overhauled 2026-06-29). A `RevolveFeature`
  revolves a **sketch region** around an **axis** by an expression-backed
  **angle**. The `⟳ Revolve` button is **always enabled** and opens an **arming
  dialog** (Boolean-style): arm a **profile** region, then arm an **axis** from a
  single "Select axis" target that accepts a **sketch line**, a **datum/reference
  plane** (→ its intersection line with the profile plane, `planeIntersectionLine`),
  or a **body face** (planar → intersection line; cylindrical/conical → that
  surface's central axis, read in the worker). The dialog offers **Full (360°)**
  vs a specified **angle** + a **Symmetric** option (straddles the profile plane,
  ±angle/2, via a −angle/2 pre-rotation of the face), and shows a **translucent
  ghost** of the result (reusing the extrude ghost pipeline, debounced). On
  success the **originating sketch is hidden**, like extrude. `RevolveAxis` is a
  union (`{sketchId,entityId}` | `{plane}` | `{face}`); edge/plane axes resolve in
  the document layer, face axes in the worker. Kernel `revolveFromFace` uses
  `BRepPrimAPI_MakeRevol` with history-based naming (swept side faces per profile
  edge + start/end caps for a partial revolve).

### Phase 7 — Multi-body, parts, selection UX — ✅ DONE
- Multiple bodies/parts in one document — ✅. A **Parts** panel
  (`ui/SolidsList.tsx`) lists every rendered body (primitive / extrude / boolean)
  with select, rename, delete, colour, opacity slider, a **per-part show/hide
  eye toggle** (`hidden` flag → body dropped from the rendered meshes), and
  STEP/STL export. Colour/opacity/hidden are overlaid onto cached geometry in
  `App.tsx` (instant, no regen). **Delete/Backspace** removes a body or sketch
  (or a single sketch line). Suppress (timeline) uses a distinct no-entry icon
  for non-sketch features, separate from hide.
- Robust selection (faces, edges, bodies; hover highlight) — ✅. During a
  plane/face pick, **user-created reference planes also highlight on hover** (like
  the base datums), not just show a pointer cursor.
- **Isolate — ✅ DONE.** A ◎ button per Parts row renders only that body
  (others hidden, Exit banner, auto-exits if the body disappears).
- **Selection filters — ✅ DONE.** **Body / Face / Edge / Vertex** chips
  (bottom-left of the viewport, under a "Selection filters" heading) gate what a
  click can pick (`SelectionFilter` in `Viewport.pickSelection`).
  *(Opacity slider note: the Parts-row opacity control is currently hidden —
  reinstate via a better home, UI/UX backlog #1.)*

### Phase 8 — Polish & persistence
- **IndexedDB autosave + restore — ✅ DONE.** `src/storage/db.ts` wraps
  IndexedDB (object store keyed by document id, structured-clone of the plain
  `Document`); the app restores the most-recent doc on load and debounced-
  autosaves on change (autosave waits for the initial load). A refresh no longer
  loses work.
- **Multi-document manager — ✅ DONE.** See **"Phase 8.7 — Multi-document
  manager"** below: documents dialog, editable title, thumbnails, `.json`
  import/export, corrupt-record recovery, and the agent's
  `list/open/new/rename/duplicate_document` tools.
- Measurement tools, section view — still TODO. *(Appearance — ✅ DONE, Phase 7:
  color/opacity/hide per part. Keyboard shortcuts — ✅ DONE, see
  `KEYBOARD_SHORTCUTS.md`.)*
- **Performance — incremental regen ✅ DONE** (worker-side `builderCache`/
  `meshCache`, content-hash-keyed — see Phase 5.5's perf follow-up above).
  **Tessellation LOD — still TODO** (no distance/zoom-based mesh
  simplification).
- **CI — ✅ DONE.** `.github/workflows/ci.yml` runs `npm run typecheck` (`tsc -b`,
  the real gate — the root tsconfig has `files:[]` so a bare `tsc --noEmit` is a
  no-op) + `npm test` on every push to `main` and PR.
- **Landing page + GitHub Pages deploy — auto-deploy DISABLED (TODO: re-enable).**
  The hero renders + `logo.svg` live in `landing/`, and
  `.github/workflows/pages.yml` can publish them — but this repo is **private on
  the Free plan**, where GitHub Pages can't publish, so every run failed red. The
  workflow's `push` trigger is **commented out** (`workflow_dispatch` kept for
  manual runs). **TODO:** re-enable by uncommenting the `push` trigger once the
  repo is **public** OR on a **paid plan** (Pro/Team/Enterprise), then set
  Settings → Pages → Build and deployment → Source → "GitHub Actions".

> First deliverable ("v0.1, genuinely usable") — **✅ reached.** Phases 0–4 plus
> Boolean: sketch a constrained profile, extrude/cut it, chamfer/fillet an edge,
> boolean bodies, recolor/hide parts, **export a STEP/STL file**, and it all
> **autosaves** — with variables and a working timeline. Validates every hard
> layer end to end.

### Phase 8.7 — Multi-document manager (spec, 2026-07-06)

Turns the single autosaved sketchpad into a multi-file workspace. Everything
below builds on what exists: `src/storage/db.ts` (IndexedDB store keyed by doc
id, `StoredDoc {id, name, doc, updatedAt, meshes?}`), the App's restore/autosave
effects (`App.tsx` ~1145/1180), `useHistory.reset`, and `ViewportApi.capturePNG`.

**Goals:** several named documents; switch/create/rename/duplicate/delete
without losing work; instant-feeling switches; `.json` portability; agent can
list/open/create documents (Phase 9 L4). **Non-goals (v1):** cloud sync,
folders/tags, collaborative editing, per-document settings profiles.

#### Data model & storage (DB v2)

- **Split metadata from payload.** `listDocs()` today `getAll()`s FULL records —
  with saved meshes riding along, opening the Documents dialog (or booting)
  would deserialize every document's tessellation. DB v2 adds a second object
  store **`meta`**: `DocMeta { id, name, updatedAt, createdAt, featureCount,
  partCount, thumb?: Blob }`. The dialog and boot path read ONLY `meta`
  (cheap); the full `documents` record loads on open.
- `StoredDoc` gains `createdAt` (and keeps `meshes` — see Performance). Writes
  update both stores in **one transaction** so they can't drift; `db.ts` grows
  `listMeta()`, `putDoc(record)` (writes both), `renameDoc(id, name)` (both),
  `duplicateDoc(id)`, and keeps `loadDoc`/`deleteDoc` (delete removes both).
- **Active document pointer** in `localStorage` (`openpoly.activeDocId`) — NOT
  "most recent", so a refresh reopens what you were looking at even if another
  tab touched a different doc more recently. Fallback: most-recent meta, else
  seed a new "Untitled".
- **v1 → v2 upgrade** (in `onupgradeneeded`): create `meta`, backfill by
  cursoring `documents` (derive counts from the doc; no thumbs yet). Existing
  single-doc users see their doc appear in the list unchanged.
- **Title lives on `StoredDoc`/`DocMeta`, NOT inside `Document`.** The
  parametric model stays pure geometry; rename is a storage-level operation
  that does NOT create an undo step and can't be undone away. (Same reasoning
  as feature colors living on features but doc identity living outside.)

#### UX

- **Topbar title.** Replace the static "Phase 3 · modeling" chip with the
  document name — click to edit inline (like Parts renaming); Enter/blur
  commits, Esc reverts; empty reverts to previous. Also mirror to the browser
  tab: `document.title = "<name> — Open Poly"`. A subtle "Saved ✓ / Saving…"
  hint can fold into the existing status chip (autosave already exists; this
  just surfaces it).
- **Documents dialog** (a modal on the existing `DraggableDialog` pattern,
  opened from a **⌘O / "Documents" topbar button** next to the title):
  - Grid or list of cards: **thumbnail**, name, "edited 3h ago", small
    "12 features · 3 parts" line. Active document highlighted, list sorted
    most-recently-edited first.
  - Row actions: **Open**, **Rename** (inline), **Duplicate** ("Copy of X",
    becomes active), **Export .json**, **Delete** (two-step confirm in place;
    deleting the ACTIVE doc opens the next most recent, or seeds a fresh
    "Untitled" if none remain).
  - Header actions: **＋ New document** (empty seed via `createDocument()`,
    named "Untitled 2", "Untitled 3"…; opens immediately), **Import .json**
    (file picker + drag-drop onto the dialog).
  - The dialog is the only browsing surface (no separate home screen) — this
    is a local tool, not a cloud drive; Esc closes and you're back in the
    model.
- **Switch flow** (the critical path): flush the pending autosave (cancel the
  600 ms debounce and `putDoc` NOW, with current meshes) → load the target's
  `StoredDoc` → `migrateDocument` → paint its saved `meshes` instantly →
  `resetDoc` (clears undo history — a document boundary is a history boundary)
  → kernel regen swaps in fresh geometry when it settles → update
  `activeDocId` + tab title. Selection, dialogs, rollback drag state, and the
  agent's pending waiters all reset with the doc.
- **`.json` export/import.** Export: `{ format: "openpoly-doc", version: N,
  name, doc }` (no meshes — they're a cache; files stay small and diffable).
  Import: parse → `migrateDocument` → new id (NEVER reuse the file's id —
  imports must not silently overwrite) → name from file (deduped) → open.
  Corrupt/unknown-version files surface a readable error in the dialog.

#### Performance — what loads when

| Moment | Loads | Cost |
| --- | --- | --- |
| **Boot** | `meta` for the active-id lookup + the ONE active `StoredDoc` (doc + meshes) | one small getAll + one record; meshes paint instantly, OCCT regen runs behind |
| **Documents dialog open** | `meta` only (names, dates, counts, thumb Blobs) | no `Document` JSON, no meshes deserialized |
| **Switch/open** | that one `StoredDoc` | same as boot's second half |
| **Autosave (600 ms debounce)** | writes active `StoredDoc` + its `meta` row | unchanged from today + one small row |

- **Thumbnails**: `capturePNG()` downscaled to ~256 px and stored as a Blob on
  `meta.thumb`. Generated **on regen settle, throttled** (e.g. at most once per
  30 s per doc) and always once on **switch-away** — never per keystroke, and
  never blocks the switch (fire-and-forget after flush). Retina note: downscale
  via an offscreen canvas so the Blob isn't 4× the display size.
- **Kernel caches across switches:** the worker's `builderCache`/`meshCache`
  are content-hash-keyed (doc-agnostic keys!) but swept after every regen to
  "used this run" — so switching docs evicts doc A's entries and switching back
  re-solves its sweeps/lofts/booleans from scratch. **v1 accepts this** (the
  saved-meshes instant paint hides most of it). Follow-up option recorded here:
  sweep to "used in the last K regens" or per-doc used-sets to make A↔B
  round-trips cheap.
- **One doc in memory at a time.** No preloading of inactive docs; the meta
  store is the only always-resident index.
- **Quota:** IndexedDB writes can fail (private mode, disk pressure). Autosave
  already catches + warns; the dialog should surface a persistent banner if the
  LAST save failed, since now "which doc did I lose?" is a real question.

#### Multi-tab safety

Two tabs editing the SAME doc is last-writer-wins clobbering today (and stays
dangerous with multiple docs). v1 guard: a **`BroadcastChannel("openpoly-docs")`**
— each tab announces `{docId, tabId}` on open/switch; a tab holding the same
docId shows a warning banner ("This document is open in another tab — changes
may overwrite each other"). Full locking/merging is out of scope; different
docs in different tabs works naturally and becomes the recommended pattern.

#### Agent integration (Phase 9 L4 — `list/open/new_document`)

- **New operations** (zod, `operations.ts` → `commands.ts` → MCP tools):
  - `listDocuments` (read) → `[{id, name, updatedAt, featureCount, partCount,
    active}]` from `meta`.
  - `openDocument {id}` → runs the same switch flow (flush → load → reset);
    resolves after the first regen settles so the next read sees real geometry.
  - `newDocument {name?}` → seed + open.
  - `renameDocument {id?, name}` (default: active), `duplicateDocument {id?}`.
  - **No `deleteDocument` in v1** — destructive, low value for modeling tasks;
    the guide tells the agent to ask the user. (Revisit with L4 auth.)
- **Context in reads:** `getSceneSummary` and `get_document` gain
  `{documentId, documentName}` so the agent always knows WHICH file it's
  shaping ("continue yesterday's bracket" = `list_documents` → match by name →
  `open_document` → `get_scene_summary`).
- **AgentContext** grows a `documents: {info, open, create, duplicate, rename}`
  API (delegated through App's `agentDocApiRef`, refreshed each render, so it
  always calls the live switch-flow closures — not the planned
  `getActiveDocMeta()`/`switchDocument()` names, but the same guarantee: every
  agent switch runs the real flush→adopt flow, never a raw `setDoc`). ✅ DONE.
- **Guardrails:** `openDocument` while a regen is in flight waits for it
  (regen start-seq already serializes waiters); ops that arrive DURING a switch
  queue behind it (the serial request pipeline in `bridgeClient` already
  guarantees ordering). Modeling-guide gets a "Documents" section: read
  `documentId` before assuming, don't switch mid-recipe, never delete.

#### Edge cases — resolved

- **`docIdRef` seeding order** — ✅ `adoptRecord` sets `docIdRef` BEFORE
  `resetDoc`; the clobber scenario has a standing regression check in
  `verify-multidoc-m2.mjs`.
- **Undo across switches** — ✅ cleared by design (document boundary); this was
  the spec'd v1 behavior, not a gap.
- **Corrupt/missing record recovery — ✅ DONE (2026-07-06, `feat/corrupt-doc-
  recovery`).** Fixed an atomicity bug (`adoptRecord`/boot-restore validated
  `record.doc` via `migrateDocument` AFTER already mutating `docIdRef`/state,
  so a throw left the app pointing at a broken doc while rendering the old
  one — the next autosave would silently overwrite the corrupt record).
  Validation now runs first; nothing mutates on failure. `openDocument`/
  `duplicateDocument` throw descriptive errors instead of silently no-op'ing;
  the Documents dialog shows them inline (bold **Export as JSON**), and a
  dismissible topbar banner covers the boot-restore case, with an inline
  "Documents" link rather than a separate button. No new "export raw" UI was
  needed — `serializeDocFile` never calls `migrateDocument`, so the existing
  per-row Export as JSON button already recovers a corrupt document's data.
  15 checks in `scripts/verify-corrupt-doc-recovery.mjs`.

#### Remaining open items (not yet built)

- **No UI for a failed autosave/flush.** `putDoc`/`flushSave` failures only
  `console.warn`; the status chip reflects kernel regen state, not save
  health. Spec called for "a persistent banner if the LAST save failed" —
  not built. Low-frequency (IndexedDB failures are rare — private mode, quota)
  but silent data loss is a bad failure mode if it happens.
- **Kernel builder/mesh caches evict on doc switch** (documented+accepted in
  Performance above, repeated here so it isn't lost track of): switching
  A→B→A re-solves A's sweeps/lofts/booleans from scratch on the way back
  (the saved-mesh instant-paint hides the *visual* gap, not the recompute
  cost). Follow-up: per-doc used-sets or a "used in the last K regens" sweep
  policy instead of "used this run."

#### Delivery steps

1. **M1 — Storage + title (foundation). ✅ DONE (2026-07-06, `feat/multidoc`).**
   DB v2 (meta store + cursor-backfill migration + `putDoc`/`listMeta`/
   `renameDoc`/`duplicateDoc` dual-store transactions), `activeDocId`
   localStorage pointer (boot restores the TAB's doc, fallback most-recent),
   topbar click-to-edit title + browser tab title, autosave dual-writes and
   preserves createdAt/thumb. 9 vitest against `fake-indexeddb` (new devDep) +
   `scripts/verify-multidoc-m1.mjs` (9 headless checks incl. live v1→v2
   migration). *(The docIdRef-clobber regression test moves to M2 with the
   switch flow it guards.)*
2. **M2 — Documents dialog. ✅ DONE (2026-07-06).** `DocumentsDialog` (modal on
   `.modal-overlay`, lists from `meta` only; inline rename, two-step delete,
   duplicate-opens-copy; Esc/overlay-click closes), topbar split into
   **"＋ New"** (creates + opens directly) and **"Open…"** (opens the dialog;
   the dialog's own header ＋New button was removed as redundant — UX pass,
   2026-07-06); the switch flow in App (`flushSave` → `loadDoc` →
   `adoptRecord`: docIdRef set BEFORE `resetDoc` — the clobber guard),
   delete-active falls back to next-recent-else-seed, BroadcastChannel
   `openpoly-docs` open/present/leave handshake → amber "Also open in another
   tab" badge. New `.text-btn` CSS class (auto-width sibling of the fixed
   28×26 icon `.tool-btn`). *(The planned ⌘O shortcut was tried and removed —
   browsers reserve Cmd/Ctrl+O for their own Open-File dialog, so it never
   fired; no shortcut for now.)* 4 vitest (`docNames.test.ts`) +
   `scripts/verify-multidoc-m2.mjs` (13 headless checks: isolation, flush
   inside the debounce window, duplicate, delete-active fallback, two-tab
   warn + clear).
3. **M3 — Thumbnails + `.json` import/export. ✅ DONE (2026-07-06).**
   Thumbnails: `captureThumb` (viewport `capturePNG` → 256 px JPEG blob via
   offscreen canvas) on regen settle throttled 30 s/doc + on every
   switch-away; `db.setThumb` writes meta only. Files: `storage/docFile.ts`
   (envelope `{format:"openpoly-doc", version, name, doc}`, meshes excluded,
   readable parse errors) — Export row action (flushes active first),
   Import… button + drag-drop onto the dialog (migrate + FRESH id +
   `dedupeName`; error banner in the dialog). 9 new vitest (envelope
   round-trip/rejections, dedupeName, setThumb) + `verify-multidoc-m3.mjs`
   (12 headless checks: thumb in meta + rendered, envelope shape/filename,
   import opens deduped fresh-id copy, corrupt file errors readably).
4. **M4 — Agent tools. ✅ DONE (2026-07-06).** Ops `openDocument` /
   `newDocument {name?}` / `renameDocument` / `duplicateDocument` (each
   settles its own regen and bypasses the setDoc tail; active doc exempt from
   the existence check — it may predate its first autosave) + the `documents`
   read (`list_documents`, active flagged). `AgentContext.documents` delegates
   through App's `agentDocApiRef` so every switch runs the real flush→adopt
   flow. `SceneSummary` gains `documentId`/`documentName`; MCP tool
   descriptions + a "Documents" section in the modeling guide (no delete —
   ask the human). 5 vitest (recording-stub ops + listDocuments) +
   `verify-multidoc-m4.mjs` (11 headless checks: identity in summary, list,
   new/open/duplicate/rename round-trip, active-no-op, not_found) +
   `mcp-e2e.mjs` green (32 tools).

> **Phase 8.7 complete (M1–M4, 2026-07-06).** The workspace is genuinely
> multi-document for both the human (dialog, title, thumbnails, .json files)
> and the agent (list/open/new/rename/duplicate + document identity in reads).

### Phase 8.5 — UI/UX backlog (next polish pass) — IN PROGRESS (7/8 done)

> Remaining: **#5** (timeline formatting). Items #1, #2, #3, #4, #6, #7, #8 are ✅ DONE.

A focused pass on layout, discoverability, and the two interactions that still
feel rough (extrude extents, boolean operand picking), plus shortcuts and the
spline tool. Captured 2026-06-21.

1. **Relocate the Constraints list + Parameters so they're discoverable. ✅ DONE.**
   Both used to sit in the left sidebar *below* the Parts list, easy to miss.
   Now a **movable `EditPanel`** (`ui/EditPanel.tsx`) floats over the viewport,
   anchored below the model toolbar / right of the sketch toolbar (`left:66 top:58`,
   draggable by its title bar via `DraggableDialog`). It mounts **only** when
   something is being edited — a selected feature (its Parameters, titled with the
   feature type via the new `featureTypeLabel` in `featureDefs.ts`) and/or the
   active sketch's Constraints. A ✕ hides it; the next selection brings it back
   (keyed on `targetKey`). Verified end-to-end by `scripts/verify-edit-panel.mjs`
   (5 checks). See `ui/ParamEditor`; the sidebar tail is now empty below Parts.
   **Panel follow-up (2026-07): constraint-list hover highlighting.** Hovering a
   constraint row emphasises its name (`.cl-hover`, teal) and lights up the
   entities/points it acts on in the viewport, via a new `emphasize?: Selection[]`
   prop on `Viewport` (hover colour, pointer-independent). Mapping =
   `constraintSelections` in `App.tsx` (`constraintEmphasis` memo); point refs →
   precise uv markers via `pointRefUv`. Verified by
   `scripts/verify-constraint-hover.mjs`.

   **Unified edit model (2026-07): one editor per feature, opened by double-click.**
   Selection now only highlights — it no longer pops a params surface (that was
   redundant with, e.g., the Transform gizmo dialog). Double-clicking a timeline
   row opens the single editor for that feature (`openFeatureEditor` in `App.tsx`):
   - `sketch` → sketch-edit mode; `transform` → gizmo dialog (both pre-existing).
   - Features **with a creation dialog** (`extrude`, `plane`, `revolve`, `boolean`,
     `mirror`, `pattern`, `chamfer/fillet`) re-open that dialog **populated in edit
     mode**: each dialog state carries an `editId`, the `edit*` opener seeds it from
     the feature, inputs stay **re-pickable** through the existing selection/arm
     paths, and Confirm ("Done") routes to a new in-place `update*` document setter
     (`updateExtrude/Plane/Revolve/Boolean/DressUp/Mirror/Pattern`) that preserves
     id/name/appearance/timeline-position instead of `add*`-ing a duplicate.
   - Features **without a creation dialog** (`primitive`, `import`, `sweep`, `loft`)
     open their `ParamEditor` in the floating `EditPanel` (`editParamsId`), which now
     also hosts the sketch Constraints list. Live edits via `updateParam`; ✕ / Esc /
     select-away close it.
   Doc setters unit-tested (`document/editInPlace.test.ts`, 6). E2E:
   `scripts/verify-edit-dialogs.mjs` (single-click no panel; primitive params;
   extrude edit updates in place, no duplicate) + `scripts/verify-edit-transform-plane.mjs`
   (transform de-dup; plane edit in place).

   **Edit-mode polish (2026-07):**
   - *Live preview on every edit.* Editing a dialog feature applies changes to the
     doc **live** (a per-dialog "live-sync" effect → `update*` under one coalesced
     `edit:<id>` undo step), so the real regen previews each change; **Cancel**
     reverts to a snapshot taken on open (`beginEdit`/`commitEdit`/`cancelEdit`).
     `shouldLiveApply` (a params-signature guard) skips the open-time seed and
     breaks the doc→effect feedback loop that would otherwise re-apply on the
     Cancel restore. No-dialog params (box/cylinder/sweep/loft) already previewed
     live via `updateParam`. Verified by `scripts/verify-edit-preview.mjs`.
   - *Reference planes are clickable in the viewport.* `pickSelection` raycasts the
     user-plane quads (lowest priority) → a `feature` selection, so a plane
     highlights in the viewport AND its timeline row lights up (and vice-versa);
     `applyHighlights` brightens a selected/hovered plane (folded in the old
     `applyUserPlaneAppearance`).
   - *Params box styled like the dialogs.* `.edit-panel` param rows use the
     creation-dialog `.ed-field` flex look (label left / control right), and the
     panel now shares the creation-dialog **blue border** + lighter section labels
     (dropped the bold sidebar heading + redundant "Parameters" label), so a
     solid/sketch edit menu reads identically to Extrude/Revolve/etc.

   **Circular-face extrude fix (2026-07).** Extruding/booleaning a cylinder face
   used to fail (`StdFail_NotDone`) — the analytic `gp_Cyl` boolean bug (see
   BACKLOG). Fixed by faceting: the **cylinder primitive** is now a faceted prism
   (`facetedCylinderShape`), and **curved body-face profiles** are rebuilt as
   faceted planar faces (`facetedProfileFace`, boundary sampled via OCCT
   `GCPnts_TangentialDeflection`) before prisming. Both look like the already-
   faceted extruded circles; diameter readout preserved. Verified by
   `scripts/verify-circular-extrude.mjs`. (Sphere booleans still analytic-limited.)
   **Revolve too (2026-07):** revolve is now a faceted ruled loft
   (`facetedRevolveFromFace`, `BRepOffsetAPI_ThruSections` over rotated profile
   wires) instead of analytic `MakeRevol`, so extruding/cutting a revolve face
   works. Falls back to analytic `MakeRevol` for holed / axis-touching profiles.

   **Smooth DISPLAY of faceted bodies (2026-07).** Faceted curved bodies now
   *render* round while staying faceted for the kernel: `smoothMeshNormals`
   averages per-vertex normals within a crease-angle smooth group (walls shade
   smooth; real corners stay sharp), and `smoothEdgeHashes` + `filterSmoothEdges`
   drop the near-tangent facet-seam edges. Full revolves additionally run
   `ShapeUpgrade_UnifySameDomain` to merge coplanar cap segments + unify the
   loft's closing-seam edges (a faint wall seam can still remain). Display-only —
   picking / measurement / booleans use the untouched faceted solid. `CREASE_DOT`
   (~22°) is the single crease threshold; `CIRCLE_FACETS` unchanged (96).

   **Spline draft-preview regression fixed (2026-07).** The fat-line `previewLine`
   reused one `LineGeometry` via `setPositions`, which doesn't grow its rendered
   instance count as points accumulate — so a spline-in-progress drew only its
   first segment. Rebuilt fresh each update (same workaround as the highlight
   overlay). Sketch geometry + commit were always fine; this was render-only.

2. **Improve Extrude "Through All" + move extents to a dropdown — ✅ DONE.**
   Extent picker moved to a **dropdown** (Blind / Symmetric / Through All / Up to
   face are now a `<select>` in the extrude mini-dialog, replacing the button
   row; `ParamEditor` mirrors it). The murky additive case is resolved by
   **restricting Through All to Remove (cut) only** — the option is **hidden**
   for New and Add (shown only in Remove), and switching a feature to New/Add
   reverts a selected Through All back to Blind (`updateParam` guard). Additive "grow until you hit something" is served
   by **Up to face** (#3) instead. (`extent` UI in `App.tsx` extrude dialog;
   `extrudeLengths`/`throughAllLength` in `kernel/worker.ts`.)

3. **Add an "Up to face" extrude extent — ✅ DONE.** New `extent="upToFace"`
   option; choosing it shows a **"Select a face"** button that arms a viewport
   face pick (the next clicked body face fills `upTo` = `{featureId, faceName,
   center}`; re-clickable to re-pick). The kernel computes the signed prism
   length from the profile plane to the **plane of the target face** along the
   extrude direction (so flip/distance are ignored — the face drives both
   distance and direction), and **rejects faces parallel to the extrude
   direction** with a clear error (a side face → "extrude direction is parallel
   to the target face"). Distance/Flip fields hide for this extent. Verified:
   pillar top lands exactly on the target face's plane. (`ExtrudeExtent` +
   `UpToFaceRef` in `document/types.ts`; resolve in `document.ts`; `upToFaceLength`
   in `kernel/worker.ts`; dialog + `pickingUpFace` arming in `App.tsx`.)
   *Remaining:* trim to the actual (possibly non-planar) face surface rather than
   its plane; up-front client validation of face eligibility.

4. **Replace the Boolean checkbox dialog with click-to-populate — ✅ DONE.** The
   `BooleanDialog` is now a **small movable dialog** (no modal overlay) that
   **fills operands as bodies are clicked** in the viewport (click a body → added
   in order; click again → removed; ✕ per row to remove), with the op
   (union / subtract / intersect) chosen there and a live ordered operand list
   (subtract notes "first = base, rest = tools"). (`ui/BooleanDialog.tsx`,
   `openBooleanDialog`/`handlePick` boolean branch in `App.tsx`.)

5. **Timeline formatting.** Re-evaluate the bordered **box** around the timeline
   — is it needed for the drag-resize affordance, or can the splitter work
   without the frame? Tighten **spacing to be consistent with the datums** now
   that datums live inside the timeline. (`FeatureTree` `.tree`/`.panel-splitter`
   + `.tree-row`/`.datum-row` spacing in `App.css`.)

6. **Less space above the Variables title — ✅ DONE.** Tightened the
   `.params-heading.collapsible` top margin from 22px to 10px.

7. **Implement keyboard shortcuts. ✅ DONE.** Wired up in a global, mode-gated
   `useEffect` key handler in `App.tsx` (mutually exclusive modeling vs sketch
   branches, ignores typing in inputs). Resolved the two flagged letter
   conflicts (New Body vs Boolean → `N`/`B`; Polygon vs Parallel/Perpendicular
   → `P`/`Shift+P`/`N`) and extended coverage to the features shipped since the
   proposal was written (Loft `L`, Sweep `W`, Mirror `M`, spline `Shift+L`,
   construction toggle `Q`, digits `1`–`7` for standard views).
   Every bound button's `title` tooltip now names its key. See
   `KEYBOARD_SHORTCUTS.md` for the full scheme and future-conflict notes
   (Pattern, Measurement, multi-doc manager).

8. **Spline tool in sketch — ✅ DONE** (see Phase 6). Through-point smooth
   spline `SketchEntity`, the `∿` tool, used as a sweep path **and as a
   closed-region boundary** (arcs + splines now bound extrudable regions — see
   Phase 2a / `regions.ts`).

---

## Phase 9 — LLM agent integration (local MCP) — IN PROGRESS (L0–L3 done, L4 next)

**Status (2026-06-20).** **L0–L3 shipped, and validated against a real MCP
client** (Claude Code + Claude Desktop): the agent reads the scene, sketches,
extrudes, dresses up, and screenshots a live tab end to end — "runs extremely
well" in manual testing. The command + read layer (L0), the browser WebSocket
bridge (L1), the **Node stdio MCP server** (`mcp-server/`, L2), and **regen-await
+ read/screenshot polish** (L3) flow client → server → hub → tab → kernel → back.
After L3 a mutating op **awaits the kernel regen** before returning, so a single
follow-up read/screenshot sees the result (no polling) and a failed build
surfaces as `kernel_error` for the agent to self-correct. Wired for Claude Code
via a committed root `.mcp.json`; setup in `mcp-server/README.md`. See the L0–L3
entries under *Delivery steps*. **Phase 9 work was merged to `main` on
2026-06-29** (branch `feat/phase9-agent` deleted). Beyond the core ops, the
command/MCP layer exposes **up-to-face extrude**, **revolve** (symmetric +
edge/plane/face axis), **extrudable text**, and the **`add_offset` /
`add_sketch_mirror`** derived-geometry ops (`get_scene_summary` applies derived
geometry, so generated edges are referenceable/extrudable). **Project/Convert has
no agent op yet** — it's UI-only because its persistent-edge-name capture +
post-rebuild reprojection loop doesn't map onto a one-shot document op; the guide
tells the agent to reference faces/edges directly instead. **Explicit sketch
constraints + dimensions — ✅ DONE (agent ops).** `add_constraint`
(horizontal/vertical/parallel/perpendicular/equal/tangent/**coincident/
pointOnLine/midpoint** — points addressed as `{entityId, at:"a"|"b"|"c"}` or
`{origin:true}`), `add_dimension` (length/radius/angle/**distance** between two
point/line/rim refs; `value` takes a number or a **variable expression**,
evaluated to a number at apply time — a live re-link on later variable changes is
the residual gap), and `remove_constraint`. Each re-solves and is **rejected**
(with a culprit-naming message) on conflict / already-implied / collapse, mirroring
the UI's commitConstraint/applyDimension guardrails; `get_scene_summary` now lists
each sketch's constraints (id + type + touched entity ids + value). Derived and
text entities aren't constrainable. **L4 (robustness: token auth, multi-tab, error
taxonomy, list/open/new_document) is next.**

**Goal.** Let a local LLM agent (Claude Desktop, Claude Code, Cursor, Cline, Zed,
…) **drive the live Open Poly browser tab** — sketch, extrude, transform, arrange
— while the user *watches it happen in their browser*, and let the agent **read
state** (document, a scene summary, a viewport screenshot) so it can plan and
self-correct, including resuming a prior session's document. **Scope: local,
single-user, stdio MCP.** Remote/hosted MCP and an in-app chat agent are explicit
**stretch goals** (below).

### Design principle — two layers (don't build an "MCP app")
1. A **vendor-neutral command + read API** over the document (apply a typed
   `Operation`; read document / scene-summary / screenshot). Knows nothing about
   any LLM or transport.
2. **Adapters** on top. MCP is the first adapter; because layer 1 is neutral, a
   future in-app agent or OpenAI/Gemini function-calling adapter reuses it with no
   rework. **Build layer 1 first and well.**

### Architecture (data flow)
```
LLM client ⟷ (stdio MCP) ⟷  bridge/MCP server (Node)  ⟷ (WebSocket) ⟷  browser tab
                              one process, two faces                    (command layer)
```
- The **browser tab holds the state and renders**, so it must **connect out** (a
  tab can't be listened to). The tab opens a WebSocket to a `localhost` hub.
- The **MCP server and the WebSocket hub are one Node process**: stdio to the LLM
  client, a WS server for the tab. An MCP tool call → forward over WS to the tab →
  the tab applies it via the command layer → renders (user watches) → returns
  result/ids/errors (and, for `screenshot`, a PNG) → back to the LLM.

### Component 1 — Command layer (browser, vendor-neutral core)
New dir `src/agent/`.
- `operations.ts` — the typed **`Operation`** discriminated union + **`OpResult`**
  + read-query types + **zod schemas** (validation reused by the server). Each
  `Operation` maps onto an existing pure document fn in `src/document/document.ts`:
  - `addPrimitive {kind:"box"|"cylinder"|"sphere", params?, name?}` → `addFeature`
    + `updateParam`/`setParam`.
  - `addSketch {plane: PlaneRefSpec, entities: EntitySpec[], constraints?}` →
    `addSketch` + `addSketchEntities` (+ `setSketchConstraints`). Non-interactive:
    the agent supplies entities in plane **(u,v)** coords in one call. Provide
    sugar specs (`rect{center|corner,w,h}`, `circle{c,r}`, `polygon{c,r,n}`) that
    expand to entities so the model doesn't hand-place every line. Any entity may
    set `construction:true` (reference-only — e.g. a revolve **axis** line).
  - `addExtrude {profile: ProfileSpec, distance, flip?, extent?, mode?,
    targetId?}` → `addExtrude`. `ProfileSpec` = `{sketchId, regionId}` **or**
    `{bodyId, faceName}`. `extent` = `blind` | `symmetric` | `throughAll`
    (throughAll needs a `targetId`). *(Multi-profile: the agent issues one
    addExtrude per region.)*
  - `addRevolve {profile:{sketchId,regionId?}, axis:{sketchId,entityId}, angle?}`
    → `addRevolve`. The axis is a **line** entity (id from the scene summary's
    sketch `entities`); the region must not cross it. `angle` defaults to 360.
  - `addMirror {targetId, plane: PlaneRefSpec}` → `addMirror`. Reflects a body
    into a new body (original kept).
  - `addPlane {base: PlaneRefSpec, offset}` → `addPlane`.
  - `transform {targetId, tx?,ty?,tz?, angle?, axis?, copy?}` → `addTransform`.
  - `boolean {op, operands[]}` → `addBoolean`.
  - `dressUp {kind:"chamfer"|"fillet", targetId, edges:string[]/*names*/, size}` →
    `addDressUp`.
  - `setParam {featureId, name, value}` / `setAppearance {featureId, color?,
    opacity?, hidden?}` / `rename` / `delete` / `setRollback {index}` /
    `select {refs}` (so a screenshot shows what's highlighted).
  - **Reference handles must be stable ids the agent got from a read**: feature
    ids; **persistent face/edge names** (we already emit `mesh.faceGroups[].name`
    / `edgeGroups[].name`); plane refs (`{datum}`/`{planeId}`/`{bodyId,faceName}`);
    sketch `regionId` (deterministic from `detectSketchRegions`). **Conventions:
    millimetres, world is Z-up** — state this in every tool description.
- `commands.ts` — `applyOperation(ctx, op): Promise<OpResult>` and the reads
  `getDocument(ctx)`, `getSceneSummary(ctx)`, `getSelection(ctx)`,
  `screenshot(ctx, opts?)`. `ctx` exposes the **live** doc + setters + viewport,
  via **refs** (always read latest, never a stale closure — mirror how
  `Viewport.tsx` uses `selectionRef`).
  - **Route every mutation through `setDoc`** (the `useHistory` setter) so the
    user can `Cmd-Z` anything the agent did — the agent is "just another input
    device."
  - **Await regen settle** before resolving a mutating op: kernel regen is async
    in the worker, so `applyOperation` must wait for the next `rawMeshes`/`errors`
    update before returning, so the agent knows it succeeded and can screenshot.
    Implement via a one-shot "regen done" promise the regen effect resolves.
  - Return `{ok, createdId?, doc-delta or summary, errors?}` — structured, so the
    model can chain ("extrude the face I just made").
- `useAgentBridge.ts` — a hook mounted in `App.tsx` that builds `ctx` (closing
  over `doc`/`setDoc`/`selection`/`setSelection`/`viewApiRef`/`meshes`/`resolved`
  via refs) and owns the WebSocket client. Also expose `window.__openpoly` =
  `{apply, read}` in dev for manual console testing before any networking.

### Component 2 — WebSocket bridge client (browser)
- `src/agent/bridgeClient.ts`: connect to `ws://127.0.0.1:<port>`, send `hello`
  (session id + optional token + a `conventions`/capabilities blob), then service
  `request` messages by calling the command layer and replying with `result`.
- **Serial request queue**: process one request at a time and **await each op's
  commit + regen** before the next — React state updates are async, so op *N+1*
  must observe op *N*. No concurrency on a single tab.
- **Reconnect** with backoff on drop/reload. Show an **"Agent connected"**
  indicator (a small badge in the top bar) so the user knows a session is live.

### Component 3 — Bridge + MCP server (Node, `mcp-server/` — its own package)
Separate runtime (Node, not the browser bundle); own `package.json`. Use the
official **`@modelcontextprotocol/sdk`**.
- `wsHub.ts` — a `ws` server on a fixed localhost port; tracks the connected
  tab session(s); request/response correlation by `id`; timeouts; "no tab
  connected → clear error telling the user to open Open Poly."
- `protocol.ts` — **shared** WS message types (`hello`, `request{id,kind:"apply"
  |"read",payload}`, `result{id,ok,payload|error}`, optional `event`). Keep a
  single source of truth importable by both browser and server (a small shared
  `.ts` both tsconfigs include).
- `tools.ts` / `index.ts` — register one MCP **tool per Operation** + read tools
  (`get_document`, `get_scene_summary`, `screenshot`); validate args with the
  shared zod schemas; forward over the hub; map results to MCP content. For
  `screenshot`, return MCP **image** content (base64 PNG). Optionally also expose
  `get_document`/`get_scene_summary` as MCP **resources** (subscribable URIs).
- Ship a **config snippet** for Claude Desktop / Cursor / Cline (the `command`/
  `args` stdio entry) and a one-line `npx`/`node` launch.

### Read API detail
- `get_document` → the full JSON `Document` (+ schemaVersion) — ground truth.
- `get_scene_summary` → compact, LLM-first digest: **bodies** (id, name, kind,
  bbox, volume, color, **named faces + edges**), **sketches** (id, plane,
  entities, regions w/ ids), **planes**, **variables**, **rollback index**,
  **selection**. This is the model's primary planning input — keep it small and
  semantic, not raw geometry. (bbox from mesh vertices in-app; volume can come
  from the kernel — `measureVolume` is already available in `worker.ts`.)
- `screenshot {view?, fit?}` → set the camera (reuse `ViewportApi.setView`),
  render, `renderer.domElement.toDataURL("image/png")`. **Add a `capturePNG()`
  method to `ViewportApi`** (`src/viewport/Viewport.tsx`) — it owns the renderer.
  Visual feedback is the big unlock: the agent can *see* what it built.

### Cross-session state
- Ground truth is **IndexedDB** in the tab (`src/storage/db.ts`); the agent reads
  the current doc/summary on connect. The hub may cache the last snapshot per
  session for quick re-reads.
- Lean on the **multi-document manager** (Phase 8): expose `list_documents` /
  `open_document` / `new_document` tools so "continue yesterday's bracket" = open
  that doc + `get_scene_summary`. *(Full design: "Phase 8.7 — Multi-document
  manager (spec)" → Agent integration.)*

### Agent modeling guide + issue reporting
- **The "skill"** — a concise modeling playbook lives at
  `src/agent/modeling-guide.md` (drafted): mental model, conventions (mm, Z-up,
  reference-by-name), the read→plan→one-op→verify loop, recipes, and best
  practices (drive dimensions with **variables**, constrain sketches, name
  parts, verify with screenshots). It is the source of truth, **version-
  controlled with the tools and kept in sync with them**. Deliver it to clients
  as an MCP **prompt** + **resource**, plus a `get_modeling_guide` tool, so any
  connecting client picks it up automatically.
- **`report_issue` tool (first-class feedback loop).** The guide instructs the
  agent: when blocked or surprised, don't fake geometry — call `report_issue`
  with `kind: "missing_feature" | "bug" | "friction"` (+ goal / what-it-tried /
  expected / observed / suggested API). The server **appends these to a
  reviewable log** (a file and/or a dev-facing resource), deduped. This turns the
  agent into a product-feedback generator — surfacing both **capability gaps**
  (revolve, sweep/loft, pattern/mirror, midplane/angle planes, more constraints…)
  **and bugs** — and keeps it honest instead of hallucinating geometry.
- Design implication already reflected in the Operation set: **variables are
  first-class** (so the guide can say "parameterize it"), there is a
  **`screenshot`** tool (verify loop), and references are by **stable name/id**.

### Engineering concerns / guardrails
- **Undo-routed** mutations (above) = the human stays in control.
- **Human-in-the-loop on destructive ops** (delete / boolean consuming bodies /
  setRollback): allowed + undoable for v1; leave a `confirm` hook for later.
- **Security**: bind WS to `127.0.0.1` only; a shared **token** (app displays it;
  MCP config carries it) so random local processes can't connect. Single active
  tab for v1 (last-connected wins; surface it in the badge).
- **Errors**: a small taxonomy (`not_found`, `invalid_op`, `kernel_error`,
  `no_session`, `timeout`) with human-readable messages the model can act on.

### Delivery steps
- **L0 — Command layer, no networking. ✅ DONE (2026-06-19).** Built in
  `src/agent/`: `operations.ts` (zod `Operation` union + `OpResult`/`ReadQuery`/
  `SceneSummary` + `expandEntities` sugar shapes; added **zod v4**), `commands.ts`
  (`applyOperation` routed through the pure `document.ts` fns + the undo setter;
  reads `getDocument`/`getSceneSummary`/`getSelection`/`screenshot`; resolves
  face/profile refs from mesh `faceGroups`), `useAgentBridge.ts` (builds the
  `AgentContext` from refs, exposes `window.__openpoly={apply,read,…}` in dev).
  Added `capturePNG()` to `ViewportApi`; mounted the hook in `App.tsx`. Unit
  tests in `commands.test.ts` (14 pass); tsc + build clean. **Verified** end-to-
  end via Playwright driving `window.__openpoly` (box → sketch-on-named-face →
  extrude-remove → screenshot; named faces + bbox resolve). *Deferred:* regen-
  await (L3) — only synchronous resolve errors surface today; the modeling-guide
  lists snake_case MCP tool names while Operation discriminators are camelCase
  (reconcile the mapping in L2).
- **L1 — WS bridge. ✅ DONE (2026-06-19).** `src/agent/protocol.ts` (shared
  `hello`/`request`/`result`/`event` types + fixed port `7373`, the single source
  of truth for browser + future server), `bridgeClient.ts` (dials the hub,
  announces `hello` with a capabilities blob, **serial request pipeline** that
  awaits each before the next, capped-backoff reconnect, status callback). Wired
  into `useAgentBridge` (handlers validate via the shared zod schemas) with an
  "Agent connected" badge in the topbar. Throwaway hub `scripts/bridge-e2e.mjs`
  (added `ws` devDep) + Playwright **validated** round-trips: apply/read, serial
  ordering, structured errors, badge. *Note:* the tab auto-connects in prod too,
  so it logs WS connect errors (~every ≤10s) when no hub runs — add an
  enable/token gate in L4.
- **L2 — MCP server (stdio). ✅ DONE (2026-06-20).** `mcp-server/` (own package,
  runs from TS via `tsx`; deps `@modelcontextprotocol/sdk` 1.29 + `ws`): `wsHub.ts`
  (localhost WS hub on :7373, id-correlated request/response, timeouts, clear
  "no tab connected" error), `tools.ts` (one MCP tool per Operation + the read
  tools, **input schemas derived from the shared `operations.ts` zod schemas** so
  the contract can't drift; `screenshot` → MCP image content), `index.ts` (stdio
  transport + the modeling guide as tool/resource/prompt + `report_issue` →
  `issues.log.jsonl`). All logging on **stderr** (stdout is the JSON-RPC channel).
  Config snippets in `mcp-server/README.md`. **Validated** by `scripts/mcp-e2e.mjs`
  (SDK client spawns the server, Playwright tab dials the hub, 21 tools, full
  round-trip incl. image content + structured errors). *Note:* tool names are
  snake_case ↔ camelCase Operation discriminators (mapped in `tools.ts`).
- **L3 — Reads + screenshots + regen-await polish. ✅ DONE (2026-06-20).**
  `applyOperation` is now async and **awaits the kernel regen** before resolving:
  App's regen effect feeds `agentMeshesRef`/`agentErrorsRef` synchronously on
  settle and flushes one-shot `waitForRegen` promises, gated by a regen
  start-sequence so a waiter only resolves on a regen that began *after* the op
  (otherwise the slow initial-load regen resolves it early). A created feature
  that fails to build is returned as `ok:false` `kernel_error` (with
  `featureErrors`). `get_scene_summary` reads the fresh meshes (bbox + named
  faces/edges; color derived from the feature) and `screenshot` returns image
  content. **Validated** by `scripts/mcp-e2e.mjs`: a *single* read right after an
  awaited apply sees the new body (no polling), and `dress_up` on a bogus edge
  surfaces `kernel_error` ("fillet: no matching edges"). 8/8 checks, stable across
  repeats. **Exit met** (mechanics): build → single-read verify → error-driven
  self-correct all work; an LLM driving it is the natural next manual test.
- **L4 — Robustness.** token auth, multi-tab handling (concurrent agent
  sessions on the bridge — distinct from Phase 8.7's document-level
  BroadcastChannel guard), error taxonomy, queue ordering, reconnection,
  timeouts. *(`list/open/new_document` tools — ✅ DONE, Phase 8.7 M4.)*

### Existing touchpoints (where a new session hooks in)
- `src/document/document.ts` — every mutating `Operation` maps to a fn here.
- `src/App.tsx` — `doc`/`setDoc` (undo), `selection`/`setSelection`,
  `viewApiRef`, `meshes`/`rawMeshes`, `resolved` (`scope`, `errors`,
  `planeFrames`); mount `useAgentBridge` here.
- `src/viewport/Viewport.tsx` — `ViewportApi` (add `capturePNG()`; `setView`,
  `worldToScreen` exist).
- `src/kernel/worker.ts` — `measureVolume` for the summary; mesh `faceGroups`/
  `edgeGroups` carry the **persistent names** the agent references.
- `src/storage/db.ts` — current/saved documents for cross-session continuity.

### Stretch goals (future)
- **Remote (Streamable-HTTP) MCP server + session pairing** so hosted/web chat
  UIs (ChatGPT/Gemini connectors, claude.ai) can drive it — adds hosting, auth,
  and a pairing code; softens local-first (server in the loop).
- **In-app chat agent** (zero-setup) calling an LLM API directly, reusing the
  same command layer.
- **OpenAI/Gemini function-calling adapters** for non-MCP tool clients.

---

## 5. UX/UX principles (to feel like a polished parametric modeler)

- **Direct manipulation + a tree.** Everything you do becomes a tree feature; the
  tree is editable history, not a log.
- **Context toolbar / mini-dialog** anchored near the selection, not buried menus.
- **Pre-select then act, or act then select** — support both (e.g. pre-highlight
  edges then hit Fillet).
- **Live preview** of a feature before commit (ghosted result + OK/Cancel).
- **Constraint feedback** with color (blue=under, black=fully, red=over).
- **Normal-to camera** + auto-grid when entering a sketch; clear "exit sketch."
- **Rollback bar** to time-travel the model.
- **Hover highlight** every selectable entity; clear selection filters.
- **Non-blocking regen** with a subtle progress indicator (worker-driven).

---

## 6. Top risks (and the plan for each)

| Risk | Mitigation |
|------|-----------|
| **Topological naming** breaks references on edits | ✅ Mitigated: OCCT history maps + scored geometric fallback (`topoMatch.ts`) + fixable-error/warning surfacing all shipped (2026-07-06). Residual: fingerprints go stale if geometry moves far AND names churn simultaneously. |
| OCCT WASM **bundle size / load time** | Lazy-load the worker; tree-shake via replicad; show a splash; cache the WASM. |
| **Regen performance** | ✅ Worker thread, debounced regen, and content-hash-keyed incremental caching (unchanged bodies skip re-solve + re-mesh) all shipped. LOD (distance/zoom mesh simplification) not built — not yet a bottleneck. |
| **Constraint solver** robustness | Lean on planegcs rather than rolling your own; constrain the supported constraint set early. |
| Selource **license** mix (LGPL GCS, OCCT LGPL-with-exception) | Audit each dependency's license before committing to a project license. |
| Scope creep (this is a *lot*) | Ship Phases 0–3 as a real milestone before going wide. |

---

## 7. TL;DR

- **Engine:** `three.js` (render) + **`opencascade.js`** (B-rep kernel), behind
  **our own `Kernel` facade**; `replicad` is an accelerator/reference, not the
  core. A real B-rep kernel is required for selectable face/edge topology, clean
  fillets, and STEP export.
- **Constraints:** `planegcs`.
- **Architecture:** a document = an ordered **timeline of features**, each a pure
  function of params + references + variables; regeneration replays it.
- **Run the kernel in a Web Worker.**
- **Hardest problem:** topological naming — plan for it, don't be surprised by it.
- **First milestone:** Phases 0–3 (constrained sketch → extrude with variables &
  timeline).
