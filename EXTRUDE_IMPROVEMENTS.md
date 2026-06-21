# Extrude: current behavior and improvement opportunities

A read-through of the extrude feature end to end — types (`src/document/types.ts`),
resolution (`src/document/document.ts`), the kernel (`src/kernel/worker.ts`), and
the UI (`src/App.tsx`, `src/ui/ParamEditor.tsx`) — to describe what it does today
and where it falls short. Analysis only; no code changed.

## What extrude does today

- One profile in, one solid out: either a closed region of a sketch
  (`ExtrudeProfile.kind === "sketchRegion"`) or a planar face of an existing body
  (`kind === "bodyFace"`), selected one at a time (`App.tsx`'s `extrudeProfile`
  memo bails unless `selection.length === 1`).
- A single **blind distance** along the profile's normal, with a `flip` toggle
  to reverse direction (`worker.ts:155-169`, `prismFromFace`).
- Three modes: `new` (its own body), `add` (fuse into a target body), `remove`
  (cut from a target body) — `worker.ts:441-491`.
- `remove`'s natural direction is inward (opposite the profile normal); `flip`
  reverses that, so the same checkbox means geometrically opposite things
  depending on mode (intentional, per the comment at `worker.ts:443-445`, but
  not surfaced anywhere in the UI).
- The dialog (`App.tsx:1702-1760`) is a flat form (mode buttons, target picker,
  distance field, flip checkbox) anchored near the picked profile; there's no
  3D preview before you click Create. Once a feature exists, editing its
  params in the right-hand `ParamEditor` *does* re-run the full document on
  every keystroke, so you get live feedback there — just not during initial
  creation.

## Gaps

### 1. Blind distance is the only extent type
There's no through-all, up-to-next-face, up-to-a-named-face/surface, or
symmetric/two-sided (split the distance about the sketch plane) option — only
"go this far in this direction." Up-to-face and through-all are the two most
commonly reached-for extents after blind in most CAD tools, and symmetric is
especially natural for centered bosses (you currently have to mentally halve
the distance and remember the part isn't centered on its sketch plane).

### 2. No draft/taper angle, no thin (shell) extrude
`prismFromFace` builds a straight `MakePrism`; there's no angled-wall option
and no "extrude as a shell of wall-thickness N" mode for the common
hollow-part case. Both are listed as out of scope in the agent's own modeling
guide (`src/agent/modeling-guide.md:96-98` calls out taper/thin alongside
revolve/sweep/loft as known missing features), so this gap is already
acknowledged — just not against extrude specifically.

### 3. One profile per operation
Selection is hard-capped at one sketch region or one face (`App.tsx:684`). If
a sketch has three separate rectangles meant to become three identical bosses
(or three holes), that's three separate Extrude features today, each picked
and confirmed individually. A multi-select → one Extrude that produces (or
cuts) once per region would remove a lot of repetitive dialog-filling for a
common pattern.

### 4. No pre-commit 3D feedback
The Extrude dialog shows no geometry until you click Create — you're
committing blind on a distance/direction guess, then nudging `flip` or the
number afterward and watching the rebuild. A live preview (even a simple
translucent prism following the dialog's current distance/flip/mode, before
the feature is added to the document) would close this gap and matches how
the dialog already tracks live state (`extrudeDialog`) that the viewport could
read.

### 5. No direct-manipulation distance control
Distance is a plain text input — no drag handle/gizmo in the viewport to set
it by dragging, and no unit suffix or stepper. Typing exact numbers is fine
for parametric work, but a draggable arrow (common in Fusion 360/Onshape) is
often faster for a rough first pass that gets dimensioned precisely afterward.

### 6. Silent no-ops instead of errors
In `worker.ts:463-466`, if a `remove` extrude resolves to zero target bodies
(e.g. its `targetId` no longer exists, or was never set), the cut tool shape
is just deleted and the feature succeeds with **no error and no visible
effect**. Compare this to the explicit Boolean feature, which validates
overlap and throws a clear message ("Solids don't overlap — nothing to
subtract", `worker.ts:410`) for the equivalent situation. An extrude `remove`
that does nothing should surface the same kind of message rather than
regenerating cleanly while quietly doing nothing.

### 7. No validation on non-positive distance
`resolveDocument` (`document.ts:547`) evaluates the distance expression and
passes it straight through — there's no check for zero or negative values
before it reaches OCCT's `MakePrism`. A degenerate distance likely surfaces as
a raw OCCT exception rather than a friendly "distance must be positive"
message at the point closest to the user's input.

### 8. Full-document rebuild on every distance keystroke
Not unique to extrude, but extrude's distance is probably the single most
frequently tweaked numeric parameter in the app, and every change re-runs
`buildBodies` over the *entire* feature list from scratch (`worker.ts:431`,
no incremental/cached rebuild). On a model with many upstream features this
makes live-typing a distance feel laggy. Debouncing the regen, or caching
unaffected upstream bodies between edits, would benefit extrude editing most
directly even though the fix lives in the regen pipeline rather than in
extrude itself.

## If picking a starting point

Roughly in order of "most everyday value for least architectural risk":

1. **#6 (silent remove no-op → real error)** — small, localized fix in
   `worker.ts`, directly prevents a confusing "nothing happened" experience.
2. **#7 (validate distance > 0)** — small, same kind of localized guard.
3. **#4 (live preview in the dialog)** — biggest UX win; the dialog already
   holds all the state a preview needs, "just" needs a viewport hookup.
4. **#1 (symmetric + up-to-next as additional extents)** — highest leverage
   net-new capability without touching taper/thin/multi-profile's larger
   surface area.
5. **#3 (multi-profile select)** and **#2 (taper/thin)** are the largest
   changes (new selection model / new OCCT calls respectively) and probably
   belong after the above land.
