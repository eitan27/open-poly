# Open Poly — Architecture & Plan

A local-first, browser-based parametric CAD. This file holds the **decisions, the
gotchas, and what is not built yet**. It is not a changelog — git is the record of
what shipped when, and `docs/BACKLOG.md` holds the long-form investigations.

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

**Kernel / geometry**

- Sphere booleans fail — `makeSphere` stays analytic (see Gotchas).
- True round holes/bosses — a B-spline wall (pipe-style) may be smooth _and_
  booleanable; see BACKLOG for the spike that confirmed faceting is required today.
- Tessellation LOD — no distance/zoom mesh simplification.

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
- **Split (body):** cut a body into independent parts with a plane or a sketch
  curve. Built and tested on a branch, never merged — see BACKLOG.
- **STEP import:** drag-and-drop onto the viewport. Disjoint solids already split
  into parts; their **names** are shelved on `feat/step-assembly-split`, blocked
  on a wasm build with XCAF.
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

**Agent — L4**

- Token auth (the client sends one, the hub never checks it) and multi-tab
  handling (`wsHub` is last-connected-wins). Reconnection, timeouts, queue
  ordering and the error taxonomy are in.

**Housekeeping**

- Landing-page auto-deploy disabled (private repo on the Free plan) —
  `.github/workflows/pages.yml` has its `push` trigger commented out.
- Shelved perf work (viewport geometry reuse + lazy regen) — see BACKLOG.

---

## Open-sourcing (active work — resume here)

The repo is going public. This section is the resumable state of that push:
read it, check the marker, pick up the next unticked item. Delete the section
once every wave is done.

**Marker — 2026-09-14.** Waves A and B are COMPLETE. `main` is at `951a8d3`
(Wave A, pushed); Wave B is four commits on `chore/test-infrastructure`, not yet
merged. Next: Wave C — `usePersistedDocuments`, which B.3 exists to make
testable.

**Done**

- [x] Only the public sites phone home; dead links go somewhere (`e7aa92f`).
- [x] Turnstile token sent with every bug report (`e9edcd4`). `TURNSTILE_SECRET`
      is set on the Pages project, and one real report has been filed against
      production with the Function accepting the token — the check can stay on.
- [x] Docs consolidated — PLAN cut 1679→330, EXTRUDE_IMPROVEMENTS and
      PATTERNS_PLAN folded in and deleted, cad-feature-comparison deleted, the
      Split design rescued into BACKLOG (`8b0c514`).
- [x] **A.1** Keyboard shortcuts declared once, collisions caught by a test
      (`52ed65a`). `KEYBOARD_SHORTCUTS.md` deleted — `src/settings/shortcuts.ts`
      is now the single source.
- [x] **A.2** Third-party licence notices generated into
      `dist/third-party-licenses.txt` at build time (`f967630`). MIT and the
      rest require the notice to travel with the copy, and minification strips
      it; the repo is not a copy the visitor receives.
- [x] **A.3** Eleven pure helpers out of App.tsx, and 66 tests over them
      (`refactor/app-pure-helpers`). Five to `src/geom/meshQuery.ts`
      (bodyCenter, transformMeshPayload, reverseWinding, reflectionMappers,
      rotationMappers), six to a new `src/sketch/sketchGeom.ts`. App.tsx
      10537 → 10295, so −242; the branch's own tests were re-checked against
      main before being trusted (`flipWinding` and the `text` entity are both
      newer than the branch). `planeKeyToRef` stays at module scope on purpose —
      see the comment on it. What is left in that band is UI labelling and DOM
      (`mirrorPlaneLabel`, `downloadBlob`, `safeFilename`); the pure-helper seam
      in App.tsx is now genuinely exhausted.
- [x] **A.4** `src/kernel/cache.ts` extracted with 16 tests, and `buildBodies`'s
      542-line if/else chain split into one named builder per feature type
      behind a switch, sharing an explicit `BuildContext`
      (`refactor/kernel-cache-split`). worker.ts 5385 → 5460, so **+75** — the
      split adds 12 signatures and a switch while removing only the 19 cache
      lines. The win is that `buildBodies` itself went 582 → 80 lines and each
      feature type is now separately readable; it is not a line count.
      The branch's stale `contentKey` was real and was avoided: its
      `buildTransformFeature` keys on `[target.key]` alone, where main resolves
      a body-EDGE axis and folds that body's key in too. 11 of the 12 extracted
      bodies are byte-identical to the originals (the 12th differs only where
      prettier rejoined a line that fits at the shallower indent), and no branch
      contained a `return`/`continue` that would change meaning inside a
      function. worker.ts still has no unit coverage — Vitest cannot load the
      OCCT wasm — so all 12 types were built through the live app instead, by
      `scripts/verify-build-bodies.mjs`, which is kept: it is the only thing
      that exercises this file at all.
