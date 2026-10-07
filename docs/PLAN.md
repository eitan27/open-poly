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

**Codebase structure** — the two boundaries that were scoped and deliberately
not crossed. Both were looked at closely enough to know what stopped them, so
neither is a blind guess. Everything else structural, including `App.tsx` itself, is tracked
as a checklist under **Code hygiene** below:

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

**Agent — robustness**

- Token auth (the client sends one, the hub never checks it) and multi-tab
  handling (`wsHub` is last-connected-wins). Reconnection, timeouts, queue
  ordering and the error taxonomy are in.

**Housekeeping**

- Landing-page auto-deploy disabled (private repo on the Free plan) —
  `.github/workflows/pages.yml` has its `push` trigger commented out.

---

## Open-sourcing — the blocker is cleared; only the switch remains

Harvesting the old branches, building the test infrastructure and crossing the
first real module boundary are all done, on `main` and deployed. The per-item
state that used to live here is in the git history; what remains is the
going-public checklist, what must not be undone afterwards, and the things the
push cost enough to learn.

**Going public — in order.**

- [x] **1. The `refs/pull/*` purge is done and verified (2026-09-17).** The
      history was rewritten on 2026-09-14 to map two personal email addresses to
      `3627572+eitan27@users.noreply.github.com` across 417 commits, and
      force-pushed. Branches went clean immediately, but GitHub's `refs/pull/*`
      are read-only server-side refs a force-push cannot reach, and all 10 still
      carried the old addresses. GitHub Support deleted all ten pull requests
      (1–9, 12) and cleared their references; issues #10, #11, #13 and #14 were
      never in scope and are untouched. Verified independently rather than on
      their word, and the second check is the one that counts — refs vanishing
      from the listing would not prove the objects were gone:
      `git ls-remote origin 'refs/pull/*'` (10 before, 0 now), and
      `git fetch --depth=1 origin <old-sha>` for four old SHAs including the
      pre-rewrite `main` tip, the commit carrying the alooma address, and the
      head of closed PR #5 — all unreachable. No branch, tag, release or
      surviving issue mentions either address. Cosmetic side effect: the 8
      `Merge pull request #N` messages in `main` now link to deleted PRs.
- [ ] **2. Flip the repository to public.**
- [ ] **3. Settings → Pages → Build and deployment → Source → "GitHub
      Actions".** This also clears a standing red X:
      `.github/workflows/pages.yml` fires on every push touching `landing/**`
      (re-enabled in `b0578bd`) and has failed on every run since June, because
      Pages cannot publish from a private repo on the Free plan. Nothing is
      broken and nothing is being published — going public plus this setting
      resolves it, with no code change.
- [ ] **4. Sanity-check the deployed site.** <https://open-poly.pages.dev> is a
      direct `wrangler pages deploy` upload, NOT git-integrated, so going public
      redeploys nothing. File one real bug report to confirm the `/api/report`
      Function still reaches a now-public repo.
- [ ] **5. Then, and only then, delete the backups** in `~/Developer/`:
      `open-poly-mirror`, `open-poly-backup`, and `open-poly-local-mirror.git`.
      The last holds pre-rewrite copies of everything, including the one
      never-pushed branch still worth keeping — `feat/step-assembly-split`,
      which is also in the working tree. (`shelved/viewport-geom-reuse-and-lazy-regen`
      and the `archive/split-body` tag were deleted on 2026-10-06; both are
      written up in BACKLOG in enough detail to rebuild from, so the mirror's
      stale copies of them are not a reason to keep it.)

**Do not undo these.** `user.email` is the GitHub noreply address in
`~/.gitconfig`, and _Settings → Emails → Block command line pushes that expose my
email_ is on. The setting is the durable half: it rejects a push carrying a real
address rather than letting it land. Collaborators must **re-clone, not pull** —
a merge from a pre-rewrite clone pushes the old addresses straight back in, which
is the one way this work can be undone.

**What it taught us, in order of how much it cost to find out:**

- **Re-apply a stale branch; never rebase or cherry-pick it.** Five month-old
  `claude/*` branches were harvested and every one was re-done against main
  instead. Two of them would have shipped bugs into the present: one's
  `contentKey` had lost a dependency (a transform rotating about a body edge
  would have served a stale body, silently), and another's tests were written
  against two signatures that no longer existed. A stale branch is worth reading
  for its idea and for the bug it is carrying.
- **When a before/after run is your only proof, keep a control group.** The
  `verify-*.mjs` migration was "verified" twice before it was verified once: the first runner used `timeout`, which macOS does not ship, so every
  script reported nothing; the second ran while `npm test` competed for the CPU,
  and scripts nobody had touched changed their answers. The fix that stuck: the
  UNMIGRATED scripts are the control. If a file nobody edited moves, the run is
  noise and nothing it says counts.
- **A codemod that deletes a span will eat something you did not see.** The
  first transformer matched a launch block with `.*?` and swallowed the
  script-specific lines inside it — a fixture path, a console listener. Two
  scripts died loudly; the dangerous case is the one that keeps passing while
  testing less. Classify each line and keep what you do not recognise.
