// Geometry queries that back picking: turning a kernel mesh into three.js
// buffers, choosing which of several ray hits the cursor actually meant, and
// deciding what counts as a real edge or vertex on a tessellated body.
//
// Split out of Viewport.tsx because none of it closes over component state —
// and because the rules here (a 96-gon rim exposes no vertices; a face boundary
// is an edge whose every vertex sits on the face) are exactly the kind that go
// quietly wrong and are cheap to pin down in a test.

import * as THREE from "three";
import { syncGeometries } from "replicad-threejs-helper";
import type { MeshedEdges, MeshedFaces } from "../kernel/types";

/** Build a body's three.js geometry from a meshed payload. Wraps replicad's
 *  `syncGeometries`, then re-sets the index: our mesh indices are `Uint32Array`
 *  (so the mesh transfers from the worker as a raw ArrayBuffer copy), but
 *  `BufferGeometry.setIndex` only auto-wraps plain `number[]` — a typed array is
 *  assigned raw and won't render, so we install it as a proper `BufferAttribute`. */
export function syncBodyGeometry(name: string, faces: MeshedFaces, edges: MeshedEdges) {
  // The helper types its input as `number[]` buffers; at runtime it feeds them to
  // Float32BufferAttribute/setIndex, which accept typed arrays too. Cast past the
  // narrow types (we fix the one case it can't handle — a typed index — below).
  const meshes = [{ name, faces, edges }] as unknown as Parameters<typeof syncGeometries>[0];
  const [geometry] = syncGeometries(meshes, []);
  const tri = faces.triangles;
  if (ArrayBuffer.isView(tri)) geometry.faces.setIndex(new THREE.BufferAttribute(tri as Uint32Array, 1));
  return geometry;
}

/**
 * The intersection whose point is nearest the cursor **in pixels**, ignoring
 * hits beyond `maxDistance` (depth).
 *
 * Three.js sorts intersections by ray depth, and a sketch is planar: every
 * segment within the raycaster's world-space Line threshold comes back at the
 * *same* distance, so the sort is a tie and the array keeps buffer order.
 * Taking `[0]` therefore returns an arbitrary segment near the cursor rather
 * than the one under it — on a tessellated entity (circle, arc, spline, text)
 * typically a whole chord away. That gap then failed the EDGE_PICK_PX gate and
 * made circle rims unselectable, while straight lines (one long segment, no
 * neighbours) kept working.
 */
export function nearestHitInPixels(
  hits: THREE.Intersection[],
  toPx: (p: THREE.Vector3) => { x: number; y: number },
  clientX: number,
  clientY: number,
  maxDistance = Infinity,
): { hit: THREE.Intersection; px: number } | null {
  let best: THREE.Intersection | null = null;
  let bestPx = Infinity;
  for (const h of hits) {
    if (h.distance > maxDistance) continue;
    const p = toPx(h.point);
    const px = Math.hypot(p.x - clientX, p.y - clientY);
    // Exact ties happen at a shared vertex between two segments — prefer the
    // nearer one so an overlapping sketch in front still wins.
    if (px < bestPx || (px === bestPx && best !== null && h.distance < best.distance)) {
      bestPx = px;
      best = h;
    }
  }
  return best ? { hit: best, px: bestPx } : null;
}

