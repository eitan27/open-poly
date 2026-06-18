# Open Poly — Architecture & Delivery Plan

A local-first, browser-based parametric CAD (a "simple Onshape"). This document
captures the core technical decision (which engine/kernel), the architecture, and
a phased roadmap to deliver the requested feature set.

---

## 0. The most important decision: the geometry kernel

> **Don't build on OpenSCAD.** It looks similar in spirit (everything is an
> operation), but it's the wrong foundation for an Onshape/Fusion-style tool.

**Why not OpenSCAD:**
- It is **mesh / CSG-based** (CGAL under the hood). Shapes are triangle soup.
- No **B-rep** (boundary representation) → no real faces/edges/vertices as
  first-class, selectable topology. Onshape's whole UX is "click this face,
  fillet that edge." That requires B-rep.
- Fillet/chamfer on meshes is fragile; revolve/sweep/loft are not native.
- No **STEP/IGES** export (only mesh formats like STL).
- It's a scripting language, not a kernel you can drive from a feature tree.

**What to use instead — OpenCascade (OCCT):** the de-facto open-source B-rep
CAD kernel (it powers FreeCAD, KiCad's 3D viewer, etc.). It is compiled to
WebAssembly as **`opencascade.js`**, so it runs entirely in the browser. It
gives you, directly:

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
- **State:** Zustand (light) for app/document state + command history.
- **Persistence:** IndexedDB via Dexie (local-first; documents saved in-browser).
- **Concurrency:** Run **OCCT and the solver in a Web Worker.** The WASM kernel
  is heavy and regeneration can take 100s of ms — never block the UI thread.
  The main thread holds the document model + UI; the worker holds the kernel and
  returns tessellated buffers (transfer ArrayBuffers, don't copy).
- **Packaging:** ships as a static web app; optionally wrap in Tauri/Electron
  later for a desktop build and native file dialogs. Not needed for v1.

---

## 2. Core architecture — the parametric model

This is the heart of a parametric CAD and what makes it feel like Onshape.

### Document = an ordered timeline of features
A document is an **ordered list of features** (the timeline / feature tree).
Each feature is conceptually a **pure function**:

```
feature(inputParams, references, variableScope) -> Shape(s)
```

**Regeneration** = replay the list top to bottom, threading the resulting bodies
forward. Editing feature *N*'s parameters re-runs *N* and everything after it.
A **rollback bar** (like Onshape) regenerates only up to feature *k*.

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

> **Progress (2026-06-18):** Phases 0, 1, and 2 are complete and committed on
> `main` (Phase 1 landed as chunks 1a/1b/1c; Phase 2 covers datums/navigation,
> sketch tools, planegcs constraints, and a full selection/measurement layer).
> Selection now supports feature/face/edge/vertex/sketch-entity/sketch-point/
> sketch-face picking with multi-select, fat-line highlights (selecting a face
> fattens its boundary edges), planar-graph sketch-region detection, and a
> measurement info pane. Boolean union/subtract/intersect (Phase 4) also landed
> early, directly on primitives — see Phase 4 below. **Phase 3 (extrude/revolve)
> is next** — it consumes the selected sketch profile and is where the
> running-result model (1.5) gets built.

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

### Phase 1.5 — Running-result regeneration model *(deferred, but needed soon)*
The Phase 1 regen model builds N **independent** shapes and renders one mesh per
feature, so feature→feature order is currently cosmetic (only variables couple
things). Real CAD folds operations over a **running set of bodies**: a feature
consumes the prior result (extrude ADD/CUT, boolean, fillet modify an existing
body). This refactor — kernel facade from "build N shapes" to "fold ops over a
running model", plus body-based (not feature-based) selection — is a prerequisite
for Phase 3+ and is the point at which the timeline earns its purpose. Folded into
Phase 3 (extrude NEW/ADD/CUT) rather than done standalone.

### Phase 2 — Sketching (geometry first, then constraints)
- **2.0 — Navigation & datums prep** *(in progress)*: a clickable/snappable
  **origin point**; the three standard datum **planes (Top=XY, Front=XZ,
  Right=YZ)** rendered faintly and hover/click-selectable (selecting one will
  later start a sketch); **standard view navigation** (Front/Back/Left/Right/Top/
  Bottom/Iso/Home) — buttons/dropdown now, a true interactive ViewCube later.
  Establishes the raycast hover/select infrastructure all sketching needs.
- **2a:** Pick a base plane / planar face → enter sketch mode (camera normal-to,
  grid). Draw **line, rectangle, circle, arc, polygon**, point. Snapping
  (endpoints, midpoints, grid, origin, existing geometry). Trim/extend, delete.
- **2b:** Dimensions (driven values, expression-backed) + constraints with
  **`planegcs`**. Show under/fully/over-constrained state with color, like
  Onshape. Drag-to-solve.
- **Exit criteria:** a fully-constrained closed profile that updates when a
  driving variable changes.

> **2b status (2026-06-18):** the solver (`planegcs`) maps lines +
> horizontal/vertical/parallel/perpendicular/distance. Auto H/V capture on line
> draw, a manual ⛓ Solve button, and fully-constrained→green coloring are in.
> **Length dimension is now interactive**: press **D** (or the ↔ toolbar button)
> with a line selected to open a length input anchored next to the line, or with
> nothing selected to arm "pick a line to dimension" mode. The field accepts a
> number, an arithmetic expression, or a variable name (evaluated against the
> variable scope at entry). Submitting adds/replaces a `distance` constraint and
> immediately re-solves so the whole sketch updates. (The value is stored as a
> resolved number — a *live* expression link that re-evaluates when the variable
> changes is still a deferred gap, below.)
>
> **Known gaps in Phase 2 sketch constraints (deferred):**
> - **Dimensions:** only line *length*. No radius/diameter (circle), angle
>   (line–line), point-to-point / point-to-line distance, or driven-by-expression
>   dimension values yet. No on-canvas dimension *labels* (the value isn't drawn
>   next to the geometry; it lives only in the constraint + info pane), and no
>   double-click-to-edit an existing dimension.
> - **Geometric constraints not yet exposed in UI / mapped:** coincident,
>   tangent, equal, concentric, symmetric, midpoint, collinear, fix/lock. (Only
>   H/V are auto-captured; parallel/perpendicular exist in the model + solver but
>   have no UI to add them.)
> - **Point identity is by coordinate key** (see `solver.ts`): coincident
>   endpoints merge by position, robust only until the first solve moves them —
>   wants a real point-based sketch model before heavy constraint editing.
> - **Sketch operations missing:** mirror, use/project (convert edges), offset,
>   trim/extend, construction geometry.
> - Circles/arcs pass through the solver unchanged (not constrained).

> **Reprioritized 2026-06-18 (user):** Extrude is the single most important
> solid op and is the headline of Phase 3; **Chamfer (and Fillet)** matter more
> than Revolve, so they join Phase 3. **Revolve moves to the Sweep/Loft phase**
> near the end. **Export (STL/STEP) is pulled up to Phase 4** to validate an
> end-to-end workflow as early as possible. Boolean-between-bodies, Pattern, and
> Mirror shift back accordingly.
>
> **Color rule (from the pastel-colors work):** every solid-producing feature
> that creates a NEW body (primitive, extrude-New) should set a `color` via
> `randomSolidColor()` (`document/colors.ts`). Add/Remove and chamfer/fillet
> modify a body in place and keep its existing color; a future Boolean union's
> result should take the first operand's color (see the note in `colors.ts`).

### Phase 3 — First solids: Extrude + Chamfer/Fillet
This phase builds the **running-result model** (Phase 1.5): the kernel facade
moves from "build N independent shapes" to **folding operations over a running
set of bodies**, and selection becomes **body-based** (a body's faces/edges)
rather than feature-based. This is the largest architectural step left.

> **Boolean integrated (2026-06-18):** a `BooleanFeature` (union/subtract/
> intersect over 2+ operand bodies, `ui/BooleanDialog.tsx` from the **+ Boolean**
> button) was merged in and ported onto the running-fold + naming model: the
> worker combines the operand bodies in place via `booleanNamed` (BRepAlgoAPI
> Fuse/Cut/Common with name propagation), consuming the operands and keeping the
> result keyed by the boolean's id; each step is validated by **volume before vs.
> after** (OCCT returns a valid-but-empty result for non-overlapping solids).
> The result inherits the first operand's color (`colorOfFeature`). Distinct
> from extrude Add/Remove, which combine a *face-based* tool with one body.

> **Status (2026-06-18): essentially complete.** Running-result fold + extrude
> New/Add/Remove (profiles = sketch regions and body faces) with an anchored
> dialog; chamfer + fillet on named edges. **Proper topological naming** is in:
> face names seeded on primitives and propagated through extrude (MakePrism) and
> booleans (fuse/cut) via OCCT history; edge names derived from adjacent face
> names — so face/edge references survive rebuilds and parametric edits. Built
> with raw `oc.*` (BRepPrimAPI_MakePrism, BRepAlgoAPI_Fuse/Cut, BRepFilletAPI).
> Remaining polish: curved-face naming, body-id identity after add/remove,
> up-to-face end condition. **Next: Phase 4 (export).**

- **Extrude (headline).** Detailed spec:
  - **Profiles:** accepts **one or more faces** — sketch regions (`sketchFace`)
    and/or planar body faces. (Sketch profiles are the common case.)
  - **Result mode**, selectable in the dialog:
    - **New** — create a new body.
    - **Add** (join/union) — merge into the existing body/bodies the extrusion
      originates from or intersects.
    - **Remove** (cut/subtract) — subtract from existing bodies.
    (Default may auto-suggest Add/Remove when the profile sits on / intersects a
    body, else New — but always explicitly overridable.)
  - **Direction:** toggle-able (flip along the profile normal); symmetric/
    two-sided later.
  - **End condition**, in the dialog:
    - **Blind** — a distance value (expression-backed, like other params).
    - **Up to face** — extrude until a selected face that is **normal to the
      extrusion direction**.
    (Up-to-next / through-all can come later.)
  - **Dialog:** an anchored mini-dialog (Onshape-style) exposing profiles,
    result mode, direction toggle, end condition + its value/face. Live ghost
    preview before commit is the goal.
- **Chamfer** (distance / two-distance / angle) and **Fillet** (edge set,
  radius) — edge dress-up on a body. First real exercise of **topological
  naming** (stable edge/face refs under upstream edits); start pragmatic
  (OCCT ids + best-effort matching) and note the limits.
- Exercises the **selection round-trip** end to end: app selection (sketch
  region / body face / body edge) → kernel inputs → new meshed body set back.

### Phase 4 — Export (validate end-to-end)
- **Export STL** (mesh) and **STEP** (B-rep) of a selected part / the whole
  document; image snapshot. Pulled here so the full pipeline — sketch →
  constrain → extrude → chamfer → export a real file — is provable early.
- Minimal part picking needed to choose what to export (full multi-body UX is
  Phase 7). STEP **import** later.

### Phase 5 — Boolean + Pattern + Mirror
- Boolean between separate bodies: union / subtract / intersect (Extrude
  Add/Remove already covers the extrusion-coupled case).
- Linear pattern (1- and 2-direction), circular pattern (axis + count + angle).
- Mirror across a plane/planar face.
- Patterns/booleans multiply topology — re-stress naming/selection here.

### Phase 5.5 — Transform (move + rotate bodies)
- A **Transform** feature that translates and/or rotates a selected body (and
  later: scale, copy). Move by a vector (X/Y/Z deltas, expression-backed) and
  rotate by an angle about an axis (a datum axis, a body edge, or a chosen
  point + direction). Like all features it lives in the timeline and re-applies
  on regen; the transformed body keeps its identity (and topological names) so
  downstream features still reference it.
- UI: a transform gizmo in the viewport (drag-to-move/rotate handles) plus
  numeric fields in the parameter editor. Snap to grid/angles.
- Kernel: `gp_Trsf` + `BRepBuilderAPI_Transform`; names pass through unchanged
  (a rigid transform doesn't alter topology).

### Phase 6 — Sweep + Loft + Revolve
- Sweep: profile along a path (twist control later).
- Loft: through 2+ profiles, optional guide rails.
- **Revolve** around a selected axis/edge (moved here from Phase 3).

### Phase 7 — Multi-body, parts, selection UX
- Multiple bodies/parts in one document; a Parts list; show/hide, color, isolate.
- Robust selection (faces, edges, bodies; hover highlight; selection filters).

> **Early start (2026-06-18):** a first cut of the Parts list landed ahead of
> schedule, while every solid-producing feature is still a primitive — a
> "Solids" panel below the timeline (`ui/SolidsList.tsx`) lists every body,
> and each row supports select, rename, delete, and a color/opacity picker
> (color and opacity are now overlaid onto cached kernel geometry in `App.tsx`
> rather than baked in at creation, so changing them is instant and doesn't
> re-run the kernel). Each row also has **STEP**/**STL** export buttons,
> backed by `Kernel.exportFeature(features, featureId, format)`: the worker
> rebuilds the requested feature's shape (and whatever boolean operands it
> transitively depends on) from resolved params on demand (shapes aren't
> cached after meshing) and returns a `Blob`, which `App.tsx` saves via a
> throwaway `<a download>` element. All geometry is authored directly in
> millimetres (replicad/OCCT's own default unit), and STEP export declares
> `unit: "mm"` explicitly rather than relying on that default. `SolidsList`'s
> `isSolid` filter now matches `"primitive" | "boolean"`; broaden it again
> once extrude/revolve land.
>
> Also landed: pressing **Delete/Backspace** with a viewport selection removes
> it — a whole body or sketch for `feature`/`face`/`edge`/`vertex` picks, or
> just that one line/curve for a `sketchEntity` pick (and any constraints that
> referenced it). `sketchPoint`/`sketchFace` picks aren't deletable yet.

### Phase 8 — Polish & persistence
- IndexedDB save/load, document thumbnails, autosave.
- Measurement tools, section view, appearance, keyboard shortcuts.
- Performance: incremental regen (only re-run dirty features), tessellation LOD.

> Suggested first deliverable ("v0.1, genuinely usable"): **Phases 0–4** — sketch
> a constrained profile, extrude/cut it, chamfer an edge, and **export a STEP/STL
> file**, with variables and a working timeline. That validates every hard layer
> end to end.

---

## 5. UX/UX principles (to feel like Onshape/Fusion)

- **Direct manipulation + a tree.** Everything you do becomes a tree feature; the
  tree is editable history, not a log.
- **Context toolbar / mini-dialog** anchored near the selection, not buried menus.
- **Pre-select then act, or act then select** — support both (Onshape lets you
  pre-highlight edges then hit Fillet).
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
| **Topological naming** breaks references on edits | Use OCCT history maps + geometric fallback; store stable IDs; surface as fixable errors (Phase 4 focus). |
| OCCT WASM **bundle size / load time** | Lazy-load the worker; tree-shake via replicad; show a splash; cache the WASM. |
| **Regen performance** | Worker thread; dirty-feature incremental regen; cache tessellations; LOD. |
| **Constraint solver** robustness | Lean on planegcs rather than rolling your own; constrain the supported constraint set early. |
| Selource **license** mix (LGPL GCS, OCCT LGPL-with-exception) | Audit each dependency's license before committing to a project license. |
| Scope creep (this is a *lot*) | Ship Phases 0–3 as a real milestone before going wide. |

---

## 7. TL;DR

- **Engine:** `three.js` (render) + **`opencascade.js`** (B-rep kernel), behind
  **our own `Kernel` facade**; `replicad` is an accelerator/reference, not the
  core. **Not** OpenSCAD — it's mesh/CSG and can't give you selectable B-rep
  topology, clean fillets, or STEP export.
- **Constraints:** `planegcs`.
- **Architecture:** a document = an ordered **timeline of features**, each a pure
  function of params + references + variables; regeneration replays it.
- **Run the kernel in a Web Worker.**
- **Hardest problem:** topological naming — plan for it, don't be surprised by it.
- **First milestone:** Phases 0–3 (constrained sketch → extrude with variables &
  timeline).
