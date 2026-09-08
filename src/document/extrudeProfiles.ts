// Picks → the profiles an Extrude can consume. Split out of App.tsx (mirroring
// dressUpTarget.ts) so the same resolution serves two callers — the live
// selection, and the extrude dialog's own accumulated pick list — and so it can
// be unit-tested without React.
//
// Why the whole set matters: sketch EDGES only become a profile when, together,
// they enclose a region (`regionsEnclosedBy`). That is a property of the
// accumulated picks, so resolving click-by-click would quietly lose it.

import { faceCentroid, faceNameOf, faceNormal } from "../geom/meshQuery";
import type { MeshedEdges, MeshedFaces } from "../kernel/types";
import { regionsEnclosedBy } from "./regions";
import type { Document, ExtrudeProfile } from "./types";

/** The parts of a viewport `Selection` this module needs — declared structurally
 *  so `document/` stays framework-free (see shellTarget.ts). */
export type ExtrudePick =
  | { kind: "sketchFace"; sketchId: string; regionId: string }
  | { kind: "sketchEntity"; sketchId: string; entityId: string }
  | { kind: "face"; featureId: string; faceId: number }
  | { kind: string };

/** The parts of a `FeatureMesh` this module needs. */
export interface ExtrudeMesh {
  id: string;
  mesh: { faces: MeshedFaces; edges: MeshedEdges };
}

/** Every profile an Extrude could consume from these picks: sketch regions,
 *  planar faces of existing bodies, sketch text, or sketch edges that fully
 *  enclose a region (so a tiny/fiddly-to-click face can be picked by its
 *  boundary instead). One dialog fill-in extrudes or cuts all of them at once. */
export function extrudeProfilesFromPicks(
  picks: readonly ExtrudePick[],
  doc: Document,
  meshes: readonly ExtrudeMesh[],
): ExtrudeProfile[] {
  const profiles: ExtrudeProfile[] = [];
  const regionKeys = new Set<string>(); // dedupe sketchId/regionId across pick kinds
  const addRegion = (sketchId: string, regionId: string) => {
    const key = `${sketchId}/${regionId}`;
    if (regionKeys.has(key)) return;
    regionKeys.add(key);
    profiles.push({ kind: "sketchRegion", sketchId, regionId });
  };
  const pickedEntitiesBySketch = new Map<string, Set<string>>();
  for (const s of picks) {
    if (s.kind !== "sketchEntity" || !("entityId" in s)) continue;
    let ids = pickedEntitiesBySketch.get(s.sketchId);
    if (!ids) pickedEntitiesBySketch.set(s.sketchId, (ids = new Set()));
    ids.add(s.entityId);
  }
  for (const [sketchId, ids] of pickedEntitiesBySketch) {
    const sk = doc.features.find((f) => f.id === sketchId);
    if (sk?.type !== "sketch") continue;
    for (const region of regionsEnclosedBy(sk.entities, ids)) addRegion(sketchId, region.id);
    // A picked text entity extrudes on its own (the kernel bakes its glyph
    // wires with counters/holes) — no enclosing region needed.
    for (const id of ids) {
      const ent = sk.entities.find((e) => e.id === id);
      if (ent?.type === "text" && ent.value.trim()) profiles.push({ kind: "sketchText", sketchId, textId: id });
    }
  }
  for (const s of picks) {
    if (s.kind === "sketchFace" && "regionId" in s) {
      addRegion(s.sketchId, s.regionId);
    } else if (s.kind === "face" && "faceId" in s) {
      const m = meshes.find((x) => x.id === s.featureId);
      const center = m ? faceCentroid(m.mesh.faces, s.faceId) : null;
      if (!center) continue;
      const faceName = m ? faceNameOf(m.mesh.faces, s.faceId) : undefined;
      const normal = (m && faceNormal(m.mesh.faces, s.faceId)) || undefined;
      profiles.push({ kind: "bodyFace", featureId: s.featureId, faceId: s.faceId, faceName, center, normal });
    }
  }
  return profiles;
}

/** True when this pick is one an Extrude can do something with — the dialog
 *  refuses anything else and keeps its arming live. */
export function isExtrudePick(pick: ExtrudePick): boolean {
  return pick.kind === "sketchFace" || pick.kind === "sketchEntity" || pick.kind === "face";
}

/** Add a pick to the dialog's list, or remove it if it's already there (the
 *  toggle rule shared by every accumulating slot). */
export function toggleExtrudePick<T extends ExtrudePick>(picks: readonly T[], pick: T): T[] {
  const key = (p: ExtrudePick): string =>
    p.kind === "sketchFace" && "regionId" in p
      ? `r:${p.sketchId}/${p.regionId}`
      : p.kind === "sketchEntity" && "entityId" in p
        ? `e:${p.sketchId}/${p.entityId}`
        : p.kind === "face" && "faceId" in p
          ? `f:${p.featureId}/${p.faceId}`
          : `?:${p.kind}`;
  const k = key(pick);
  const at = picks.findIndex((p) => key(p) === k);
  return at === -1 ? [...picks, pick] : picks.filter((_, i) => i !== at);
}
