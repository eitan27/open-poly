# Open Poly — Assemblies

Assemblies are documents that place **instances** of parts from other
documents and relate them with **mates**, which can then be driven and
animated. Same rules as `PLAN.md`: this file holds the decisions, the gotchas
and what is not built yet. It is not a changelog: git is the record of what
shipped when.

---

## Model

**Two document kinds.** A record is an assembly iff it has
`StoredDoc.assembly`; there is no separate `kind` field on the record to drift
from it. `doc` stays required and is always an empty `Document` on an
assembly, so the many paths that read `record.doc` need no branch. `DocMeta`
has `kind?: "assembly"` (absent = part) plus `instanceCount` and
`referencedDocIds`, derived in `metaOf`. **The hazard:** any path that
rebuilds a record from parts (`{ name, doc }`) drops `assembly` and silently
turns the assembly into an empty part. Every such site in the persistence hook
and the sync engine carries it, and tests cover the round trips. A new site
must do the same.

- **Document file:** assembly files are envelope version 2, part files are
  still written as version 1, so a build from before assemblies refuses an
  assembly file ("saved by a newer version") instead of importing it as an
  empty part.
- **Sync hash:** `docHash(name, doc, assembly?)` drops an absent `assembly`, so
  every synced part keeps its old hash. An untouched new assembly counts as
  "blank" and stays local until edited, like a starter part.
- **App:** the assembly has its own `useHistory`, and undo/redo route to it.
  While an assembly is open the part UI stands down: the side panel becomes
  `AssemblyPanel`, the model toolbar gives way to the assembly's, shortcuts
  are limited to the assembly mode's, and agent part ops are refused
  (`DOCUMENT_OPS` in `agent/commands.ts`).
- **Thumbnails** are captured on `paintSeq` in App: a part bumps it when its
  regen settles, an assembly when every source has loaded (or failed to).

The persisted shape is `src/assembly/types.ts`:

```ts
interface AssemblyDoc {
  instances: Instance[];
  mates: Mate[];
  variables: Variable[]; // the parts' Variable type; meant to drive mate values
}

interface Instance {
  id: string;
  name: string; // "Bracket <1>", editable
  source: { docId: string; partId: string }; // partId = "<featureId>" or "<featureId>#<n>" (parts.ts)
  grounded?: boolean; // fixed in world space
  transform: Mat4; // its placement; for a mated part, the last solved one
  hidden?: boolean;
  color?: number; // 0xRRGGBB override; absent = the part's own colour
}

interface MateConnector {
  instanceId: string;
  ref: { kind: "face" | "edge"; name: string; center?: Vec3; normal?: Vec3 }; // name + fingerprint
  ref2?: ConnectorRef; // a width mate's second face
  anchor: "center" | "start" | "end"; // where along a cylinder or edge
}

interface Mate {
  id: string;
  name: string;
  type: "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball" | "width";
  a: MateConnector;
  b: MateConnector; // values are always b relative to a
  values?: Partial<Record<Dof, string>>; // one per free DOF, text (mm, degrees); absent = 0
  limits?: Partial<Record<Dof, { min?: string; max?: string }>>;
  flip?: boolean; // Z axes aligned instead of opposed (width: the other way round)
  turns?: number; // quarter turns of b about Z
  suppressed?: boolean;
}
```

**An instance is one part, not one document.** A part document can produce
several parts (`ext1`, `ext1#1`, … — `parts.ts`). Inserting a document inserts
one instance per ticked part, each independently movable; that's what users
expect when they modelled a gear pair in one file.

**References are live.** An instance follows the latest saved state of its part
document. Rules that fall out of this:

- **No cycles:** assemblies may only insert _part_ documents.
- **A missing source** (deleted, or not yet synced from Drive) draws nothing;
  its row shows ⚠ with the reason, and its mates are skipped with ⚠.