export const posKey = (x: number, y: number, z: number) =>
  `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;

/**
 * Returns the [start, count] vertex ranges (into the edge geometry) of every
 * body edge that bounds the given face. An edge is a boundary of the face when
 * all of its tessellation vertices coincide (by rounded position) with the
 * face's triangle vertices. Exact for straight box edges; curved edges on
 * curved faces are a known limitation (face/edge tessellations differ).
 */
export function faceBoundaryEdges(
  faceGeom: THREE.BufferGeometry,
  edgeGeom: THREE.BufferGeometry,
  faceIds: Set<number>,
): [number, number][] {
  const fg = faceGeom.userData.faceGroups as { faceId: number }[] | undefined;
  const eg = edgeGeom.userData.edgeGroups as { start: number; count: number; edgeId: number }[] | undefined;
  if (!fg || !eg) return [];

  // Collect the rounded positions of every vertex used by the selected face(s)'
  // triangles. For a logical cylinder this is the whole facet cluster, so an edge
  // "on the face" means on the cluster — the facet seams between them are already
  // filtered out of the edge mesh, leaving just the real boundary (the rim rings).
  const faceVerts = new Set<string>();
  const fpos = faceGeom.getAttribute("position");
  const index = faceGeom.getIndex();
  fg.forEach((g, gi) => {
    if (!faceIds.has(g.faceId)) return;
    const grp = faceGeom.groups[gi];
    if (!grp) return;
    for (let i = grp.start; i < grp.start + grp.count; i++) {
      const v = index ? index.getX(i) : i;
      faceVerts.add(posKey(fpos.getX(v), fpos.getY(v), fpos.getZ(v)));
    }
  });

  const epos = edgeGeom.getAttribute("position");
  const ranges: [number, number][] = [];
  for (const e of eg) {
    let onFace = true;
    for (let v = e.start; v < e.start + e.count; v++) {
      if (!faceVerts.has(posKey(epos.getX(v), epos.getY(v), epos.getZ(v)))) {
        onFace = false;
        break;
      }
    }
    if (onFace) ranges.push([e.start, e.count]);
  }
  return ranges;
}

type PickEdgeGroup = { start: number; count: number; edgeId: number; chainId?: number };

/**
 * Positions where a tangent chain merely turns the corner between two of its own
 * chords — the interior junctions of a faceted circle, keyed by rounded position.
 *
 * A round wall here is a 96-gon, so a rim is 96 *straight* edges and every chord
 * junction is a genuine OCCT vertex about a millimetre from its neighbours. They
 * are real topologically and meaningless to a user, so they must not be offered
 * as pickable vertices. Cached on the geometry (invalidated when the mesh hands
 * us new edgeGroups) because picking runs on every mouse move.
 */
export function chainInteriorPositions(geom: THREE.BufferGeometry): Set<string> {
  const eg = geom.userData.edgeGroups as PickEdgeGroup[] | undefined;
  if (geom.userData.chainInteriorFor === eg) return geom.userData.chainInterior as Set<string>;
  const pos = geom.getAttribute("position");
  // Count each chain's endpoint positions: an endpoint shared by two chords of
  // the SAME chain is interior to it; one that ends the chain appears once.
  const seen = new Map<string, number>();
  if (eg && pos) {
    for (const g of eg) {
      if (g.chainId === undefined || g.count < 2) continue;
      for (const v of [g.start, g.start + g.count - 1]) {
        const k = `${g.chainId}|${posKey(pos.getX(v), pos.getY(v), pos.getZ(v))}`;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
    }
  }
  const interior = new Set<string>();
  for (const [k, n] of seen) if (n > 1) interior.add(k.slice(k.indexOf("|") + 1));
  geom.userData.chainInterior = interior;
  geom.userData.chainInteriorFor = eg;
  return interior;
}

/**
 * The genuine topological vertex nearest `at` on the edge that segment `hitIndex`
 * belongs to, or null when that edge exposes none.
 *
 * Two things otherwise masquerade as vertices, and together they made circular
 * edges practically unselectable — any click near a rim landed on a "vertex" a
 * fraction of a millimetre away, and vertex outranks edge:
 *   • a truly curved edge (a fillet's arc) is drawn as many chords, so every
 *     interior chord junction looked like an endpoint. Only the ends of the
 *     edge's whole polyline count — the buffer is consecutive pairs, so those
 *     are the group's first and last positions.
 *   • a faceted circle's chords meet tangentially at real vertices, filtered
 *     out by chainInteriorPositions above. A closed rim is one chain with no
 *     ends and therefore exposes no vertices at all, which is right: nothing
 *     there is a corner. The vertical wall seams landing on those same junctions
 *     drop out too, since the test is by position.
 */
export function realVertexNear(geom: THREE.BufferGeometry, hitIndex: number, at: THREE.Vector3): THREE.Vector3 | null {
  const eg = geom.userData.edgeGroups as PickEdgeGroup[] | undefined;
  const pos = geom.getAttribute("position");
  if (!eg || !pos) return null;
  const grp = eg.find((g) => hitIndex >= g.start && hitIndex < g.start + g.count);
  if (!grp) return null;
  const interior = chainInteriorPositions(geom);
  let best: THREE.Vector3 | null = null;
  let bestD = Infinity;
  for (const v of [grp.start, grp.start + grp.count - 1]) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, v);
    if (interior.has(posKey(p.x, p.y, p.z))) continue;
    const d = p.distanceTo(at);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
