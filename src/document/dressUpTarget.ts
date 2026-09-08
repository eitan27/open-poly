// Picks → the edges/faces a chamfer or fillet would dress. Split out of App.tsx
// (mirroring shellTarget.ts) so the rules can be unit-tested directly, and — the
// reason it moved — so the SAME resolution serves two callers: the live
// selection, and the dress-up dialog's own accumulated pick list. Both must
// agree, because the tangent-chain expansion below is a property of the whole
// set of picks, not of any one click.

import { expandPickToChains } from "../geom/edgeChains";
import { edgeFingerprint, edgeMidpoint, edgeNameOf, faceCentroid, faceNameOf, faceNormal } from "../geom/meshQuery";
import type { MeshedEdges, MeshedFaces } from "../kernel/types";
import type { EdgeRef, FaceRef } from "./types";

/** The parts of a viewport `Selection` this module needs — declared structurally
 *  so `document/` stays framework-free (see shellTarget.ts). A real
 *  `Selection[]` is assignable to `DressUpPick[]`. */
export type DressUpPick =
  | { kind: "edge"; featureId: string; edgeId: number }
  | { kind: "face"; featureId: string; faceId: number }
  | { kind: string };

/** The parts of a `FeatureMesh` this module needs. */
export interface DressUpMesh {
  id: string;
  mesh: { faces: MeshedFaces; edges: MeshedEdges };
}

export interface DressUpTarget {
  targetId: string;
  /** Persistent topological names of every edge to dress (tangent chains included). */
  edges: string[];
  edgeRefs: EdgeRef[];
  faces: string[];
  faceRefs: FaceRef[];
  /** Where to pop the dialog: the edge actually clicked, else the face. */
  anchor: [number, number, number] | null;
}

/** One or more picked body edges and/or FACES, all on the same body — what a
 *  chamfer or fillet would dress. Resolves each to its persistent name. A face
 *  stands for all its boundary edges (the kernel expands it, where the topology
 *  is); that is the practical way to round a circular rim, which is otherwise a
 *  96-chord chain you have to hit exactly with the cursor.
 *
 *  Returns null when the picks don't describe one dressable body: nothing
 *  picked, something other than an edge/face in the list, picks spanning two
 *  bodies, or any edge/face without a stable name. */
export function dressUpTargetFromPicks(
  picks: readonly DressUpPick[],
  meshes: readonly DressUpMesh[],
): DressUpTarget | null {
  const edges = picks.filter((s): s is Extract<DressUpPick, { kind: "edge" }> => s.kind === "edge");
  const faces = picks.filter((s): s is Extract<DressUpPick, { kind: "face" }> => s.kind === "face");
  if (edges.length + faces.length === 0 || edges.length + faces.length !== picks.length) return null;
  const targetId = (edges[0] ?? faces[0]).featureId;
  if (!edges.every((e) => e.featureId === targetId) || !faces.every((f) => f.featureId === targetId)) return null;
  const m = meshes.find((x) => x.id === targetId);
  if (!m) return null;
  // Clicking a rim selects ONE of its 96 chords, but dressing it means the
  // whole curve — so store the picked edge's entire tangent chain. The kernel
  // expands a partial chain anyway and warns that it did ("re-pick the edge to
  // store it afresh"), which fired on every freshly-picked rim; that notice is
  // meant for a STORED selection gone stale after an upstream edit, not for a
  // pick made a moment ago. Storing the chain up front is exactly what it asks
  // for. `chainId` comes from the same mesh data the viewport highlights with,
  // so what gets dressed is what was lit up under the cursor.
  const wanted = expandPickToChains(
    m.mesh.edges.edgeGroups ?? [],
    edges.map((e) => e.edgeId),
  );
  const names: string[] = [];
  const edgeRefs: EdgeRef[] = [];
  for (const edgeId of wanted) {
    const nm = edgeNameOf(m.mesh.edges, edgeId);
    if (!nm) return null; // unnamed edge — can't reference it stably
    names.push(nm);
    // Geometric fingerprint stored alongside the name, so the kernel can
    // re-match the edge if an upstream edit renames it.
    const fp = edgeFingerprint(m.mesh.edges, edgeId);
    edgeRefs.push(fp ? { name: nm, mid: fp.mid, length: fp.length } : { name: nm });
  }
  const faceNames: string[] = [];
  const faceRefs: FaceRef[] = [];
  for (const f of faces) {
    const nm = faceNameOf(m.mesh.faces, f.faceId);
    if (!nm) return null; // unnamed face — same rule as edges
    faceNames.push(nm);
    faceRefs.push({
      name: nm,
      center: faceCentroid(m.mesh.faces, f.faceId) ?? undefined,
      normal: faceNormal(m.mesh.faces, f.faceId) ?? undefined,
    });
  }
  // Where the dialog pops up: by the edge actually clicked (not the chain's
  // first chord, which can be on the far side of the body), else the face.
  const anchor = edges.length
    ? edgeMidpoint(m.mesh.edges, edges[0].edgeId)
    : faceCentroid(m.mesh.faces, faces[0].faceId);
  return { targetId, edges: names, edgeRefs, faces: faceNames, faceRefs, anchor };
}