- **Opt in to jsdom per file, never globally.** `environment: "node"` is still
  the default and the ~800 tests that predate the jsdom work never had to move.
  A file
  that needs a DOM says `// @vitest-environment jsdom`; jsdom costs ~700ms of
  setup per file that asks.
- **Agent worktrees live inside the repo.** `.claude/` now has to be ignored by
  git, vitest, eslint AND prettier — each learned separately, the last two
  because a running agent doubled the lint count and it read as a regression.

**What it produced, beyond the code:** `scripts/lib/harness.mjs` (the launch /
waitIdle / apply / read block 48 of the 67 verify scripts share),
`scripts/verify-build-bodies.mjs` and `scripts/verify-viewport-modules.mjs` (the
only coverage `worker.ts` and the viewport have, since Vitest can load neither
the OCCT wasm nor a WebGL context), and `scripts/verify-dialog-consistency.mjs`.

---

## Code hygiene — the contributor-facing checklist

A deep structural scan (2026-10-02) against one question: can a stranger
navigate, maintain and extend this? Mostly yes. CI gates lint, format,
typecheck, 999 tests and a build on every PR; `strict` is on with
`noUnusedLocals` and `noFallthroughCasesInSwitch`; the layer graph is acyclic;
the comments are overwhelmingly _why_-comments and are an asset — **do not
bulk-trim them.**

What is wrong is concentrated, not diffuse: four files hold 46% of the code. The
two hardest boundaries (the Viewport mount effect, `kernel/features/`) are
already scoped with their rationale under **What's left → Codebase structure** and are
_not_ repeated here; this section is the rest.

**Tier 1 — structure.** The actual answer to "is this maintainable".

- [ ] **1. `src/App.tsx` is 9,896 lines in one component.** 84 `useState`;
      61 hook blocks totalling 1,245 lines (the largest, the global keydown
      handler, is 295 at `3884-4178`); ~5,300 lines of handlers and derived
      values declared inline across 372 bindings; and a single 2,601-line JSX
      return at `7295-9896`. **17 of the repo's 20 `eslint-disable` comments are
      `react-hooks/exhaustive-deps` in this file** — that is the dependency
      graph having outgrown hand-verification, and it is the reason to treat
      this as correctness work rather than tidying. `CONTRIBUTING.md`'s layout
      table already concedes "oversized and mid-refactor", which reads as an
      unfinished job to anyone arriving. Four independently shippable steps:
  - [ ] **1a.** Extract the JSX tail. `BooleanDialog`, `SettingsDialog`,
        `DocumentsDialog` and `ReportDialog` are the pattern to copy: resolved
        labels and flags in, granular callbacks out, neither a setter nor `doc`
        crossing the boundary. **Twelve done — everything except Pattern —
        taking App.tsx 9,891 → 9,050.** Note 1a does **not** reach 7,000 on its
        own: twelve dialogs were worth ~840 lines, so the rest of item 1's total
        has to come from 1b–1d.
  - [ ] **1b.** Move each dialog's state machine behind its own hook
        (`useExtrudeDialog`, `useDressUpDialog`, `useShellDialog`,
        `useTransformSession`) — each owns 3-8 `useState` plus its effects today.
        **`useRevolveDialog` is done and the item's premise holds**: it carries no
        `exhaustive-deps` disable and App.tsx went 17 → 16. Both of Revolve's
        disables were hiding something real — the live-edit effect must depend on
        the dialog's six _value_ fields and not on `x`/`y`/`armed`, or dragging the
        panel re-applies the edit and adds an undo entry; the ghost effect was
        silenced only for a closure that turned out to be pure and belonged at
        module scope. Two supporting moves generalise: make the shared
        `shouldLiveApply` guard a `useCallback` (it touches only refs), and keep
        "where does the panel go" out of the hook — pass an `at: {x, y}`, since
        anchoring to the clicked geometry needs the camera, which is the shell's
        business. Expect ~13 explicit dependencies per hook. That is not a smell to
        design away: every one was already an implicit coupling, and writing it
        down is the deliverable.
  - [ ] **1c.** Collapse the sketch-session cluster. `offsetSession`,
        `mirrorSession`, `projectSession`, `patternSession` and `textDraft`
        each carry the same shape — state, a mirroring `*Ref`, a `commit*Ref` —
        five times over. One `useSketchSession` abstraction.
  - [ ] **1d.** Move the 295-line keydown effect to
        `settings/useShortcutHandler.ts`, next to the `shortcuts.ts` table it
        dispatches from.
- [ ] **2. `src/App.css` is 3,235 lines / 392 rules** styling components that
      already live in `src/ui/`. It is cleanly sectioned by comment, so split
      along the same seams as 1a and let a dialog's styles sit beside the
      dialog. Move the token block at the head of `index.css` into its own file
      so theming is findable.

**Which dialog to extract next, and why not by feature family.** The predictor
that works is whether a block's JSX _reads_ state or _drives_ it, measured by
counting `setPicking`/`setPickPurpose` calls and closures defined before the
`return`. Measured, not guessed: an earlier pass of this item guessed by feature
family and was wrong twice in the same note, calling Revolve entangled (it had one
such closure) and the Transform panels entangled (they had none). What remains:

