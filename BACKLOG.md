# Backlog

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