- [x] **A.5** Four modules out of Viewport.tsx — `geometryQuery.ts`,
      `sceneMath.ts`, `materials.ts`, `viewCube.ts` — with 46 tests, where
      `gizmoShape` was previously the only tested thing in `src/viewport`
      (`refactor/viewport-modules`). Viewport.tsx 5294 → 4698, so **−596**.
      The branch's `sceneMath` tests were a total loss and were rewritten:
      `closestLineParamToRay` no longer exists (the section handle drags a
      TransformControls proxy now), and `transformMatrix` grew an axis-LINE
      argument and a scale, so every one of its old calls was against a dead
      signature. The new tests cover what the drift added — rotating about an
      edge metres from the pivot, scaling about the pivot, and the T·R·S order.
      `vitest.config.ts` gained one alias: `replicad-threejs-helper` ships
      `main` (UMD) and `module` (ESM) but no `exports` map, so vitest's node
      resolver loaded the UMD file as ESM and got an EMPTY namespace — every
      named import undefined at call time, not import time. Pointing node at
      the same ESM build the app uses made `syncBodyGeometry` testable.
      `viewCube.ts` has no unit tests on purpose (its textures need a DOM
      canvas); it and the picking integration are covered by
      `scripts/verify-viewport-modules.mjs`, kept alongside A.4's.

**Also owed, outside the waves**

- [ ] Re-enable the landing-page auto-deploy once the repo is public — its
      `push` trigger is commented out in `.github/workflows/pages.yml` because
      GitHub Pages from a private repo needs a paid plan.

**Wave A — harvest. DONE.** All five waves were re-applied against main rather
than rebased or cherry-picked, and that was the right call every time: the
branches were 4–6 weeks stale and two of them carried bugs into the present —
A.4's `contentKey` had lost a dependency, and A.5's `sceneMath` tests were
written against two signatures that no longer exist. The three branches these
harvested — `app-tsx-decompose`, `kernel-buildbodies-split`,
`viewport-mount-effect-split` — can be deleted once this lands.
`origin/claude/use-persisted-documents-hook` must NOT be: Wave C still wants it.

**Wave B — test infrastructure. DONE.**

- [x] **B.1** `scripts/lib/harness.mjs` — the launch / waitIdle / apply / read /
      check block that 62 of the 65 `verify-*.mjs` scripts each re-declared. They
      had drifted: the poll loop ran 60–300 iterations at 200ms or 300ms, and
      about a third treated "error" as NOT settled, so a failed regen spun the
      whole timeout and the script then asserted against a state it never waited
      for. The harness settles on error and returns the status text. Four scripts
      are migrated (−94 lines) and produce byte-identical results; it is
      deliberately à la carte — `verify-extrude-guards.mjs` keeps its own tally
      and takes only the bridge and the waits.
- [x] **B.2** 48 of the 67 scripts use the harness (−741 lines). The 19 that do
      not are left on purpose: four have no launch block at all, and fifteen still
      hold `browser`/`context` themselves (a second tab, their own screenshot
      context), which the migration refuses rather than guesses at.
      **How it was verified, because it was wrong twice first.** A before/after
      run of all 67 is the only real check, and two things made it lie: the first
      runner used `timeout`, which macOS does not ship, so every script "produced
      no checks"; and the first comparison ran while `npm test` competed for CPU,
      which moved results for scripts that had not been touched at all. The fix
      for the second is the reusable one — the unmigrated scripts are a CONTROL
      GROUP, and if a file nobody edited changes its answer the run is noise.
      Final: 19/19 controls identical, 48/48 migrated identical.
      The first transformer also matched the launch block with `.*?` and ate
      script-specific lines inside it — a `const FILE`, a console listener
      collecting mesh warnings. Two scripts died loudly; a script that merely LOST
      a listener would have kept passing while testing less, which is why all 46
      were reverted rather than the 8 visible breakages patched. The rewrite
      classifies each line and keeps anything it does not recognise.
- [x] **B.3** jsdom + `@testing-library/react`, with 26 tests over `useHistory`
      (incl. the coalescing rules deciding whether three keystrokes are one undo
      step) and `useSettings`. Done as a per-file `// @vitest-environment jsdom`
      docblock, NOT a global flip: `environment: "node"` is untouched, so
      `vitest.config.ts` needed no change and the 813 pre-Wave-A tests run
      exactly as before. jsdom costs ~700ms of setup per file that asks for it,
      which is reason enough not to charge it to tests that never needed a DOM.
      `src/test/webStorage.ts` exists because vitest's jsdom globals drop the
      real `Storage`: jsdom's own localStorage round-trips fine when constructed
      directly, but arrives in the test as a bare `{}` and the first `getItem`
      throws. A test that needs storage calls `installWebStorage()` and can see
      what it runs against. jsdom is pinned to `^26` — `^29` behaves identically
      here, so this is not a fix, just the better-trodden major.
