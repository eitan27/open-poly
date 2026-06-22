# Keyboard shortcuts

A scan of every clickable action in the app (`src/App.tsx` toolbars, the sketch
toolbar, the feature timeline, and the Parts list), grouped by when each
action is actually available. **All shortcuts below are wired up** (global
key handler in `src/App.tsx`, mode-gated on `editingSketchId`) and each
bound button's `title` tooltip names its key, so the UI itself is the source
of discoverability.

This doc was last reassessed after Loft, Sweep, Mirror, and the sketch
Spline tool shipped (none of which had shortcuts in the prior revision).

## Already shipped

| Action | Shortcut |
|---|---|
| Undo / Redo | `⌘Z` / `⌘⇧Z` |
| Delete selection | `Delete` / `Backspace` |
| Cancel current mode / dialog | `Esc` |
| Dimension selected line/circle | `D` (sketch mode) |
| Spline: commit accumulated points | `Enter` (sketch mode, spline tool) |

## Modeling toolbar (available whenever you're not editing a sketch)

| Action | Key | Notes |
|---|---|---|
| Sketch | `S` | Pick a plane/face to start a sketch. |
| New Body | `N` | Opens the Box/Cylinder/Sphere menu (item itself stays mouse-only — 3-item pick isn't worth 3 more bindings). Ignores `picking`, same as the button. |
| Plane | `P` | Reuses `P` from Polygon (sketch mode) — mutually exclusive, safe. |
| Extrude | `E` | |
| Revolve | `R` | Reuses `R` from Rectangle (sketch mode) — mutually exclusive, safe. |
| Sweep | `W` | `S` was already taken by Sketch, so this uses the next distinctive letter in "s**w**eep" — weakest mnemonic in this table. |
| Loft | `L` | Reuses `L` from Line (sketch mode) — mutually exclusive, safe. |
| Chamfer | `C` | Reuses `C` from Circle-center (sketch mode) — mutually exclusive, safe. |
| Fillet | `F` | |
| Boolean | `B` | Resolves conflict #1 (below). |
| Transform | `T` | |
| Mirror | `M` | |

## Sketch toolbar (only available while editing a sketch)

| Action | Key | Notes |
|---|---|---|
| Select / Line / Rectangle (2-corner) / Circle (center) / Polygon / Arc | `V` `L` `R` `C` `P` `A` | Already shipped. |
| Rectangle: center + corner | `Shift+R` | Variant of `R`. |
| Circle: 3 points | `Shift+C` | Variant of `C`. |
| Spline | `Shift+L` | Variant of `L` — a "freeform line". |
| Dimension | `D` | Already shipped. |
| Parallel | `Shift+P` | Resolves conflict #2 (below). |
| Perpendicular | `N` | Resolves conflict #2. Reuses `N` from New Body (modeling toolbar) — mutually exclusive, safe. |
| Equal | `=` | Matches the button's own "＝" glyph. |
| Construction (toggle) | `Q` | No strong mnemonic available (`C` taken twice over); picked arbitrarily. |
| Solve constraints | `S` | Reuses `S` from Sketch (modeling toolbar) — mutually exclusive, safe. |

## Standard views

| Action | Key |
|---|---|
| Top / Front / Right / Back / Left / Bottom / Iso | `1`–`7` |

Numbers instead of first letters, on purpose: first letters would collide on
**B** (Back vs. Bottom) and, worse, with modeling-toolbar letters that stay
live in the same context — `T`op vs. `T`ransform, `F`ront vs. `F`illet, `L`eft
vs. `L`oft/`L`ine, `R`ight vs. `R`evolve/`R`ectangle. The view-controls bar is
visible and clickable in *both* modeling and sketch mode, so digits work in
both, unlike every other binding in this doc.

## Timeline / Parts list

| Action | Key | Notes |
|---|---|---|
| Move selected feature up/down | `Alt+↑` / `Alt+↓` | Acts on the single selected timeline row (`primaryFeatureId`); no-ops at the ends. |
| Toggle suppress/hide on selected feature | `H` | Matches the row's own eye/suppress icon. |
| Import STEP | `⌘I` / `Ctrl+I` | Opens the file picker, same as the toolbar button. |

## Not bound

- **Rename, color, opacity** (Parts list) — continuous/text inputs, not
  toggles; a shortcut wouldn't replace typing or dragging a slider.
- **Export STEP / Export STL** — per-part, infrequent; the row buttons are
  already one click once a part is selected.
- **Edit sketch / Finish sketch / Edit in viewport** — already reachable via
  double-click on the timeline row, and `Esc` already finishes/cancels.
- **Polygon sides** (`n` input next to the Polygon tool) — a number field, not
  a toggle.

## Conflicts resolved

**#1 — New Body vs. Boolean (both naturally "B"), modeling toolbar.**
Both buttons are live at the same time (not mode-gated against each other),
so they can't share a key. Resolved: `B` → **Boolean**, **New Body** → `N`.

**#2 — Polygon / Parallel / Perpendicular all naturally "P", sketch toolbar.**
All three are visible and clickable together while sketching. `Polygon` kept
`P` (shipped first). Resolved: `Parallel` → `Shift+P` (modifier on the
contended letter, consistent with how `Shift+R`/`Shift+C`/`Shift+L` are used
for tool variants) and `Perpendicular` → `N` (also FreeCAD's convention when
`P` is unavailable).

## Footnote: intentional same-letter reuse across mutually exclusive modes

These pairs share a letter but are never both clickable at once (one is in
the modeling toolbar, the other in the sketch toolbar, and you can't be in
both at the same time):

- `P`: Plane (modeling) / Polygon (sketch)
- `C`: Chamfer (modeling) / Circle-center (sketch)
- `S`: Sketch (modeling) / Solve (sketch)
- `N`: New Body (modeling) / Perpendicular (sketch)
- `R`: Revolve (modeling) / Rectangle: 2 corners (sketch)
- `L`: Loft (modeling) / Line (sketch)

## Future conflicts to watch (from `PLAN.md`'s roadmap)

- **Pattern (linear/circular)** — Phase 5, still TODO. Its natural letter `P`
  is already double-claimed (Plane in modeling, Polygon in sketch), so it
  can't get a bare letter when it ships. It'll sit in the modeling toolbar
  near Mirror/Transform; recommend treating it as a Mirror variant —
  `Shift+M` — since both are "duplicate the body" operations, consistent
  with this doc's Shift-for-variant convention.
- **Measurement tools** — Phase 8 backlog, still TODO. Its natural letter `M`
  is already claimed by Mirror in the modeling toolbar. Will need an
  alternate letter (or a non-letter glyph, as Equal does with `=`) once it
  has a concrete toolbar button to attach a key to.
- **Multi-document manager** (new/open/rename/duplicate/delete documents) —
  Phase 8 backlog, still TODO. The obvious bindings `Ctrl+N` / `Ctrl+O` are
  both browser-reserved (new window / open file); will need different
  combinations (e.g. `Ctrl+Shift+N`) or to live menu-only with no shortcut.
- **Section view, appearance** — Phase 8 backlog, still TODO, no concrete UI
  yet to attach letters to; revisit once they have toolbar buttons.
