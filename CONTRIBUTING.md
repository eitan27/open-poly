# Contributing to Open Poly

Thanks for considering a contribution. This doc covers setup, the codebase
layout, and how to get a change merged.

## Setup

```bash
npm install
npm run dev      # starts Vite; open the printed localhost URL
npm test         # run the unit test suite (Vitest)
npm run typecheck
npm run lint      # ESLint
```

Node 20.19+ or 22.12+ is required (see `README.md`).

### Formatting

Prettier is configured (`.prettierrc.json`, `npm run format` / `format:check`)
but the existing codebase has **not** been bulk-reformatted — doing so in one
shot would touch essentially every file and drown out real changes in noise,
especially while the large files (`App.tsx`, `Viewport.tsx`, `worker.ts`) are
still being split up. New/touched code should be Prettier-clean; don't run
`format` across the whole tree in an unrelated PR.

## Before opening a PR

- `npm test` and `npm run typecheck` must pass.
- `npm run build` should succeed (catches anything the dev server tolerates
  but a production build won't).
- If you touched anything rendering- or interaction-related in the viewport
  or sketch tools, manually exercise the change in the browser — the unit
  suite covers document/geometry logic, not rendering or picking.
- Keep PRs focused. Unrelated cleanup, formatting-only changes, or drive-by
  refactors belong in a separate PR unless they're in files you're already
  touching for the main change.

## Codebase layout

| Path             | What lives there                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/document/`  | The document model — features, sketch tools, DXF import, expressions, planes, regions. Pure logic, no React/DOM.                                                             |
| `src/geom/`      | Small standalone geometry algorithms (circle faceting, edge chains, chamfer wedges, ring fitting).                                                                           |
| `src/kernel/`    | The web worker that drives the OpenCascade/replicad geometry kernel — feature regeneration, meshing, topological naming.                                                     |
| `src/sketch/`    | The 2D constraint solver integration and sketch-specific geometry (inference, snapping, dimensions).                                                                         |
| `src/selection/` | Measurement and selection-derived computations.                                                                                                                              |
| `src/storage/`   | IndexedDB document persistence.                                                                                                                                              |
| `src/settings/`  | User settings/preferences.                                                                                                                                                   |
| `src/agent/`     | The in-app side of the MCP agent bridge (commands, operations, protocol). Should call into `src/document/` rather than reimplement its logic.                                |
| `src/ui/`        | Dialogs and panels.                                                                                                                                                          |
| `src/viewport/`  | The three.js viewport — rendering, camera, picking, highlighting.                                                                                                            |
| `src/App.tsx`    | Top-level orchestration: state, wiring, dialog lifecycle. Currently oversized and mid-refactor into smaller hooks — see open issues.                                         |
| `mcp-server/`    | The standalone MCP server package that external agent clients (Claude Desktop, Cursor, etc.) connect to. Imports types/logic from `src/agent/` rather than duplicating them. |
| `functions/`     | Cloudflare Pages functions (currently: the bug-report endpoint).                                                                                                             |
| `scripts/`       | Manual Playwright-based verification scripts, run ad hoc against a local `npm run dev` instance — not part of CI.                                                            |

## Code style

- TypeScript throughout; avoid `any` where a real type is available.
- Domain/geometry logic (`document/`, `geom/`, `kernel/`, `sketch/`) should
  stay framework-free — no React imports there.
- Prefer adding a shared helper in a natural home over copy-pasting an
  existing one — check `src/document/`, `src/geom/`, and (once split out per
  the open-source refactor) `src/lib/` before writing new vector-math,
  formatting, or ID-generation helpers.
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
