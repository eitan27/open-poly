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

| Action                                     | Shortcut                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undo / Redo                                | `⌘Z` / `⌘⇧Z`                                                                                                                                                                                                                                                                                                                                                                     |
| Delete selection                           | `Delete` / `Backspace`                                                                                                                                                                                                                                                                                                                                                           |
| Cancel current mode / dialog               | `Esc`                                                                                                                                                                                                                                                                                                                                                                            |
| Dimension selected line/circle             | `D` (sketch mode)                                                                                                                                                                                                                                                                                                                                                                |
| Spline: finish + commit accumulated points | `Esc` (sketch mode, spline tool — matches how the line tool ends a chain; `Esc` with no draft still cancels the tool)                                                                                                                                                                                                                                                            |
| Find a tool (the `…` flyout)               | `/` — opens the search flyout of whichever toolbar is live (sketch column while editing a sketch, modeling bar otherwise). Its button (`…` on the modeling bar, `More ▸` on the sketch column) is always there. Lists the buttons that didn't fit; typing searches every tool in that bar, `↑`/`↓` + `Enter` to pick. Works even when nothing is hidden, as a plain tool search. |

## Modeling toolbar (available whenever you're not editing a sketch)

Every key below opens its tool whatever is selected — none of them waits for a
selection first. A tool that needs geometry arms it inside its own dialog: press
the key, then click what it asks for (a pre-existing selection still prefills the
slots, so the pick-first habit costs nothing). `Esc` disarms the slot that's
listening and keeps what has already been picked; a second `Esc` closes the
dialog.

| Action    | Key | Notes                                                                                                                                                                                                                                        |
| --------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sketch    | `S` | Pick a plane/face to start a sketch.                                                                                                                                                                                                         |
| New Body  | `N` | Opens the Box/Cylinder/Sphere menu (item itself stays mouse-only — 3-item pick isn't worth 3 more bindings). Ignores `picking`, same as the button.                                                                                          |
| Plane     | `P` | Reuses `P` from Polygon (sketch mode) — mutually exclusive, safe.                                                                                                                                                                            |
| Extrude   | `E` | Profiles are armed in the dialog — sketch regions, the edges enclosing one, sketch text, or planar body faces; click a picked one again to drop it.                                                                                          |
| Revolve   | `R` | Reuses `R` from Rectangle (sketch mode) — mutually exclusive, safe.                                                                                                                                                                          |
| Sweep     | `W` | Arms the profile, then hands the arming to the path. `S` was already taken by Sketch, so this uses the next distinctive letter in "s**w**eep" — weakest mnemonic in this table.                                                              |
| Loft      | `L` | Sections are armed in the dialog, in the order you pick them. Reuses `L` from Line (sketch mode) — mutually exclusive, safe.                                                                                                                 |
| Chamfer   | `C` | Edges/faces are armed in the dialog (one body at a time). Reuses `C` from Circle-center (sketch mode) — mutually exclusive, safe.                                                                                                            |
| Fillet    | `F` | Same arming as Chamfer.                                                                                                                                                                                                                      |
| Shell     | `G` | Hollow the selected body — a click anywhere on it (body or face) arms the body, giving a sealed shell; faces to open are picked from the dialog. No strong mnemonic available (S/H/O all taken) — picked arbitrarily, like construction `Q`. |
| Boolean   | `B` | Opens even with fewer than two bodies — the dialog says so rather than the button sitting inert. Resolves conflict #1 (below).                                                                                                               |
| Transform | `T` |                                                                                                                                                                                                                                              |
| Mirror    | `M` | The body is armed in the dialog; the plane is a dropdown (datum / reference plane / picked body face).                                                                                                                                       |
| Pattern   | `X` | Repeat the selected body — linear run/grid or circular ring. Same letter as the sketch pattern tools (mutually exclusive contexts, safe).                                                                                                    |

## Sketch toolbar (only available while editing a sketch)

| Action                                                                 | Key                     | Notes                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select / Line / Rectangle (2-corner) / Circle (center) / Polygon / Arc | `S` `L` `R` `C` `P` `A` | Already shipped. (Select moved `V`→`S`.)                                                                                                                                                                                                                      |
| Rectangle: center + corner                                             | `Shift+R`               | Variant of `R`.                                                                                                                                                                                                                                               |
| Circle: 3 points                                                       | `Shift+C`               | Variant of `C`.                                                                                                                                                                                                                                               |
| Spline                                                                 | `Shift+S`               | Variant of `S` (which now selects the **Select** tool). Moved `S`→`Shift+S` so the bare letter goes to the more frequently used Select pointer.                                                                                                               |
| Offset                                                                 | `O`                     | **O**ffset. Acts on the current selection (must be a single chain); opens an on-canvas distance box + a draggable arrow.                                                                                                                                      |
| Mirror (sketch)                                                        | `M`                     | **M**irror. Click a line to arm the mirror axis, then click entities to mirror them across it (live dashed previews); `Enter` commits, `Esc` cancels. Distinct from the modeling-toolbar `M` (body Mirror) — mutually exclusive, safe.                        |
| Linear pattern                                                         | `X`                     | Click entities to repeat (seeds from the current selection; re-click removes), set count + ΔX/ΔY in the floating box (live dashed previews); `Enter` commits an associative op, `Esc` cancels.                                                                |
| Circular pattern                                                       | `Shift+X`               | Variant of `X`. First click sets the center (a vertex, the origin, or empty space — the latter commits a construction point), then click entities to repeat; count + 360°/angle/symmetric in the floating box; `Enter` commits, `Esc` cancels.                |
| Project / Convert                                                      | `U`                     | "**U**se" existing geometry. Click body edges & vertices to project them onto the sketch plane as new entities (live dashed previews); `Enter` commits, `Esc` cancels. Straight edges → lines, planar circular edges → circles/arcs, anything else → splines. |
| Text                                                                   | `T`                     | **T**ext. Click to place the baseline anchor, then type the string + height in the floating box; the glyphs preview live. `Enter` commits, `Esc` cancels. Sketch-mode only — distinct from the modeling-toolbar `T` (Transform), mutually exclusive, safe.    |
| Trim                                                                   | `K`                     | Click the piece of an edge to remove — it goes as far as the nearest crossings; an edge nothing crosses goes whole. `T` (its own initial) is Text, so **K** for the knife.                                                                                    |
| Extend                                                                 | `Shift+K`               | Variant of `K`. Click near an edge's end to grow it out to the first thing ahead; the meeting is recorded as a constraint, so it lasts.                                                                                                                       |
| Dimension                                                              | `D`                     | Already shipped.                                                                                                                                                                                                                                              |
| Horizontal                                                             | `H`                     | Select a single line.                                                                                                                                                                                                                                         |
| Vertical                                                               | `V`                     | Select a single line.                                                                                                                                                                                                                                         |
| Parallel                                                               | `Shift+P`               | Resolves conflict #2 (below).                                                                                                                                                                                                                                 |
| Perpendicular                                                          | `N`                     | Resolves conflict #2. Reuses `N` from New Body (modeling toolbar) — mutually exclusive, safe.                                                                                                                                                                 |
| Equal                                                                  | `=`                     | Matches the button's own "＝" glyph.                                                                                                                                                                                                                          |
| Construction (toggle)                                                  | `Q`                     | No strong mnemonic available (`C` taken twice over); picked arbitrarily.                                                                                                                                                                                      |

_(There is no longer a "Solve constraints" shortcut: drawing and editing
constraints now solve automatically, so the manual ⛓ Solve button and its `S`
binding were removed. `S` in sketch mode now selects the **Select** tool (the
pointer), and the **Spline** tool moved to `Shift+S`.)_

## Standard views

| Action                                           | Key     |
| ------------------------------------------------ | ------- |
| Top / Front / Right / Back / Left / Bottom / Iso | `1`–`7` |

Numbers instead of first letters, on purpose: first letters would collide on
**B** (Back vs. Bottom) and, worse, with modeling-toolbar letters that stay
live in the same context — `T`op vs. `T`ransform, `F`ront vs. `F`illet, `L`eft
vs. `L`oft/`L`ine, `R`ight vs. `R`evolve/`R`ectangle. The view-controls bar is
visible and clickable in _both_ modeling and sketch mode, so digits work in
both, unlike every other binding in this doc.

## Timeline / Parts list

| Action                                   | Key               | Notes                                                                              |
| ---------------------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| Move selected feature up/down            | `Alt+↑` / `Alt+↓` | Acts on the single selected timeline row (`primaryFeatureId`); no-ops at the ends. |
| Toggle suppress/hide on selected feature | `H`               | Matches the row's own eye/suppress icon.                                           |
| Import STEP                              | `⌘I` / `Ctrl+I`   | Opens the file picker, same as the toolbar button.                                 |

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
contended letter, consistent with how `Shift+R`/`Shift+C` are used
for tool variants) and `Perpendicular` → `N` (also FreeCAD's convention when
`P` is unavailable).