/** The dress-up targets a set of picks describes — **one per body**, ordered by
 *  when each body was first picked.
 *
 *  A dress-up feature dresses a single body: its `targetId`, whose edges are
 *  resolved against that body's own name table (an edge name from another body
 *  means nothing there). So picks spanning several bodies aren't a single
 *  feature — they fan out into one feature per body, sharing the dialog's size
 *  and angle, exactly as a multi-profile Extrude fans out into one extrude per
 *  profile.
 *
 *  All-or-nothing: if any body's picks can't be resolved (an unnamed edge, a
 *  missing mesh), the whole list is empty rather than quietly dressing fewer
 *  bodies than were picked. */
export function dressUpTargetsFromPicks(
  picks: readonly DressUpPick[],
  meshes: readonly DressUpMesh[],
): DressUpTarget[] {
  const byBody = new Map<string, DressUpPick[]>();
  for (const p of picks) {
    const id = dressUpPickBody(p);
    if (id === null) return []; // something that isn't an edge or a face
    const group = byBody.get(id);
    if (group) group.push(p);
    else byBody.set(id, [p]);
  }
  const targets: DressUpTarget[] = [];
  for (const group of byBody.values()) {
    const t = dressUpTargetFromPicks(group, meshes);
    if (!t) return [];
    targets.push(t);
  }
  return targets;
}

/** The body a dress-up pick belongs to, or null if it isn't an edge/face pick.
 *  Used by the dialog's click router to refuse a pick on a second body. */
export function dressUpPickBody(pick: DressUpPick): string | null {
  return (pick.kind === "edge" || pick.kind === "face") && "featureId" in pick ? pick.featureId : null;
}

/** Add a pick to the dialog's list, or remove it if the same edge/face is
 *  already there — clicking an armed edge again un-arms it, matching how the
 *  boolean dialog's tools and the shell dialog's faces behave. */
export function toggleDressUpPick<T extends DressUpPick>(picks: readonly T[], pick: T): T[] {
  const same = (a: DressUpPick, b: DressUpPick) =>
    a.kind === b.kind &&
    "featureId" in a &&
    "featureId" in b &&
    a.featureId === b.featureId &&
    (a.kind === "edge" && b.kind === "edge"
      ? a.edgeId === b.edgeId
      : a.kind === "face" && b.kind === "face"
        ? a.faceId === b.faceId
        : false);
  const at = picks.findIndex((p) => same(p, pick));
  return at === -1 ? [...picks, pick] : picks.filter((_, i) => i !== at);
}

/** Fold a list of targets so each body appears once, its edges and faces
 *  unioned in order. Re-opening a dress-up carries its stored targets, and a
 *  fresh pick on a body it already dresses should ADD to that body's list, not
 *  dress it twice (the kernel would then chamfer an edge that no longer
 *  exists). Names are deduped alongside their fingerprints. */
export function mergeDressUpTargets(targets: readonly DressUpTarget[]): DressUpTarget[] {
  const out: DressUpTarget[] = [];
  for (const t of targets) {
    const at = out.findIndex((x) => x.targetId === t.targetId);
    if (at === -1) {
      out.push({
        ...t,
        edges: [...t.edges],
        edgeRefs: [...t.edgeRefs],
        faces: [...t.faces],
        faceRefs: [...t.faceRefs],
      });
      continue;
    }
    const acc = out[at];
    for (let i = 0; i < t.edges.length; i++) {
      if (acc.edges.includes(t.edges[i])) continue;
      acc.edges.push(t.edges[i]);
      if (t.edgeRefs[i]) acc.edgeRefs.push(t.edgeRefs[i]);
    }
    for (let i = 0; i < t.faces.length; i++) {
      if (acc.faces.includes(t.faces[i])) continue;
      acc.faces.push(t.faces[i]);
      if (t.faceRefs[i]) acc.faceRefs.push(t.faceRefs[i]);
    }
    acc.anchor = acc.anchor ?? t.anchor;
  }
  return out;
}