- [x] **B.4** All ten failing `verify-*.mjs` scripts are green, and the audit
      found one real bug. **Nine were stale**, each against a deliberate change
      the script was never updated for: the transform gizmo's "Axis" became
      "Along" (`e7364ba`, rotate about any line); the toolbar's "…"/"More▸"
      overflow became a magnifier (`c0cc51d`); a fourth sketch tool group
      (trim/extend) joined rectangle/circle/pattern; circle dimensions default to
      DIAMETER, so a typed 35 means r=17.5; and a chained corner now records its
      own `coincident` joint, which broke a constraint-COUNT assertion — rewritten
      to assert the specific constraint disappeared, which is what it meant.
      `verify-loft-hollow.mjs` had `/opt/pw-browsers/chromium` hard-coded and had
      never run anywhere else; it passes 11/11 now.
      `verify-face-diameter` expected a revolved tube to be true cylinders with
      annular caps. It is faceted like everything round (`geom/circleFacets.ts` —
      this OCCT build cannot boolean an analytic cylinder against a plane), so
      there is no circular wire to classify: 384 faces, no analytic diameter. The
      checks now assert what is true and name the gap, which is recorded in
      BACKLOG under the faceting section (where the extrude-only workaround it
      is missing already lives).
      **The real bug: with section view on, you could not draw in a sketch at
      all.** Any sketch, datum or face; every click after the first. The section
      plane's drag gizmo is a TransformControls, and it claimed the pointerdown,
      setting `dragging` — so `onDown` returned before setting `down`, and `onUp`
      bailed at `if (!down)`. The click was swallowed with no error anywhere.
      Picking mode already had exactly this opt-out; sketch editing needed the
      same one, and now has it (`sectionControls.enabled` also requires
      `!activeFrameRef.current`). Dragging the section plane outside a sketch is
      unaffected — verified by sweeping for the handle and moving the offset.

**Wave C — boundaries (resume here).** `claude/use-persisted-documents-hook` (`4ba9d64`, a
483-line hook, −418 from App.tsx) was Wave A until it became clear it is
stateful — IndexedDB, recovery banners, corrupted-document paths — so no pure
test can cover it. It needs B first. Then the Viewport mount effect, and
`kernel/features/`.

**Why the plan looks like this.** A branch audit killed the original "split the
three big files" idea. Since 2026-07-31 App.tsx went 7900→10537, worker.ts
3754→5385, Viewport.tsx 4246→5294 — the files grow faster than extraction
shrinks them, and branch 1 found only 295 extractable lines in 7900 (3.7%). The
pure-helper seam is nearly exhausted. What is left after Wave A is not more
extraction but real boundaries, which need tests, which need Wave B.

---

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

**Agent.** Local stdio MCP server driving the live tab — see below.

---

## Gotchas

Things that cost real time to learn and are not obvious from the code.

**Kernel**

- **This OCCT wasm build cannot boolean an ANALYTIC primitive surface against a
  plane** (`gp_Cyl`, sphere) — `StdFail_NotDone`. Not curvature in general:
  B-spline swept surfaces boolean fine. So cylinders are faceted 48-gon prisms,
  curved body-face profiles are re-faceted before prisming, and revolve is a
  faceted ruled loft. **Spheres are the exception and still fail.** Re-verified by
  a spike in 2026-07; full account in BACKLOG.
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
- **A gizmo must stand down during a pick** (`tc.enabled = !picking`).
  TransformControls' handles are invisible donuts and cones several times fatter
  than what they draw (the rotate picker is a full torus around the pivot), so a
  live gizmo covers the geometry the dialog just asked for and swallows the press
  into a zero-distance drag.
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
- Parts: the first lump keeps the producing feature's id, later lumps take
  `<id>#1`, `<id>#2`. Chosen so nothing needed migrating.

**Build / test**

- **Typecheck with `npm run typecheck` (`tsc -b`), never a bare `tsc --noEmit`** —
  the root tsconfig has `files: []`, so a bare run checks nothing and "passes".
- `scripts/verify-*.mjs` are ad-hoc Playwright checks against a local `npm run
dev`; they are not part of CI. Most hardcode a cloud `executablePath` — pass
  `CHROMIUM_PATH`.

---

## Agent (Phase 9) — local MCP

**L0–L3 shipped; L4 (robustness) is what's left.**

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
- Pre-select then act, **or** act then select — support both.
- Live ghost preview before commit; constraint state by colour (blue under, green
  fully, red over).
- Normal-to camera on sketch entry; hover-highlight everything selectable.
- Non-blocking regen with a subtle status.

---

## Risks

| Risk                                             | Status                                                                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Topological naming**                           | ✅ Mitigated — history + geometric fallback + warning surfacing. Residual: fingerprints go stale if geometry moves far AND names churn at once. |
| **Regen performance**                            | ✅ Worker, debounce, content-hash caching. LOD not built — not yet a bottleneck.                                                                |
| OCCT WASM size/load                              | Lazy-load the worker, cache the WASM.                                                                                                           |
| Constraint solver                                | Lean on planegcs; keep the supported set bounded.                                                                                               |
| License mix (LGPL GCS, OCCT LGPL-with-exception) | Audit before settling the project license.                                                                                                      |
