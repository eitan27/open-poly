# Contributing to Open Poly

Thanks for considering a contribution. This doc covers setup, the codebase
layout, and how to get a change merged.

## Setup

```bash
npm install
npm run dev      # starts Vite; open the printed localhost URL
npm test         # run the unit test suite (Vitest)
npm run typecheck
npm run lint         # ESLint
npm run format:check # Prettier
```

Node 20.19+ or 22.12+ is required (see `README.md`).

### Formatting

Prettier (`.prettierrc.json`) owns layout, and the tree has been formatted in
one pass, so `npm run format:check` is clean and CI enforces it. Run
`npm run format` before pushing and don't hand-tune whitespace — if the output
looks wrong, change the code, not the spacing.

One markdown gotcha worth knowing when editing the issue templates: a list
that isn't preceded by a blank line gets folded into the paragraph above it,
so `**Steps to reproduce**` followed straight by `1.` `2.` `3.` collapses onto
a single line. Keep the blank line.

## Before opening a PR

- `npm test`, `npm run typecheck`, `npm run lint` and `npm run format:check`
  must pass — CI runs all four.
- `npm run build` should succeed (catches anything the dev server tolerates
  but a production build won't).
- If you touched anything rendering- or interaction-related in the viewport
  or sketch tools, manually exercise the change in the browser — the unit
  suite covers document/geometry logic, not rendering or picking.
- For kernel or viewport changes, also run the relevant acceptance checks:
  `npm run dev` in one shell, then `npm run verify -- <name>` (or
  `npm run verify` for all of them). These drive the real app in a real
  browser and are the only coverage `src/kernel/worker.ts` and
  `src/viewport/` have. See [`scripts/README.md`](scripts/README.md), which
  also records which of them are currently green.
- Keep PRs focused. Unrelated cleanup, formatting-only changes, or drive-by
  refactors belong in a separate PR unless they're in files you're already
  touching for the main change.

## Codebase layout

| Path             | What lives there                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/document/`  | The document model — features, sketch tools, DXF import, expressions, planes, regions. Pure logic, no React/DOM.                                                                          |
| `src/lib/`       | Dependency-free primitives shared by everything else — number formatting, `clamp`, 2D/3D vector math.                                                                                     |
| `src/geom/`      | Small standalone geometry algorithms (circle faceting, edge chains, chamfer wedges, ring fitting).                                                                                        |
| `src/kernel/`    | The web worker that drives the OpenCascade/replicad geometry kernel — feature regeneration, meshing, topological naming.                                                                  |
| `src/sketch/`    | The 2D constraint solver integration and sketch-specific geometry (inference, snapping, dimensions).                                                                                      |
| `src/selection/` | What a selection _is_ (`types.ts` — `Selection`, `SelectionFilter`, `DatumId`) plus measurement and other selection-derived computations. No three.js.                                    |
| `src/storage/`   | IndexedDB document persistence.                                                                                                                                                           |
| `src/settings/`  | User settings/preferences, and `shortcuts.ts` — the one table every keyboard shortcut is declared in (the key handler and the toolbar hints both read it; its test fails on a collision). |
| `src/agent/`     | The in-app side of the MCP agent bridge (commands, operations, protocol). Should call into `src/document/` rather than reimplement its logic.                                             |
| `src/ui/`        | Dialogs and panels.                                                                                                                                                                       |
| `src/viewport/`  | The three.js viewport — rendering, camera, picking, highlighting. `types.ts` holds the render payloads and `ViewportApi`, so a consumer needing only a type doesn't pull three.js.        |
| `src/App.tsx`    | Top-level orchestration: state, wiring, dialog lifecycle. Currently oversized and mid-refactor into smaller hooks — see open issues.                                                      |
| `mcp-server/`    | The standalone MCP server package that external agent clients (Claude Desktop, Cursor, etc.) connect to. Imports types/logic from `src/agent/` rather than duplicating them.              |
| `functions/`     | Cloudflare Pages functions (currently: the bug-report endpoint).                                                                                                                          |
| `scripts/`       | Manual Playwright-based verification scripts, run ad hoc against a local `npm run dev` instance — not part of CI.                                                                         |

## Where do I add a feature?

The most common substantial contribution, and the one the layout above doesn't
answer on its own. A "feature" here is a timeline entry — Extrude, Revolve,
Shell — not a UI affordance.

**Start by copying the nearest existing one, end to end.** Every feature is the
same ten-odd edits in the same order, so the fastest correct route is to pick the
closest sibling and follow it through:

| If the new feature…                    | copy                                              |
| -------------------------------------- | ------------------------------------------------- |
| consumes a sketch region and sweeps it | `revolve` (or `sweep` / `loft` for multi-profile) |
| modifies a body you select             | `shell`, or `dressup` for an edge/face selection  |
| combines or copies whole bodies        | `boolean`, `mirror`, `pattern`                    |
| is a standalone solid from parameters  | `primitive`                                       |

`grep -rn '"revolve"' src/` is a genuinely good map of the work. Revolve is the
best all-round model: it has a sketch profile, a picked axis, an expression-valued
parameter, a creation dialog, an edit-in-place path and an agent tool.

**The compiler will tell you most of what you missed.** Add the interface to
`Feature` in `document/types.ts` and the build fails until you have answered,
by name:

- `resolveDocument` in `document/document.ts` — turn expressions into numbers and
  push a `ResolvedFeature`. Skipping this is the mistake worth knowing about: the
  feature would reach neither the kernel nor an error message.
- `buildBodies` in `kernel/worker.ts` — the actual geometry, once you add the
  matching `ResolvedFeature` member to `kernel/types.ts`.
- `featureTypeLabel` in `document/featureDefs.ts` — the timeline row's label.
- `openFeatureEditor` in `App.tsx` — double-click behaviour: its own dialog, or
  the floating parameter panel.
- `BODY_FEATURE_TYPES` in `document/parts.ts` — only if it produces a body of its
  own, which is also what makes it colourable and hideable.
- `ParamEditor.tsx` — a branch for the parameter panel.

Those are `assertNever` guards and exhaustive `Record`s, added for exactly this
reason. Treat a build error in one of them as the checklist working.

**What the compiler cannot tell you**, and what reviewers will look for:

- **A constructor in `document/document.ts`** (`addRevolve` and friends): one
  function that inserts the feature, names it by ordinal, and assigns a colour.
  Both the UI and the agent must call it rather than building the object
  themselves — see the last bullet under Code style.
- **Numeric parameters are expression strings**, not numbers. `"40"` and
  `"width * 2"` are both valid and are resolved against the document scope, which
  is what makes variables work. Store the string; evaluate in `resolveDocument`.
- **Backfill in `migrateDocument`** whenever you later add a field to a feature
  that may already be on someone's disk. Old documents must keep opening.
- **Topological references must be persistent names, not indices.** If the
  feature selects faces or edges, store the names from the kernel's naming pass
  and keep the geometric fingerprint beside them, the way `dressup` and `shell`
  do. Build-local ids renumber on the next rebuild.
- **The agent path**: a zod spec in `agent/operations.ts`, the handler in
  `agent/commands.ts`, the tool in `mcp-server/src/tools.ts`, and a line in
  `agent/modeling-guide.md`. Feature parity with the UI is the expectation, not a
  follow-up.
- **The UI.** Today a feature's dialog, its state and its JSX all live in
  `src/App.tsx`, with styles in `src/App.css`. Both files are mid-refactor —
  dialogs are moving into `src/ui/` and styles alongside them — so copy whichever
  sibling is closest to where that has got to, and prefer `src/ui/` for anything
  genuinely new. `BooleanDialog.tsx`, `SettingsDialog.tsx` and `ReportDialog.tsx`
  are the pattern.

**Two things to know about the kernel before you design the geometry.** This
OCCT build cannot boolean an analytic primitive surface (cylinder, sphere)
against a plane, so curved geometry is faceted deliberately — cylinders are
48-gon prisms and revolve is a faceted ruled loft. And the failure only
reproduces in the full pipeline, never in an isolated probe. `docs/PLAN.md`'s
Gotchas section is the required reading; it will save you a day.

**Testing.** Vitest can load neither the OCCT wasm nor a WebGL context, so
document-level logic (the constructor, the resolve step, validation) goes in a
`*.test.ts` next to it, and the geometry gets a `scripts/verify-<feature>.mjs`
acceptance check driving the real app. `scripts/README.md` explains the harness;
`verify-build-bodies.mjs` is the one to extend with a "does it build at all" case.

## Code style

- TypeScript throughout; avoid `any` where a real type is available.
- Domain/geometry logic (`document/`, `geom/`, `kernel/`, `sketch/`) should
  stay framework-free — no React imports there.
- Prefer adding a shared helper in a natural home over copy-pasting an
  existing one — check `src/lib/`, `src/document/` and `src/geom/` before
  writing new vector-math, formatting, or ID-generation helpers.
- The agent path (`src/agent/`) and the UI path (`src/App.tsx` and friends)
  should converge on the same `src/document/` mutation functions rather
  than each implementing feature creation independently.

## Reporting bugs / requesting features

Use the GitHub issue templates. For bugs, include the document (or a
minimal repro) if possible — the in-app "Report a bug" flow does this for
you automatically via `functions/api/report.ts`.

## License

By contributing, you agree your contributions are licensed under the
project's GPL-3.0-or-later license (see `LICENSE`).
