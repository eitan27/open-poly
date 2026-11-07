# Open Poly — Assemblies

Plan for assemblies: documents that place **instances** of parts from other
documents and relate them with **mates**, which can then be driven and animated.
Same rules as `PLAN.md`: decisions, gotchas and what's not built — not a changelog.

**Scope of v1:** open-chain mechanisms — hinges, sliders, arms, turntables, gear
trains. **Closed linkages (four-bar, crank-slider) are explicitly out of v1** but
the data model must not preclude them (see "Solver").

---

## Model

**Two document kinds** (built in A0). A record is an assembly iff it has
`StoredDoc.assembly`; there is no separate `kind` field on the record to drift
from it. `doc` stays required and is always an empty `Document` on an
assembly, so the many paths that read `record.doc` need no branch. `DocMeta`
gains `kind?: "assembly"` (absent = part) plus `instanceCount`, derived in
`metaOf`. No migration and no DB version bump. **The hazard:** any path that
rebuilds a record from parts (`{ name, doc }`) drops `assembly` and silently
turns the assembly into an empty part. Every such site in the persistence hook
and the sync engine now carries it, and tests cover the round trips. A new
site must do the same.

- **Document file:** assembly files are envelope version 2, while part files
  are still written as version 1. A build from before assemblies refuses an
  assembly file ("saved by a newer version") instead of importing it as an
  empty part.
- **Sync hash:** `docHash(name, doc, assembly?)` drops an absent `assembly`, so
  every synced part keeps its old hash. An untouched new assembly counts as
  "blank" and stays local until edited, like a starter part.
- **App:** the assembly has its own `useHistory`, and undo/redo route to it.
  While an assembly is open, the part UI stands down: the side panel becomes
  `AssemblyPanel`, the model toolbar is hidden, shortcuts are limited to
  `ASSEMBLY_SHORTCUTS` (undo/redo, views, hints), and agent part ops are refused
  (`DOCUMENT_OPS` in `agent/commands.ts`).
- **Documents dialog:** the All · Parts · Assemblies tabs are remembered in
  localStorage. **Drive-only documents appear on the All tab only,** because
  their kind isn't known until they are downloaded. Putting the kind in the
  Drive file's appProperties would fix this; that's deferred.
