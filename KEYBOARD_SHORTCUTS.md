# Keyboard shortcut proposal

A scan of every clickable action in the app (`src/App.tsx` toolbars, the sketch
toolbar, the feature timeline, and the Parts list), grouped by when each
action is actually available, with a recommended key for the ones that would
benefit from one. Two real letter collisions turned up between functions that
are simultaneously available — see **Conflicts to resolve** below.

This is a proposal only; nothing here is wired up yet.

## Already shipped (for reference, not proposed)

| Action | Shortcut |
|---|---|
| Undo / Redo | `⌘Z` / `⌘⇧Z` |
| Delete selection | `Delete` / `Backspace` |
| Cancel current mode / dialog | `Esc` |
| Dimension selected line/circle | `D` (sketch mode) |
| Select / Line / Rectangle (2-corner) / Circle (center) / Polygon / Arc | `V` `L` `R` `C` `P` `A` (sketch mode) |

## Proposed: modeling toolbar (available whenever you're not editing a sketch)

| Action | Proposed key | Notes |
|---|---|---|
| Start a sketch | `S` | |
| New Body (open the box/cylinder/sphere menu) | `N` | See conflict #1 — not `B`. |
| Reference plane | `P` | Reuses `P` from Polygon (sketch mode); safe, the two modes are mutually exclusive — see footnote. |
| Extrude | `E` | |
| Chamfer | `C` | Reuses `C` from Circle (sketch mode); safe, mutually exclusive — see footnote. |
| Fillet | `F` | |
| Boolean | `B` | See conflict #1. |
| Transform | `T` | |

`New Body`'s menu itself (Box/Cylinder/Sphere) isn't proposed per-item
shortcuts — `N` opens it, then it's a 3-item mouse/arrow pick, which doesn't
seem worth three more bindings.

## Proposed: sketch toolbar (only available while editing a sketch)

| Action | Proposed key | Notes |
|---|---|---|
| Rectangle: center + corner | `Shift+R` | Variant of the existing `R`. |
| Circle: 3 points | `Shift+C` | Variant of the existing `C`. |
| Parallel constraint | `Shift+P` | See conflict #2 — not plain `P` (taken by Polygon). |
| Perpendicular constraint | `N` | See conflict #2. Reuses `N` from New Body (modeling toolbar); safe, mutually exclusive. |
| Equal constraint | `=` | Matches the button's own "＝" glyph; sidesteps the letter scheme entirely. |
| Solve constraints | `S` | Reuses `S` from Sketch (modeling toolbar); safe, mutually exclusive. |

## Proposed: standard views

| Action | Proposed key |
|---|---|
| Top / Front / Right / Back / Left / Bottom / Iso | `1`–`7` |

Recommending numbers instead of first letters here on purpose: first letters
would collide on **B** (Back vs. Bottom) and, worse, would also collide with
modeling-toolbar letters that are active in the same context — `T`op vs.
`T`ransform, `F`ront vs. `F`illet, `L`eft vs. `L`ine, `R`ight vs. `R`ectangle
(the last two only matter while sketching, but views stay clickable then
too). Numbered views sidestep all of that and match the common SolidWorks/
Fusion 360 convention, so this isn't filed as an open conflict — flagging the
reasoning in case you'd rather keep letters and resolve those four instead.

## Proposed: timeline / Parts list

| Action | Proposed key | Notes |
|---|---|---|
| Move selected feature up/down | `Alt+↑` / `Alt+↓` | Acts on the single selected timeline row. |
| Toggle suppress/hide on selected feature | `H` | Matches the row's own eye icon. |
| Import STEP | `⌘I` / `Ctrl+I` | Opens the file picker, same as the toolbar button. |

## Not proposed

- **Rename, color, opacity** (Parts list) — continuous/text inputs, not
  toggles; a shortcut wouldn't replace typing or dragging a slider.
- **Export STEP / Export STL** — per-part, infrequent; the row buttons are
  already one click once a part is selected.
- **Edit sketch / Finish sketch / Edit in viewport** — already reachable via
  double-click on the timeline row, and `Esc` already finishes/cancels.

## Conflicts to resolve

**#1 — New Body vs. Boolean (both naturally "B"), modeling toolbar.**
Both buttons are live at the same time (not mode-gated against each other),
so they can't share a key. Recommendation: give `B` to **Boolean** (no good
alternative letter for it) and move **New Body** to `N`. Flagging in case you
have a different preference (e.g. `⊕` is also evocative of "plus" → some
apps bind "new" actions to `+`/`Ctrl+N`).

**#2 — Polygon / Parallel / Perpendicular all naturally "P", sketch toolbar.**
All three are visible and clickable together while sketching. `Polygon`
already ships as `P`, so it keeps it. For the other two, recommendation:
`Parallel` → `Shift+P` (modifier on the contended letter, consistent with how
`Shift+R`/`Shift+C` are used above for tool variants) and `Perpendicular` →
`N` (this is also FreeCAD's convention when `P` is unavailable). Weakest
mnemonics in this whole list — open to alternatives if you'd rather not lean
on `Shift+P`.

## Footnote: intentional same-letter reuse across mutually exclusive modes

These pairs share a letter but are never both clickable at once (one is in
the modeling toolbar, the other in the sketch toolbar, and you can't be in
both at the same time), so there's no real conflict — listed for visibility
only:

- `P`: Plane (modeling) / Polygon (sketch)
- `C`: Chamfer (modeling) / Circle-center (sketch)
- `S`: Sketch (modeling) / Solve (sketch)
- `N`: New Body (modeling) / Perpendicular (sketch)