## Footnote: intentional same-letter reuse across mutually exclusive modes

These pairs share a letter but are never both clickable at once (one is in
the modeling toolbar, the other in the sketch toolbar, and you can't be in
both at the same time):

- `P`: Plane (modeling) / Polygon (sketch)
- `C`: Chamfer (modeling) / Circle-center (sketch)
- `S`: Sketch (modeling) / Select (sketch)
- `N`: New Body (modeling) / Perpendicular (sketch)
- `R`: Revolve (modeling) / Rectangle: 2 corners (sketch)
- `L`: Loft (modeling) / Line (sketch)
- `M`: Mirror body (modeling) / Mirror sketch entities (sketch) — same verb, two contexts
- `T`: Transform (modeling) / Text (sketch)
- `U`: (unused in modeling) / Project-Convert "Use" (sketch)
- `H`: Toggle suppress/hide on selected feature (Timeline, modeling mode only) / Horizontal constraint (sketch)
- `V`: (unused in modeling) / Vertical constraint (sketch)

## Future conflicts to watch (from [`docs/PLAN.md`](docs/PLAN.md)'s roadmap)

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
  ✅ shipped (Phase 8.7). The prediction here held: `⌘O` was tried for "Open"
  and reverted (browsers do reserve it for their own Open-File dialog, exactly
  as expected), so it ended up menu-only — a **"＋ New"** / **"Open…"** button
  pair in the topbar, no shortcut for now.
- **Section view, appearance** — Phase 8 backlog, still TODO, no concrete UI
  yet to attach letters to; revisit once they have toolbar buttons.