- **Thumbnails:** an assembly is captured on the same settle signal as a part,
  which fires once, from the empty part model's regen. A1 needs its own trigger
  (the instances' meshes loaded) or tiles show the empty scene.

```ts
interface AssemblyDoc {
  instances: Instance[];
  mates: Mate[];
  variables: Variable[]; // same Variable type as parts; drives mate values
}

interface Instance {
  id: string;
  name: string; // "Bracket <1>", editable
  source: { docId: string; partId: string }; // partId = "<featureId>" or "<featureId>#<n>" (parts.ts)
  grounded?: boolean; // fixed in world space
  transform: Mat4; // placement for instances NOT positioned by a mate chain
  hidden?: boolean;
  color?: string; // override; default = the part's own colour
}

interface MateConnector {
  // a frame on a part, in PART coordinates
  instanceId: string;
  ref: { kind: "face" | "edge" | "vertex"; name: string; fingerprint?: FaceFingerprint };
  anchor: "center" | "axis" | "point"; // which inferred frame on that entity
  offset?: Mat4; // user nudge (flip, rotate 90°, translate)
}

interface Mate {
  id: string;
  name: string;
  type: "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball";
  a: MateConnector; // parent side
  b: MateConnector; // child side
  values: Record<string, Expr>; // one per free DOF: "rz", "tz", "tx", "ty", "rx", "ry"
  limits?: Record<string, { min?: Expr; max?: Expr }>;
  suppressed?: boolean;
}
```

**An instance is one part, not one document.** A part document can produce
several parts (`ext1`, `ext1#1`, … — `parts.ts`). Inserting a document inserts
one instance per visible part, each independently movable; that's what users
expect when they modelled a gear pair in one file. Insert-a-single-part is an
option in the Insert dialog.

**References are live.** An instance follows the latest saved state of its part
document. Pinning to a version is a later feature (we have no part versions yet).
Rules that fall out of this:

- **No cycles.** v1 assemblies may only insert _part_ documents. Sub-assemblies
  (assembly-in-assembly) are later and need a cycle check at insert time.
- **Missing source** (deleted, or not yet synced from Drive) renders as a
  placeholder bbox with ⚠, never a crash; mates on it are skipped, with ⚠.
- **Deleting a part document that an assembly uses** warns and names the
  assembly. Needs a reverse lookup — store `referencedDocIds` on the assembly's
  `DocMeta` so the check doesn't load every assembly.

---

## Geometry comes from the cache, not the kernel

Assembly rendering and mating need **no OCCT** in the common case. Each part
document's `StoredDoc.meshes` already has the tessellation plus `faceGroups` /
`edgeGroups` with persistent `name`s and analytic `surface` tags. The assembly
loads those meshes once per source part, uploads one `BufferGeometry` per part,
and draws each instance as a `Mesh` sharing that geometry with its own matrix.
Moving, dragging and animating are matrix updates only — this is what makes
animation smooth.

- **Unbuilt sources** (`DocMeta.unbuilt`, came from Drive and never opened):
  regenerate in the kernel worker in the background, write the meshes back into
  that part's record, then show it. The worker currently holds one document's
  state; building a second document must not clobber the active one — either a
  stateless "build this doc, return meshes" message or a second worker. Decide
  in A1.
- **Staleness:** when an assembly opens, compare each source's `updatedAt`
  against what's loaded; when a part is edited in another tab, the existing
  cross-tab doc-change notice can trigger a reload of that source only.
- **Connector frames need more than the mesh has today.** `FaceSurface` is
  `cylinder | disc | annulus` with a radius only. Mating needs each face's
  frame: plane origin + normal, cylinder axis point + direction, circle centre +
  normal for circular edges. Extend the kernel's face/edge tagging to emit these
  (cheap — OCCT has the analytic surface in hand when it tags). Old cached
  meshes lack them → rebuild the source once on first use in an assembly.

---

## Mate connectors (the main UX)

Onshape's model, because it's the one that works: **every mate joins two frames**,
and frames are inferred from what you hover.

- Hovering a face shows candidate connector points: a planar face's centroid,
  a circular edge's centre, a cylinder's axis endpoints/midpoint, a vertex. Snap
  to the nearest; click picks it. The frame's Z is the face normal / cylinder
  axis; X is chosen deterministically (a straight edge of that face if any,
  else world-projected) so the result doesn't flip between rebuilds.
- A small dialog lets the user flip Z, rotate X by 90°, or add an offset — the
  same "Select …" arming vocabulary as the other dialogs, and an armed slot
  must not look filled.
- Connectors are stored by **persistent face/edge name + fingerprint**, so they
  survive part edits the same way chamfer refs do (`topoMatch` fallback). An
  unresolvable connector puts ⚠ on the mate and in the mate list, like a broken
  feature ref.

**Mate types and their free DOFs** (in the connector frame of `a`):

| Mate        | Free DOFs  | Typical use             |
| ----------- | ---------- | ----------------------- |
| Fastened    | —          | bolted together         |
| Revolute    | rz         | hinge, wheel on axle    |
| Slider      | tz         | drawer, piston          |
| Cylindrical | rz, tz     | shaft in bushing        |
| Planar      | tx, ty, rz | part sliding on a table |
| Ball        | rx, ry, rz | ball joint              |

Child placement: `T_b = T_a · C_a · M(values) · C_b⁻¹`, where `C` are the
connector frames in part space and `M` is the mate's motion built from its DOF
values. Ball uses a rotation vector (not Euler angles) so animation through it
doesn't gimbal-lock.

---

## Solver

**v1 is a kinematic tree, solved by composition — no numeric solver.**

1. Grounded instances are roots (the first inserted instance is grounded by
   default, as in Onshape).
2. Mates are edges. BFS from the roots; each mate places its child with the
   formula above. Mate direction (`a` parent, `b` child) is re-oriented as the
   BFS reaches it — the user shouldn't have to pick the "right" order.
3. Instances not reached keep their stored `transform` and can be dragged freely.
4. **A mate that closes a loop** (both ends already placed) is checked, not
   solved: if it's satisfied within tolerance it's fine (redundant), otherwise
   ⚠ "over-constrained — closed loops aren't supported yet". This is exactly the
   seam where the v2 loop solver plugs in.

Pure TypeScript in `src/assembly/solve.ts` with no DOM or kernel deps, so it is
fully vitest-testable (every mate type, BFS re-orientation, loop detection,
limits clamping).

**Dragging** a mated part moves it _along its free DOFs_: project the pointer
drag onto the mate's motion (angle about the axis for revolute, distance along
the axis for slider, plane for planar) and write the resulting value. Limits
clamp. A dragged value that came from a variable/expression is not overwritten —
the drag is refused with the usual "driven by `x`" hint.

**Later — closed loops:** solve all instance poses with Levenberg–Marquardt
over the loop-closing mates' residuals, seeded from the tree solution (so a
mostly-tree assembly converges in a couple of iterations). Assemblies are tiny
(tens of instances), so dense JS is fine.

---

## Mate relations and animation

**Relations** couple two DOF values linearly: gear (`rz_b = −ratio · rz_a`),
rack-and-pinion (`tz_b = r · rz_a`), screw (`tz_b = pitch · rz_a / 2π`). In a
tree these are just evaluated in dependency order after the driver is set; a
relation cycle is an error. Mate values can already be expressions over
assembly variables, which covers ad-hoc couplings for free.

**Animation** (v1): "Animate" on a mate — pick a DOF, from/to (defaulting to
its limits), duration, and once/loop/bounce. It runs on `requestAnimationFrame`,
writing the DOF value into a **transient view state, not the document** (no undo
spam, no autosave per frame); Stop restores the original value. Relations make
one driver move a whole gear train.

