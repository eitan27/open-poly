# Open Poly — Architecture & Plan

A local-first, browser-based parametric CAD. This file holds the **decisions, the
gotchas, and what is not built yet**. It is not a changelog — git is the record of
what shipped when.

---

## Stack

| Layer       | Choice                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| Kernel      | OCCT via `opencascade.js`, accelerated by `replicad`, behind our facade |
| Render      | three.js (plain, not r3f — direct control of picking)                   |
| Constraints | `planegcs` (FreeCAD's GCS, WASM)                                        |
| UI          | React + TypeScript, Vite                                                |
| State       | `useState` + a custom `useHistory` (document is one immutable value)    |
| Storage     | IndexedDB directly (`src/storage/db.ts`), no Dexie                      |
| Concurrency | Kernel + solver in a Web Worker; transfer ArrayBuffers, don't copy      |

**Why a B-rep kernel:** faces/edges/vertices must be first-class selectable
topology — "click this face, fillet that edge" is the whole UX, and mesh/CSG
engines can't give it. OCCT is the only real open-source option.

**Kernel facade:** the app talks only to our `Kernel` interface; replicad and raw
`oc.*` never leak into app code. replicad is an accelerator and a teacher (memory
management, tessellation-with-face-groups), not the load-bearing core — it is
tuned for code-CAD, and topological naming needs OCCT history maps it doesn't
surface. Most of `worker.ts` is now raw `oc.*`.

> OCCT WASM objects are Emscripten-heap objects: every intermediate
> `TopoDS_Shape`/`gp_*` must be `.delete()`d or the heap leaks.

---

## Architecture

**Document = an ordered timeline of features.** Each feature is conceptually
`feature(params, references, variables) -> Shape(s)`. Regeneration replays the
list top to bottom, threading bodies forward; the rollback bar replays to _k_.

**The kernel folds over a running set of bodies** (`worker.ts` `buildBodies`): a
producer adds a body, an in-place modifier (extrude add/remove, chamfer, shell,
transform) rewrites one. **Body id = the id of the feature that created it**, and
in-place modifiers preserve it, so a body keeps its identity through edits.
Deliberately not decoupled into body records — a union should read "Union 1", not
"Box 1".

**Variables** are a document-level symbol table of named expressions, evaluated
topologically before features run. Any numeric parameter or dimension can be an
expression.

**Topological naming** is the genuinely hard problem. Three layers, all shipped:

1. OCCT construction history (`Modified`/`Generated`/`IsDeleted`) threads names
   through prisms, booleans, fillets.
2. Geometric fallback when a name is gone (`kernel/topoMatch.ts`): persistent name
   → suffix-stripped base name → fingerprint (faces: centroid + normal; edges:
   bbox-centre + length). Scale-relative thresholds, so a lost reference errors
   descriptively instead of silently grabbing the wrong face.
3. Every re-match or partial loss surfaces as a per-feature warning → amber ⚠ in
   the timeline. References are stable feature-scoped ids, never raw OCCT indices.

**Selection round-trip:** tessellation tags each triangle group with its face id
and each edge polyline with its edge id; a raycaster hit looks up the tag.

---

## What's left

Roughly ordered by how often a user meets them.

**Sketching**

- Cancel a sketch edit — edits apply live, no discard-on-Esc (needs
  snapshot-on-entry + restore).
- Constraints not mapped: concentric, symmetric, collinear, fix/lock.
- Splines pass through the solver unconstrained (only line / arc / circle map).
- Project: vertex projection is best-effort (re-projects a stored world point,
  doesn't track the source body); no agent op.

**Split (body)** — the largest unbuilt feature. Cut one body into two or more
**independent** parts with a plane, a planar face, or a sketch line/arc/spline;
unlike `boolean subtract` both pieces survive as separately colourable, hideable,
exportable Parts. ("Split Face" is a different op — not this.) Most of the
machinery is already on main because Boolean needed it: `splitPartsPass` /
`explodeToBodies` (`worker.ts`) explode a compound into one body per solid in a
deterministic order (descending volume, ties by bbox min-corner) with the
face-name map partitioned, fragment 0 keeping the feature's id and the rest
minting `<id>~<i>`; `doc.parts` gives per-fragment colour/name/hidden already.
Two kernel paths: a **plane or planar face** is two opposing `Common`s against
half-space boxes sized off `bboxDiagonal` (not a `Cut` — both sides then keep
history-based face naming, zero gap); a **sketch line reduces exactly to a plane**,
while an **arc or spline** does not and this wasm build has no
`BRepAlgoAPI_Splitter`, so facet the curve, inflate it to a ~5e-4 mm blade prismed
along the plane normal, and `Cut` — a sliver under 0.01 mm on a 40 mm part. **Guard
on `countSolids(result) < 2`, never on volume**: a `Cut` that misses the body leaves
it at full volume. Clone Mirror's dialog and its two-step arming; the agent op is
`addSplit` (the `add` prefix is what body producers use). Accepted gaps: an
orphaned fragment ref falls through to `requireBody`'s generic error rather than
`topoMatch`'s scored fallback, and there is no ghost preview.

**Codebase structure** — the two boundaries that were scoped and deliberately
not crossed. Both were looked at closely enough to know what stopped them, so
neither is a blind guess. Everything else structural, `App.tsx` and `App.css`
included, has since been done:

- **The Viewport mount effect.** ~2,100 lines built around ~40 refs and local
  three.js objects that the picking, highlighting and event handlers all close
  over directly. The module-level helpers have already been taken out around it
  (`geometryQuery`, `sceneMath`, `materials`, `viewCube`, −596 lines), leaving
  the effect itself alone on purpose: splitting it risks three.js lifecycle and
  ordering bugs — setup order, cleanup order, double-init — that only exhaustive
  interaction testing would catch. Wants the jsdom test setup pointed at the
  viewport first.
- **`kernel/features/`.** `buildBodies`'s dispatch is already split into one
  builder per feature type behind a `BuildContext`, but that left the ~30 shared geometry helpers
  (`prismFromFace`, `booleanNamed`, `dressUpNamed` and its ~700-line supporting
  cast, `revolveFromFace`, `sweepBody`, `loftBody`, `applyTrsf`) where they are:
  they are tightly coupled to each other and to the file's module-level OCCT
  state (`getOC()`, the font and regen caches). Moving the per-feature builders
  without that cluster trades one large file for fragile cross-file coupling.

**Kernel / geometry**

- Sphere booleans fail — `makeSphere` stays analytic (see Gotchas).
- True round holes/bosses. The blocker is the analytic `gp_Cyl`, not curvature, so
  building an extruded circle as a **B-spline** wall (pipe/sweep-style rather than a
  prism of an analytic circle) may be smooth _and_ booleanable, the way the swept
  tube already is. Not attempted. `BOOL_FUZZY` does not help — it is an algorithm
  failure, not a tolerance one. A newer OCCT would also solve it, but there is **no
  drop-in**: we are on the latest replicad (`0.23.1`, OCCT ~7.7–7.8) and 7.9.x means
  a custom `opencascade.js` build, with no certainty it helps — stock OCCT booleans
  cylinder−box fine, and so does this build _in isolation_.
- Tessellation LOD — no distance/zoom mesh simplification.

**Performance — two optimizations that measured well alone and badly together.**
The warning is the point; `shelved/viewport-geom-reuse-and-lazy-regen` is deleted.
**Opt A** stamps each mesh with its content hash (`ShapeMeshPayload.key`) and
reuses cached three.js geometry for unchanged bodies instead of rebuilding every
regen (isolated: ~1.5–8 ms CPU and 11–69 MB of GPU re-upload per unchanged body).
**Opt B** paints a document's cached mesh on boot and skips the initial regen.
Built together they made the UI feel slower. Settle both hypotheses before writing
either: **B probably backfires through a cold worker cache** — `meshCache` is keyed
by `b.key` and the on-load regen is what warms it, so skipping it means the first
edit after a reload re-tessellates an 80k-face import from scratch, at a far worse
moment; reload-then-edit is the common flow. **A only pays if `key` is stable
across regens** for unchanged bodies — check the hit rate first, `?perf` logs
`N rebuilt, M reused`, and if `M` is ~0 while editing a heavy document the key
churns and A is all cost. Measure end to end in the browser over those two flows,
not in isolation. For B, prefer warming the cache in the background without
blocking, or persisting the import's built body across reloads, over deferring.

**Features with obvious next increments**

- **Extrude:** taper/draft angle and thin/shell walls — `prismFromFace` builds a
  straight `MakePrism`, so both need new OCCT calls and new params; trim
  up-to-face to a non-planar surface rather than its plane; client-side
  face-eligibility check.
- **Transform:** arbitrary point+direction axis; a pivot that re-derives when the
  body changes upstream (baked at creation today).
- **Pattern:** per-instance skip, fuse-with-seed, multi-seed, body-edge
  directions, pattern-of-pattern; drag-to-set spacing in the viewport (both
  levels type it today); re-open a sketch pattern by clicking a generated
  entity (delete + redo today). Sketch patterns cover line/circle/arc/point —
  splines and text are excluded, matching mirror.
- **Planes:** hinge on a picked edge; line+point and two-parallel-edges methods.
- **Sweep/loft:** twist, multiple profiles, guide rails, ruled option.
- **Measure:** the info pane reads a selection; no pick-two measure tool.
- **STEP import:** drag-and-drop onto the viewport. Disjoint solids already split
  into parts, but unnamed — real part names need `STEPCAFControl_Reader`, which
  this wasm build does not expose, so that is a kernel rebuild before it is a
  feature.
- **Export:** image snapshot.

**Known rough edges**

- A failed autosave only `console.warn`s — no banner. Silent data loss if it ever
  happens (IndexedDB failures are rare: private mode, quota).
- Kernel builder/mesh caches evict on document switch, so A→B→A re-solves A.
  Fix: per-doc used-sets, or sweep on "used in the last K regens".
- Sketch inference **hysteresis** (snap stickiness) — the one deferred MVP item.
- **Two dialogs still arm a viewport pick from a `<select>`**: Extrude (Extent →
  "Up to face") and the reference-plane dialog (Method). See the arming gotcha.
- Parts are keyed by lump index, so an upstream edit that removes a lump slides
  the ones after it (colours/names shift by one).

**Agent — robustness**

- Token auth (the client sends one, the hub never checks it) and multi-tab
  handling (`wsHub` is last-connected-wins). Reconnection, timeouts, queue
  ordering and the error taxonomy are in.

---

## Open-sourcing — only the switch remains

- [ ] **Flip the repository to public.** The last step, and the only one left in
      Settings. The **About** panel is already filled in: `homepage` is
      <https://openpoly.dev>, nine topics are set (`cad`, `parametric-cad`,
      `opencascade`, `webassembly`, `threejs`, `3d-modeling`, `browser-based`,
      `constraint-solver`, `mcp`), and GPL-3.0 and the description were set before
      that. **Leave Pages disabled** — there is no landing page to publish, so
      enabling it would publish the repository root.

## What exists

**Sketching.** Datum planes + planar faces; line, rect (2-corner/center), circle
(center/3-pt), arc, polygon, spline, text. Construction geometry. Offset, mirror,
project ("use") and pattern as **associative `DerivedOp`s** — regenerated from
their sources, drawn purple, solver-excluded, non-constrainable. Inference guides
with snap capture. Trim/extend. Constraints: H/V, parallel, perpendicular, equal,
tangent, coincident, point-on-line, point-on-circle, midpoint; dimensions for
length, radius, diameter, angle, distance-between. Drawing auto-solves; the origin
is fixed ground; conflicting constraints are rejected with a named banner, never
saved dead.

**Solids.** Extrude (multi-profile, new/add/remove, blind/symmetric/through-all/
up-to-face/up-to-next), revolve, sweep, loft, shell, chamfer/fillet (multi-body),
boolean, transform (translate + rotate about any line + uniform scale), mirror,
linear/circular pattern, reference planes (offset/midplane/angle/3-points),
primitives.

**Model.** Multi-body parts, per-part colour/opacity/hide/isolate, selection
filters, section view, timeline with rollback drag, variables, undo with edit
coalescing.

**I/O.** STEP + STL export per part; STEP + DXF import; `.openpoly.json` document
files; multi-document workspace (dialog, thumbnails, BroadcastChannel multi-tab
warning).

**Offline.** A service worker (`src/sw.ts`, registered in `src/pwa.ts`, built by
vite-plugin-pwa's injectManifest) precaches the shell and both wasm modules, so the
hosted app opens and models offline after one visit, and installs as an app. Pages
are network-first (3 s timeout, never cached), so online loads always get the latest
deploy and the banner's Refresh is a plain reload; the cached copy is only the
offline fallback. A new worker takes over once installed, which is safe only while
the app has no lazily loaded chunks. Persistent storage is requested (not on
Firefox, which would prompt). Checked by `scripts/verify-pwa-offline.mjs`
(`REBUILD=1` for the update path) against a `vite preview` build or a preview URL.

**Agent.** Local stdio MCP server driving the live tab — see below.

---

## Gotchas

Things that cost real time to learn and are not obvious from the code.

**Kernel**

- **This OCCT wasm build cannot boolean an ANALYTIC primitive surface against a
  plane** (`gp_Cyl`, sphere) — `StdFail_NotDone`. Not curvature in general:
  B-spline swept surfaces boolean fine. So cylinders are faceted 48-gon prisms,
  curved body-face profiles are re-faceted before prisming, and revolve is a
  faceted ruled loft. **Spheres are the exception and still fail.** Confirmed by
  table: box−box and faceted-cylinder−box pass; primitive `gp_Cyl`−box, sphere−box
  and coaxial-cylinder subtract all throw; a B-spline swept solid − box passes. So
  it is the surface REPRESENTATION, not curvature. Making extrude smooth by passing
  the exact `segments` was tried and reverted: it turns the wall into a `gp_Cyl`,
  which is precisely the surface that cannot be cut. Re-verified by a spike in
  2026-07.
- **The failure only reproduces in the full pipeline.** The same booleans pass in
  isolation, in Node and in-browser. Never judge this by an isolated probe.
- Faceted bodies are **smoothed for display only** (`smoothMeshNormals` within a
  crease group + `filterSmoothEdges`); picking, measurement and booleans use the
  untouched faceted solid. `CREASE_DOT` ≈ 22°, `CIRCLE_FACETS` = 96.
- Extrude/revolve build faces from the **faceted polyline**; sweep/loft rebuild
  from **exact curve segments**, so a swept circle is a smooth tube.
- Up-to-face and up-to-next **conform** to the target: a long prism cut by an
  oriented half-space box at the face's plane. Planar targets only.
- A spline's drawn curve and its swept spine share one definition
  (`splineBeziers`), so the solid follows the drawing exactly.

**Interaction**

- **Never arm a viewport pick from a `<select>` option.** On macOS the popup is a
  native menu running its own event loop, and the first canvas click after it
  closes is swallowed — the pick appears to need two clicks, the first doing
  nothing. It reproduces **only in a real browser**: no automation, headless or
  headed, shows it, focused select or not. Transform, Pattern and Mirror arm from
  buttons for this reason.
- **A gizmo must stand down during a pick AND during sketch editing**
  (`tc.enabled = !picking && !activeFrame`). TransformControls' handles are
  invisible donuts and cones several times fatter than what they draw (the rotate
  picker is a full torus around the pivot), so a live gizmo covers the geometry
  the dialog just asked for and swallows the press into a zero-distance drag. The
  section gizmo had the pick half only, which made drawing in ANY sketch
  impossible while section view was on: it claimed the pointerdown, `dragging`
  went true, and every click after the first vanished with no error anywhere.
- **Section view clips per material, and picking must clip itself.** three.js
  clipping is a fragment-shader op the raycaster knows nothing about, so the pick
  path needs its own half-space test (`sectionAllows`) or a click into the
  opening selects the invisible back face. Planes are per-material, never global —
  global also slices the grid, datums, origin marker and view cube. "Off" parks
  the single `THREE.Plane` far away rather than emptying the array, so toggling
  cannot trigger a shader recompile.
- **One control per reference**, in two levels: a chooser for the KIND, revealing
  that kind's detail (X/Y/Z, or a `PickSlot`) — never both at once. Two controls
  that both say "axis" read as two independent choices.
- **Slots that share a click stream must never both be armed.** Extrude's profile
  and up-to-face slots both read the ordinary selection raycaster and `handlePick`
  checks the face first, so both armed meant the face silently ate every click.
- An **armed slot must not look filled** — `PickSlot` owns the three states
  (unarmed / arming / filled) precisely so they can't drift apart again.
- Highlight overlays copy world vertices **out of** body geometry, so anything
  posed by a matrix (a live gizmo drag) must have its overlays moved by the same
  matrix or they hang in the air.
- A **reflection reverses orientation**: a mirrored ghost needs its triangle
  winding flipped, or a double-sided material re-flips the correct normals and
  lights the body inside-out.
- Dialogs are **always enabled** and arm their own picks inside — never gated on a
  pre-selection. Double-click a timeline row to open a feature's one editor; edits
  preview live against a snapshot that Cancel restores.
- A fat `LineGeometry` **does not grow its instance count** via `setPositions` —
  rebuild it fresh when the point count changes, or only the first segment draws.
- Browsers reserve **Cmd/Ctrl+O**; a shortcut bound to it never fires.

**Patterns**

- **Count includes the seed** (6 ⇒ seed + 5 copies), matching Onshape/SolidWorks.
- **There is no radius input**, at either level: instances are rotations of the
  seed about the axis, so the radius is wherever the seed already sits. An
  explicit radius would have to move the seed, which no mainstream CAD does.
- A body circular pattern takes an **axis, not a center point** — a point alone
  doesn't orient a rotation in 3D. (A sketch pattern takes a point, because its
  plane supplies the rest.)
- A pattern feature produces **ONE body — a compound of the copies, seed left
  untouched** (delete it ⇒ back to the seed, like mirror). The pipeline assumes
  one body per feature id, so synthetic per-instance ids would leak everywhere.
  Each copy's names are suffixed `~p{i}` so downstream picks stay unambiguous.
- **Sketch and body patterns don't substitute for each other.** Repeating a CUT
  is a sketch pattern plus one extrude-remove (there is no "pattern this
  feature" here); repeating a filleted part is a body pattern. 40 holes as
  bodies would be 40 solids and 40 booleans.
- Both previews are **mesh clones** — a rigid motion needs no kernel round trip.

**Document / storage**

- **The document title lives on `StoredDoc`/`DocMeta`, not inside `Document`** —
  the parametric model stays pure geometry, and renaming can't be undone away.
- DB v2 splits `meta` from `documents` so the dialog and boot never deserialize
  every document's meshes. `activeDocId` is a localStorage pointer, not
  "most recent", so a refresh reopens the tab's own doc.
- **Undo is cleared on document switch**, by design: a document boundary is a
  history boundary.
- Validate a record **before** mutating any state — an `adoptRecord` that threw
  after moving `docIdRef` left the app pointing at a broken doc and the next
  autosave overwrote it.

**Build / test**

- **Typecheck with `npm run typecheck` (`tsc -b`), never a bare `tsc --noEmit`** —
  the root tsconfig has `files: []`, so a bare run checks nothing and "passes".
- **A large part of this app is unreachable from `npm test`** — `worker.ts`,
  `src/viewport/` and `App.tsx` have no unit coverage and cannot, so the
  `scripts/verify-*.mjs` Playwright checks are the only thing exercising them.
  They are not in CI and they are wall-clock sensitive: `scripts/README.md` has
  the whole story, and it is worth reading before trusting a red one.

---

## Agent — local MCP

**The stack below is shipped end to end; robustness is what's left — see
"What's left".**

```
LLM client ⟷ (stdio MCP) ⟷  bridge/MCP server (Node)  ⟷ (WebSocket) ⟷  browser tab
                              one process, two faces                    (command layer)
```

**Two layers, deliberately.** A vendor-neutral command + read API over the
document (`src/agent/`), and adapters on top. MCP is the first adapter; an in-app
chat agent or an OpenAI/Gemini function-calling adapter would reuse layer 1
unchanged.

- The **tab connects out** — a browser tab can't be listened to. The MCP server
  and the WS hub are one Node process (`mcp-server/`, port 7373).
- **Every mutation routes through `setDoc`**, so the user can Cmd-Z anything the
  agent did: the agent is just another input device.
- **A mutating op awaits the kernel regen** before resolving, so one follow-up
  read sees the result (no polling) and a failed build returns `kernel_error` for
  the agent to self-correct.
- **Serial request queue** — React state is async, so op _N+1_ must observe _N_.
- **References are stable ids from a read**: feature ids, persistent face/edge
  names, plane refs, deterministic region ids. Conventions are **mm, Z-up**,
  stated in every tool description.
- MCP tool input schemas are **derived from the shared zod `Operation` schemas**,
  so the contract can't drift. Tool names are snake_case ↔ camelCase
  discriminators, mapped in `tools.ts`.
- All server logging on **stderr** — stdout is the JSON-RPC channel.
- `src/agent/modeling-guide.md` is the agent's playbook, shipped as an MCP
  prompt + resource + tool, version-controlled with the tools.
- `report_issue` turns the agent into a feedback generator: when blocked it files
  a structured issue instead of faking geometry.
- **No `deleteDocument` op** — destructive, low value; the guide says ask the human.
- **Project has no agent op**: its persistent-edge-name capture + post-rebuild
  reprojection loop doesn't map onto a one-shot document op.

**Stretch:** remote Streamable-HTTP MCP + session pairing (hosted chat UIs); an
in-app chat agent; OpenAI/Gemini adapters.

---

## UX principles

- Everything becomes a tree feature; the tree is **editable history**, not a log.
- Mini-dialogs anchored near the work, not buried menus.
- A dialog **or** a viewport banner, never both — the banner is only for the two
  picks with nothing to configure yet (starting a sketch, the section plane).
- A dialog owns the screen: the whole modelling toolbar is inert until it is
  finished or cancelled.
- **One** Esc leaves any dialog or banner. To stop a slot listening without
  leaving, click the slot.
- A picker label is an instruction, so it wraps — never an ellipsis.
- Pre-select then act, **or** act then select — support both.
- Live ghost preview before commit; constraint state by colour (blue under, green
  fully, red over).
- Normal-to camera on sketch entry; hover-highlight everything selectable.
- Non-blocking regen with a subtle status.