| block           | lines | pick-setters | pre-JSX closures |
| --------------- | ----- | ------------ | ---------------- |
| `patternDialog` | 293   | 2            | 7                |

**Measure with `setPicking\(`, not `setPicking`.** The first version of this table
credited Extrude with 5 pick-setters and called it 1b work. It has none — the
prefix match was catching `setPickingUpFace`, a dialog-local boolean — and Extrude
extracted like every other 1a block. Pattern's 1 + 1 is real.

Dress-up confirmed the second half of the rule: nine closures sounds entangled, but
with no pick-setters they were row and label builders, and the right move was
neither to carry them into the component nor to leave them — it was to lift the
arithmetic into pure functions and test it. That paid twice: Extrude held a second
copy of the same grouping rule, so both now share `ui/pickRows.ts`
(`groupPickRows`), and writing its tests exposed that both originals numbered rows
by label prefix rather than by kind — harmless given the labels they produce,
wrong as a primitive, now fixed. **Pattern is the last block, and the real 1b
work**:
Pattern's `setWorldRef` calls `setPicking(false)` and `setPickPurpose("sketch")`
to cancel an in-flight pick while rewriting the dialog, and handing that to a
presentational component means threading the pick setters through it. Expect more
moves like the DXF one, where the unit table and `$INSUNITS` sniffer had to go to
`document/dxfImport.ts` first — that is the point, not a detour.

**Tier 2 — guardrails, so it does not regress.**

- [ ] **3. Clear the 11 lint warnings.** Three are `react-refresh` in
      `DimValueInput`; the rest are `exhaustive-deps` in `MoreFlyout`,
      `OverflowToolbar`, `useAgentBridge`, `App.tsx` and the Viewport mount
      effect. Most of the `App.tsx` ones should fall out of item 1b rather than
      be silenced by hand.

**Sequencing.** `npm run verify` gates item 1. `App.tsx` and `Viewport.tsx`
have no unit tests — Vitest can load neither the OCCT wasm nor a WebGL context —
so the verify scripts are the only net under a refactor of that size, and they
need to be green _first_ (`scripts/README.md` has the current state of that).
Item 1 is the big one and is better done in public as a series of small PRs
than held back: a repo visibly being improved reads better than a suspiciously
pristine one. The exhaustiveness guardrails are in, so a refactor that drops a
case on the floor now fails the build rather than the user.

**On the `assertNever` guards, so they are not "tidied" away.** Six dispatches
had a genuinely silent fallthrough and now carry one:

- `resolveDocument` (`document.ts`) and `buildBodies` (`kernel/worker.ts`) — a
  feature kind missing from either built nothing and raised nothing. The first is
  the worse of the two: it never even reaches the worker.
- `applyDerived` (`derived.ts`) — same shape, for a derived-op kind: the offset /
  mirror / pattern geometry simply never appears.
- `pointRefsOf` and `retargetVertex` (`trimOps.ts`) — their catch-all `default`
  was correct for the ten entity-level constraints and would have quietly dropped
  a new constraint kind's vertex references. The ten are spelled out now so the
  default can be a guard.
- `sketchEntitiesBounds` (`dxfImport.ts`) — a void switch, so the return check
  never applied; a new entity kind would have left a DXF import framing the view
  on everything except that kind.

The other eleven switches over these same unions — the constraint and
sketch-entity dispatches in `App.tsx`, `document.ts`, `sketchTools.ts`,
`sketchGeom.ts`, `Viewport.tsx` and `agent/commands.ts` — are **already**
exhaustiveness-checked, because each returns a non-`undefined` type and
TypeScript rejects the fall-through path (TS2366). Adding `assertNever` there
buys a slightly clearer error message and nothing else, so they were left alone.
The remaining `dxfImport.ts` switch, over a parsed DXF entity's own `type`
string, must stay permissive: that is an open set from an external file, not a
union we own, and unsupported types are deliberately counted into `skipped`
rather than rejected.

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
- Parts: the first lump keeps the producing feature's id, later lumps take
  `<id>#1`, `<id>#2`. Chosen so nothing needed migrating.

**Build / test**

- **Typecheck with `npm run typecheck` (`tsc -b`), never a bare `tsc --noEmit`** —
  the root tsconfig has `files: []`, so a bare run checks nothing and "passes".
- **`worker.ts` has no unit coverage and cannot have any** — Vitest can load
  neither the OCCT wasm nor a worker global, so none of its ~30 geometry
  functions run under `npm test`. `scripts/verify-build-bodies.mjs` builds one of
  every feature type against a live app instead; it is the only thing that
  exercises that file at all.
- `scripts/verify-*.mjs` are Playwright checks against a local `npm run dev`, not
  part of CI. Most share `scripts/lib/harness.mjs` (launch / waitIdle / apply /
  read); set `CHROMIUM_PATH` to use a browser other than Playwright's own.

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
