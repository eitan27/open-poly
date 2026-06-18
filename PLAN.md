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
> ⧉ Plane button creates a parametric offset plane you can sketch on. Likely
> next high-value items: more plane methods (midplane/angle/through), a
> multi-document manager (Documents list + import/export), Transform (move/
> rotate, Phase 5.5), Mirror, or Revolve (Phase 6).

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

### Phase 2 — Sketching (geometry first, then constraints) — *core ✅ DONE; some tools below are follow-ons*
- **2.0 — Navigation & datums prep** — ✅ DONE: clickable/snappable **origin
  point**; the three datum **planes (Top/Front/Right)** rendered faintly,
  hover/click-selectable (selecting one starts a sketch); **standard view
  navigation** (Front/Back/Left/Right/Top/Bottom/Iso). (A true interactive
  ViewCube is still a later nicety.)
- **2a:** ✅ mostly done — pick a plane/planar face → sketch mode (camera
  normal-to); draw **line, rectangle (2-corner + center), circle (center +
  3-pt), arc (3-pt), regular polygon**; snapping (endpoints/midpoints/origin/
  coplanar edges); delete. **TODO:**
  - **Splines** (control-point / through-point curves).
  - **Construction toggle** — mark any sketch entity as *construction*
    (reference geometry: used for dimensions/constraints/snapping but ignored
    when detecting profile regions and never extruded). A toolbar toggle while
    drawing, plus a per-entity flag editable after.
  - Trim/extend.
- **2b:** ✅ constraints via **`planegcs`** (auto H/V capture, ⛓ Solve, fully-
  constrained→green) + **interactive length dimension** (press D, accepts
  number/expr/variable). **TODO (catalogued below):** radius/angle/p2p
  dimensions, on-canvas dimension labels + edit, and a manual-constraint UI
  (coincident/tangent/equal/parallel/perp).
- **Exit criteria** (a fully-constrained closed profile that updates when a
  driving variable changes): met.

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
    *(One profile at a time; multi-profile in one extrude is TODO.)*
  - **Result mode** (in the dialog): ✅ **New** / **Add** (join) / **Remove**
    (cut). Add/Remove require choosing an explicit **target body** in the dialog.
  - **Direction:** ✅ flip toggle. *(Symmetric/two-sided: TODO.)*
  - **End condition:** ✅ **Blind** (expression-backed distance). *(Up-to-face /
    up-to-next / through-all: TODO.)*
  - **Dialog:** ✅ anchored mini-dialog (mode + target + distance + flip).
    *(Live ghost preview: TODO — deferred; editable features give most of it.)*
- **Chamfer + Fillet** — ✅ DONE: edge dress-up via `BRepFilletAPI`, edges
  referenced by **persistent name**. *(Chamfer two-distance/angle variants:
  TODO; currently single distance / single radius.)*
- **Topological naming** — ✅ DONE (the real version, via OCCT history; see the
  phase intro above). *(Gap: curved faces / cylinder sides aren't named yet →
  centroid fallback.)*
- **Selection round-trip** (sketch region / body face / body edge → kernel →
  meshed body back) — ✅ exercised end to end.

### Phase 4 — Export (validate end-to-end) — ✅ DONE
- **Export STL** (mesh) and **STEP** (B-rep, declared in mm) per part, from the
  Parts panel. `Kernel.exportBody` replays the fold and serialises the chosen
  result body. Image snapshot + STEP **import** still TODO.

### Phase 5 — Boolean + Reference planes + Pattern + Mirror *(Boolean + offset planes ✅; rest TODO)*
- Boolean between separate bodies: union / subtract / intersect — **done**
  (`BooleanFeature`, dialog, volume-verdict validation, name propagation).
- **Reference / construction planes (create plane).** A parametric `PlaneFeature`
  placed via the **⧉ Plane** toolbar button (right of New Body) → a pick flow
  (select a plane/face to base it on) → a dialog. Methods:
  - **Offset** — parallel to a base datum / face / earlier plane, by a (signed,
    expression-backed) distance. **✅ DONE.** `resolvePlanes()` derives the
    frame (`frameOf(base)` translated along its normal, in timeline order so a
    plane can sit on an earlier plane); `SketchPlaneRef` gained a
    `{kind:"plane"}` variant; planes render as translucent amber quads and are
    **selectable for sketching** (offset is editable → re-derives on change).
  - **Midplane** — halfway between two references (face↔plane, face↔face, or
    plane↔plane). **TODO.**
  - **At an angle** — rotated by an angle about an edge/axis, relative to a
    face or plane. **TODO.**
  - **Through geometry** — 3 points, a line + a point, two parallel edges, etc.
    **TODO.**
  Still TODO for planes overall: show them in the **datums list** (today they're
  only in the timeline + viewport) and use them as a **mirror** plane.
- Linear pattern (1- and 2-direction), circular pattern (axis + count + angle).
- Mirror across a plane/planar face (incl. a reference plane above).
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

### Phase 7 — Multi-body, parts, selection UX *(mostly DONE; isolate / filters TODO)*
- Multiple bodies/parts in one document — ✅. A **Parts** panel
  (`ui/SolidsList.tsx`) lists every rendered body (primitive / extrude / boolean)
  with select, rename, delete, colour, opacity slider, a **per-part show/hide
  eye toggle** (`hidden` flag → body dropped from the rendered meshes), and
  STEP/STL export. Colour/opacity/hidden are overlaid onto cached geometry in
  `App.tsx` (instant, no regen). **Delete/Backspace** removes a body or sketch
  (or a single sketch line). Suppress (timeline) uses a distinct no-entry icon
  for non-sketch features, separate from hide.
- Robust selection (faces, edges, bodies; hover highlight) — ✅.
- **TODO:** **isolate** (show only this body, hide the rest) and **selection
  filters** (restrict picking to faces / edges / bodies only).

### Phase 8 — Polish & persistence
- **IndexedDB autosave + restore — ✅ DONE.** `src/storage/db.ts` wraps
  IndexedDB (object store keyed by document id, structured-clone of the plain
  `Document`); the app restores the most-recent doc on load and debounced-
  autosaves on change (autosave waits for the initial load). A refresh no longer
  loses work.
- **Multi-document manager (TODO — builds directly on `db.ts`).** A **Documents
  list / file menu**: new, open, rename, duplicate, and delete documents (the
  store is already keyed by id and `listDocs()` exists). Track the active
  document id (e.g. in localStorage) instead of "most recent." Add **import /
  export as `.json`** for portability/sharing, and per-document **thumbnails**
  (render a snapshot Blob into the record). This is the next persistence step
  that turns "one autosaved sketchpad" into a real multi-file workspace.
- Measurement tools, section view, appearance, keyboard shortcuts.
- Performance: incremental regen (only re-run dirty features), tessellation LOD.

> First deliverable ("v0.1, genuinely usable") — **✅ reached.** Phases 0–4 plus
> Boolean: sketch a constrained profile, extrude/cut it, chamfer/fillet an edge,
> boolean bodies, recolor/hide parts, **export a STEP/STL file**, and it all
> **autosaves** — with variables and a working timeline. Validates every hard
> layer end to end.

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
  core. A real B-rep kernel is required for selectable face/edge topology, clean
  fillets, and STEP export.
- **Constraints:** `planegcs`.
- **Architecture:** a document = an ordered **timeline of features**, each a pure
  function of params + references + variables; regeneration replays it.
- **Run the kernel in a Web Worker.**
- **Hardest problem:** topological naming — plan for it, don't be surprised by it.
- **First milestone:** Phases 0–3 (constrained sketch → extrude with variables &
  timeline).