- **Deleting a part document an assembly uses** warns and names the assembly,
  found through `referencedDocIds` on the assemblies' metas without loading
  them.

---

## Geometry comes from the cache, not the kernel

Assembly rendering and mating need **no OCCT** in the common case. Each part
document's `StoredDoc.meshes` already has the tessellation plus `faceGroups` /
`edgeGroups` with persistent `name`s and analytic `surface` tags. Each
instance's placement is baked into a copy of its part's mesh (`placement.ts`
`placeMesh`, cached per instance and transform), so the Viewport sees ordinary
world-space bodies: picking, highlights, section view and the gizmo's drag
preview work on them unchanged, in the one Viewport App already mounts.

- **Unbuilt sources** (`DocMeta.unbuilt`: came from Drive, never opened) are
  regenerated in the same kernel worker in the background and their meshes
  written back with `putMeshesIfUnchanged`, which writes only if the record's
  `updatedAt` hasn't moved since it was read. The worker's caches are
  content-keyed, and the open model (an assembly's empty part) has nothing to
  clobber.
- **Staleness:** sources are re-checked against `listMeta` on window focus and
  visibility, and only those whose `updatedAt` moved are re-read
  (`useAssemblySources`).
- **Connector frames come from the mesh, not the kernel.** Nearly every round
  wall here is a faceted 96-gon prism (cylinders, extruded circles, revolves),
  so OCCT has no analytic cylinder to report; asking the kernel would miss most
  of what people mate. `frames.ts` fits them from the tessellation:
  - a flat face → area-weighted centroid + normal;
  - a facet cluster → the axis perpendicular to every facet normal, and a
    circle fit to its vertices. A cluster that also holds tangent flats (a
    slot's round end, a fillet) is grown out from the picked facet, and only a
    narrow facet (< 20° of arc) may stand for the wall;
  - a rim's edge chain → a circle, with Z taken from the flat face it bounds;
  - a straight edge → its midpoint and direction.

  So meshes saved before assemblies existed work as they are.

**Not built: per-instance matrices.** Re-baking every moved instance's mesh is
fine for a drag but will be too slow for per-frame animation. The Viewport
already poses bodies by matrix during a gizmo drag (`transformDragPoses`), so
the likely path is an optional `matrix` on `FeatureMesh` plus geometry shared
between instances of one part.

---

## Mates

**A mate is a joint, not a constraint.** This is Onshape's model, not
SolidWorks': each mate holds two frames together and says which motions are
left free, so one Fastened mate makes a rigid joint (in the constraint model
it takes three, each removing some freedom). Mates between the same parts
still combine, through the loop solver (see "Solver"), so three planar mates
holding a box into a corner also work.

**Every mate joins two frames**, inferred from the face or edge picked. Z is
the face normal, cylinder axis or edge direction; X is world X projected onto
the plane, in part coordinates, so it doesn't flip between rebuilds. By
default the two Z axes are opposed, so two faces touch. **Flip** aligns them
and **Rotate 90°** adds quarter turns about Z. A cylinder or edge offers
Middle / Start / End, shown by a ghost marker (ring and Z arrow, drawn through
parts). Connectors are stored by **persistent face/edge name + fingerprint**,
so they survive part edits the way chamfer refs do; an unresolvable one puts
⚠ on the mate.

| Mate        | Free DOFs  | Typical use             |
| ----------- | ---------- | ----------------------- |
| Fastened    | —          | bolted together         |
| Revolute    | rz         | hinge, wheel on axle    |
| Slider      | tz         | drawer, piston          |
| Cylindrical | rz, tz     | shaft in bushing        |
| Planar      | tx, ty, rz | part sliding on a table |
| Ball        | rx, ry, rz | ball joint              |
| Width       | tx, ty, rz | tab centred in a slot   |

DOFs are in the frame of `a`'s connector. Ball uses a rotation vector, not
Euler angles, so motion through it can't gimbal-lock.

**Width** takes two parallel faces on each part. Each pair's connector is the
plane midway between them (`midplaneShape`: normal made canonical so pick
order doesn't matter, origin at the midpoint of the two face centroids),
stored as `ref` + `ref2`. It solves as Planar between the two mid-planes,
except that by default they point the same way (a tab sits in its slot the
way up both were modelled) and Flip turns it over. Paired with a second mate
on the same parts (Width + Planar for a tab in a slot) it goes to the loop
solver.

**Making mates** (`useMates`, `MateDialog`):

- **Picking first.** With no dialog open, clicked faces and edges gather as a
  selection, as in a part document (click one again to drop it; empty space
  or Esc clears them), while the part clicked last keeps the move gizmo. With
  two or more gathered the gizmo is hidden, or its arrows cover the next face.
  Opening a mate fills its slots from them, grouped by part with the part that
  has more picks first. **All or nothing:** if any pick can't go in a slot
  (two faces of one part, more faces than the mate takes, a face nothing
  anchors to, Width without two parallel faces a part), none are used and the
  dialog opens empty with a note. Three faces can start a Width mate.
- **Turned to fit.** When a new mate's slots fill, or its type changes, and it
  would be over-constrained the way it faces (flush ends default to
  touching), the dialog tries Flip and, for Fastened and Slider, the quarter
  turns, and keeps the first that holds. Silently: the mate never existed the
  other way round, so a note pointed at nothing and read as an error; the
  Flip button shows as pressed. A Flip pressed afterwards is respected.
- **One after another.** Once a new mate is complete and holds, clicking
  another face makes it and starts the next (same type) from that face; the
  title counts them and Cancel reads Close. Create makes the mate and closes.

**Not built:**

- Hover candidates: a face showing its snap points (centroid, circle centre,
  axis ends, vertices) before the click.
- Vertex and offset connectors. Today a frame sits only at a face's centre or
  along an edge or axis, so fastening a box into another's corner takes three
  planars rather than one Fastened mate on a vertex.
- An amber ⚠ when a connector was re-found by fingerprint (today it's silent).
- The mates list shows the two parts, not the mate's values, and selecting a
  mate in the list doesn't highlight its connectors outside the Mate dialog.

---

## Solver

**A hybrid: exact composition for the tree, numeric for loops**
(`src/assembly/solve.ts`, `lm.ts`; pure TypeScript, no DOM or kernel).
Plain open chains, which are most assemblies, stay exact and instant; only
the parts a loop joins are solved numerically. Special-casing combinations of
mates on one pair (Planar + perpendicular Planar → Slider, …) was rejected:
closed linkages need the numeric solver anyway.

1. The mate graph gets a WORLD node with an edge to each grounded instance,
   so two grounded instances joined by mates are a loop like any other.
2. It's split into biconnected blocks (Tarjan, on the multigraph, so two
   mates between one pair are a block of their own).
3. Walking out from WORLD (then from the first instance of each ungrounded
   group, at its stored transform), a block that is **one mate** places its
   far end by composition, `T_b = T_a · C_a · M(values) · F · C_b⁻¹` (`C` the
   connector frames, `M` the motion from the DOF values, `F` the face-to-face
   turn plus quarter turns), reversed when reached from `b`.
4. A block with **more than one mate** is a **loop group**, solved
   numerically, anchored at the instance the walk reached it from (and any
   grounded instances in it). Whatever hangs off it is composed again.

**The numeric part.** Each mate becomes residuals that vanish exactly when it
holds: the relative motion `(T_a·C_a)⁻¹ · T_b·C_b·F⁻¹` must have no
translation or rotation in the directions its type forbids (`HELD`).
Rotations use matrix-column differences (zero only at the right orientation,
not at a half turn), scaled by the group's size so they weigh like mm.
Levenberg–Marquardt (numeric Jacobian, dense Cholesky, damping λ·I) solves for
a small motion of each free part about the middle of its connectors. λ·I
takes no step in directions the mates leave free, so the answer is the one
nearest the start, and the start is **where the parts are** (their stored
placements, carried along with the anchor): that's what keeps a linkage on
its branch (elbow up stays up). If that start doesn't converge, the group is
retried from a tree composition of its mates' stored values.

- **Values inside a loop group** only report where the mate is: they're read
  back from the solved poses, and `keepSolved` writes them into the mates on
  every commit, so deleting a mate that turns the loop back into a tree
  doesn't make anything jump. An **expression** drives instead: it becomes a
  residual, which is how a crank angle on a variable turns a four-bar. Limits
  are one-sided residuals, active only when crossed.
- **Conflicts.** Redundant but consistent mates solve to zero and raise
  nothing. If a group can't be satisfied, the latest mate in list order whose
  removal lets the rest hold is flagged "Over-constrained", and the group is
  shown solved without it; if no single mate explains it, every mate left
  unsatisfied is flagged.
- **Cost.** A satisfied group costs one residual evaluation. LM stops once the
  cost stops falling, and the conflict search uses one start per try, since it
  reruns on every solve while a conflict stands.
- **Keeping placements:** every edit that changes what mates hold (add, edit
  or delete a mate, ground, remove an instance) stores the solved placements
  as the instances' own (`keepSolved`), so a part whose mate is deleted stays
  put.

---

## Moving parts

**Dragging a tree-mated part** moves it along its mate's free DOFs: the drag
is projected onto the mate's motion (`valuesForPose`) and written as its
values, clamped to its limits. A revolute (and a planar or cylindrical part in
Rotate mode) gets the rotate gizmo on the mate's own axis; a ball turns about
world X/Y/Z through its centre. A fastened part has no gizmo, and a part a
tree mate positions moves only through that mate. A value that is an
expression is the user's: the drag is refused, with a "set by" hint. Revolute
values unwrap past ±180° from the previous value.

**What else moves** follows Onshape's rule (`drag.ts`): each part mated to the
dragged one stays where it is wherever its mate allows, and only the motion
that mate forbids carries it along, live during the drag. Dragging a base
along a planar mate's plane, or turning it about the plane's normal, slides it
under the part on top; lifting it carries that part up. Parts further along
keep their mates' values and follow their own neighbour; a neighbour whose
value is an expression is carried, not rewritten. Each drag frame re-solves
the assembly with the drag applied, and the preview uses the same rounded
values the release commits, so letting go never jumps.

**Dragging inside a loop group:** the part gets the free gizmo, and the group
is re-solved with a soft pull toward the drag and a far weaker pull holding
each other part where it was (`SolveOptions.goals`), then once more with the
mates alone so they hold exactly. A four-bar's coupler drags the crank and
rocker round as far as their hinges allow. An anchor that nothing holds (not
grounded, not placed by a mate further back) is free in that solve too, so
dragging either of two parts locked together moves both. Pulls are squared,
so a stay 100× weaker than the drag counts 10⁴× less: the lag is under
0.01 mm.

**The Move panel** (`MoveDialog`, `moveReadout.ts`) reads out live while the
gizmo is dragged (1 mm / 5° snap, as in modelling) and takes typed values on
Enter or leaving the field; Esc cancels. A part one tree mate positions shows
that mate's own values (Distance, Angle, Offset, Turn), and typing one sets
the mate. Any other part shows Move X/Y/Z or Angle about the chosen axis: how
far it has moved since it was selected, measured from where the solver
actually put it, so a part in a loop reads what its mates let it do. Typing
one moves it by the difference, through the same path as a drag.

**Not built:** Onshape's "stay where your mate allows" applies one step out
from a tree-dragged part only; parts hanging off a loop group follow their
mates' values. A grounded part can't be moved by its gizmo; unground it first.

---

## Not built yet

**Assembly variables (next, before motion).** A Variables panel in the
assembly's side panel reusing the part document's (`src/ui/VariablesPanel.tsx`,
same `Variable` type, same add/rename/edit and expression behaviour), and
variables usable in mate values and limits with the name autocomplete the
part tools offer. `AssemblyDoc.variables` is stored and migrated, and
`solve(…, scope)` / `mateValues(mate, scope)` already evaluate against a scope;
what's missing is the UI, and `useMates` building that scope from the
assembly's variables (it passes an empty one, so an expression can only use
numbers today).

**Motion.**

- **Relations** couple two DOF values linearly: gear
  (`rz_b = −ratio · rz_a`), rack-and-pinion (`tz_b = r · rz_a`), screw
  (`tz_b = pitch · rz_a / 2π`). In a tree they're evaluated in dependency
  order after the driver is set, and a relation cycle is an error; inside a
  loop group a relation is one more residual.
- **Animate** on a mate: pick a DOF, from/to (defaulting to its limits),
  duration, and once/loop/bounce. It runs on `requestAnimationFrame`, writing
  the value into **transient view state, not the document** (no undo spam, no
  autosave per frame), and Stop restores the original. Relations make one
  driver move a whole gear train. Needs the per-instance matrices above.
- Later: a timeline with keyframes over several mates; GIF/video export (the
  frame capture in `scripts/tutorial/gif.mjs`, in-app via
  `canvas.captureStream` or a GIF encoder).

**Agent / MCP** (the agent drives the same document ops): `new_document` gains
`kind`; `list_documents` reports kind; new tools `insert_instance`, `add_mate`
(connector refs by face name, as dress-up refs are), `set_mate_value`,
`ground_instance`, `animate_mate` (returns a screenshot strip).
`get_scene_summary` on an assembly reports instances, mates, free DOFs and
⚠s. An assembly section in `src/agent/modeling-guide.md`.

**Smaller gaps.**

- Drive-only documents appear on the Open dialog's All tab only, since their
  kind isn't known until downloaded. The kind in the Drive file's
  `appProperties` would fix it.
- The assembly UI lives in `App.tsx`'s assembly branches. Extracting an
  `AssemblyWorkspace` component was planned and not done.
- An assembly card's subtitle could read "4 parts · 3 mates"; it gives the
  part count only.

**Later, roughly in order:** sub-assemblies (need a cycle check at insert) ·
exploded views · BOM · interference/collision check (mesh BVH, per frame
during animation) · STEP assembly export/import (needs the XCAF rebuild that
also unblocks `feat/step-assembly-split`) · in-context part editing · version
pinning (parts have no versions yet).

---

## Testing

- Unit tests in `src/assembly/`: `solve.test.ts` (composition per mate type,
  order independence, limits), `loops.test.ts` (box in a corner by three
  planars, Width + Planar, a four-bar turned a full revolution and dragged by
  its coupler, a slider-crank, conflicts, locked parts dragged from either
  side), `drag.test.ts`, `frames.test.ts` (connector fitting on synthetic
  meshes, no OCCT in Node), `moveReadout.test.ts`.
- Browser checks in `scripts/verify-assembly-*.mjs` (`a0`, `a1`, `a2`, `drag`,
  `width`, `loops`, `move`), against `npm run dev`; set `PW_EXE` to use a
  pre-installed Chromium. **`a0` fails two steps** ("＋ New makes a part
  again" and the agent step after it), and has since before the loop solver;
  not yet looked into. `verify-all` doesn't run the assembly checks.

## Open questions

- Mate offsets in the Mate dialog, or only on connectors (one place to look)?
  Proposed: connectors only.
- When a source part's part count changes (a cut splits a body), what happens
  to instances of `ext1#1`? Proposed: an instance resolves by `partId`; a
  vanished `partId` is a missing source with ⚠.
- Should the Mate dialog say when a mate sits in a loop group, where its typed
  plain values only report? A one-line note would do.
