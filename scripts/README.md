# `scripts/` — acceptance checks and one-off tooling

Everything here drives the **real app in a real browser**. None of it runs in
CI, and none of it is a unit test — `npm test` (Vitest, ~1000 tests, 3s) covers
the document model, geometry helpers and the constraint solver, and that is the
suite to add to when you can.

These exist because a large part of this app is unreachable from Vitest: it can
load neither the OCCT WebAssembly kernel nor a WebGL context. So
`src/kernel/worker.ts` and `src/viewport/` have **no unit tests at all**, and
`verify-build-bodies.mjs` and `verify-viewport-modules.mjs` are the only
coverage they have. Treat those two as load-bearing.

## Running them

They drive a live dev server, so start one first, in another shell:

```bash
npm run dev           # leave it running
npm run verify        # every script, one at a time
npm run verify -- shell transform   # only names containing "shell" or "transform"
node scripts/verify-shell.mjs       # one script, with its full output
```

`npm run verify` prints a pass/fail line per script and exits non-zero if any
failed. `VERBOSE=1` echoes each script's own output; `URL=` points at a
different server (a `vite preview` build, say); `TIMEOUT_MS=` changes the
per-script limit (default 300000).

**Run them alone.** They are wall-clock scripts that poll the app's status chip,
so anything else competing for the CPU — `npm test`, a build, a second verify
run — changes their answers. This is not hypothetical: it is how the B.2
migration "verified" itself twice before verifying itself once (see PLAN,
"What it taught us").

## What a verify script is

Roughly one per shipped feature, named for it. Each one opens the app, builds
something through the dev-only `window.__openpoly` bridge or by clicking the
real UI, then asserts on the result — body counts, face names, a dialog's
state, a measured dimension. They are acceptance checks written while the
feature was being built, kept because they are the only thing that exercises
these paths.

`lib/harness.mjs` holds what they share: `launch()` (headed or headless
Chromium on the app), `openPoly(page)` (the bridge plus `waitIdle`/`settle` —
the polling that waits for a regeneration to actually land), and `checker()`
(a PASS/FAIL tally whose `done()` exits non-zero). 49 of the 64 use it; the
rest predate it and hand-roll the same thing.

Writing a new one:

```js
import { launch, openPoly, checker } from "./lib/harness.mjs";
const { page, close } = await launch();
const op = openPoly(page);
const { check, done } = checker();
await op.newDocument();
check("a box builds", (await op.bodyCount()) === 1);
await close();
done(); // prints the tally, exits non-zero on failure
```

## Current state

**All 64 pass**, in about 45 minutes on a quiet 12-core machine. Keep it that
way: a red script is either a real regression or a script that has outlived the
UI it asserts on, and both are worth knowing about the day they happen.

Two things to expect when you run it:

- **`verify-shell-loft` takes ~5 minutes on its own.** It re-lofts a cavity and
  then probes the walls; that is genuinely the work, not a hang. It is why the
  per-script timeout is 420s rather than something that merely looks generous.
- **A failure on a loaded machine is not evidence.** Re-run that one script
  alone before believing it (`node scripts/verify-<name>.mjs`). Measured here:
  one script timed out at 181s while other processes competed, and passed in
  106s on a quiet machine — same code, opposite verdict. A single script already
  keeps ~7 cores busy, which is also why the runner is strictly sequential.

When one does break, the usual cause is that the app moved and the script did
not — a selector for an element that has been renamed, relocated or deliberately
removed. Check what the app does now before assuming a regression: three of
these once asserted a viewport pick banner that `anyDialogOpen` had stopped
rendering while a dialog is open, and the dialog's own armed slot had taken over
the job.

## The other scripts

| Script                    | What it is                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-all.mjs`          | The runner behind `npm run verify`.                                                                                                                                          |
| `lib/harness.mjs`         | Shared scaffolding for the verify scripts.                                                                                                                                   |
| `diagnose.mjs`            | Loads the dev server headless and reports console errors, page errors and whether regen completed. First thing to reach for when the app is broken and you don't know where. |
| `bridge-e2e.mjs`          | Stands up the WebSocket hub and drives requests through the browser↔hub bridge.                                                                                              |
| `mcp-e2e.mjs`             | Acts as an MCP client end to end: spawns the stdio server, drives tools through a live tab.                                                                                  |
| `landing-shots.mjs`       | Regenerates the landing-page hero PNGs in `landing/`.                                                                                                                        |
| `third-party-licenses.ts` | Build-time: generates `dist/third-party-licenses.txt`. Runs from `vite.config.ts`, not by hand.                                                                              |
| `tutorial/`               | Records the narrated "Getting started" video. Has its own deps — see `tutorial/record.mjs`.                                                                                  |
| `fixtures/`               | Saved `.openpoly.json` documents some scripts load.                                                                                                                          |