Later: a timeline with keyframes over several mates; GIF/video export (reuse
the frame capture in `scripts/tutorial/gif.mjs`, but in-app via
`canvas.captureStream` / a GIF encoder).

---

## UI

**Top bar.** `＋ New` becomes a split button: the main click keeps today's
behaviour (new part — muscle memory and the agent's `new_document` depend on
it), and a ▾ menu offers **Part** and **Assembly**.

**Open dialog.** Tabs **All · Parts · Assemblies** over the existing grid
(default All, remembered in localStorage). Cards get a small kind badge so All
is readable. Suggestion: an assembly card's subtitle reads "4 parts · 3 mates".

**Assembly workspace** is a separate component (`src/assembly/AssemblyWorkspace.tsx`),
not more branches in `App.tsx` (8k lines). It shares the top bar, document
switching, Viewport, view cube, section view and the persistence hook. Its own
toolbar: **Insert**, **Mate** (with a type picker), **Animate**, **Ground**.
Its left panel replaces the feature tree with two lists:

- **Instances** — name, source doc, grounded 📌, hide, colour. Double-click
  opens the source part document (Onshape's "edit part"); coming back reloads
  that source's meshes.
- **Mates** — name, type icon, current values, ⚠ if broken or over-constrained.
  Click to edit; selecting a mate highlights its two connectors.

**Insert dialog:** the Documents grid filtered to parts, with a per-part list
when the document has several. Inserted instances drop at the origin (first,
grounded) or near the camera focus (later), then can be dragged freely before
mating.

**Viewport reuse.** `Viewport.tsx` is built around one document's bodies. The
assembly needs per-body matrices and shared geometry across instances. A0 must
decide between (a) a `transforms` + `sharedGeometry` prop on the existing
Viewport, or (b) extracting its scene/camera/picking core and giving the
assembly a thin viewport of its own. Prefer (a) if the picking code doesn't
assume identity transforms everywhere; check before committing.

**Decided in A0: (a).** The Viewport already poses bodies by matrix during a
transform-gizmo drag (`matrixAutoUpdate = false`, with highlights and outlines
re-posed by the same motion, and hit normals transformed through `matrixWorld`),
so most of the per-instance path exists. A1 adds an optional `matrix` to
`FeatureMesh` and reuses geometry between meshes that share one payload
object. The assembly keeps the single Viewport App already mounts: no second
WebGL context, and no remount when switching between kinds.

---

## Agent / MCP

After the UI exists (the agent drives the same document ops): `new_document`
gains `kind`; `list_documents` reports kind; new tools `insert_instance`,
`add_mate` (connector refs by face name, same as dress-up refs),
`set_mate_value`, `ground_instance`, `animate_mate` (returns a screenshot strip).
`get_scene_summary` on an assembly reports instances, mates, free DOFs and ⚠s.
Add an assembly section to `src/agent/modeling-guide.md`.

---

## Phases

- **A0 — Kind + shell.** _Done (2026-11-07)._ Browser check:
  `scripts/verify-assembly-a0.mjs`. `kind` on records/meta/file export/Drive; New split
  button; Open tabs; an empty assembly workspace that saves, reopens, renames,
  duplicates and syncs. Viewport reuse decision made.
- **A1 — Instances.** Insert dialog; render from cached meshes with shared
  geometry; unbuilt-source build path; free-drag with the existing transform
  gizmo; Instances list (ground, hide, colour, open source); missing-source
  placeholder; stale-source reload; delete-a-used-part warning.
- **A2 — Connectors + mates.** Kernel emits face/edge frames; inferred connector
  hover/snap; the six mate types; tree solver; drag along DOFs; limits; ⚠ for
  broken refs and closed loops. Unit tests for every mate type.
- **A3 — Motion.** Animate dialog; gear / rack-and-pinion / screw relations;
  mate values from variables.
- **A4 — Agent.** The MCP tools above + modeling-guide section.

**Later, roughly in order:** closed-loop solver · sub-assemblies · exploded
views · BOM · interference/collision check (mesh BVH, per frame during
animation) · STEP assembly export/import (needs the XCAF rebuild that also
unblocks `feat/step-assembly-split`) · in-context part editing · version
pinning.

---

## Testing

- `src/assembly/solve.test.ts`: composition per mate type against hand-computed
  poses, BFS order independence, loop detection, limit clamping, relations.
- Connector inference unit-tested on synthetic face frames (no OCCT in Node).
- Playwright harness per phase: make two part docs, make an assembly, insert,
  mate revolute, drag, animate, screenshot before/after — and reload to prove
  the assembly persisted and the references resolved.

## Open questions

- Should a grounded instance be re-movable by its gizmo (Onshape: no — unground
  first)? Proposed: no.
- Mate offsets in the mate dialog vs. only on connectors? Proposed: connectors
  only — one place to look.
- When a source part's part count changes (a cut now splits a body), what
  happens to instances of `ext1#1`? Proposed: instance resolves by partId; a
  vanished partId is a missing source with ⚠.
