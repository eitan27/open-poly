// A whole screw — head, hex socket and thread — as ONE closed polygon mesh,
// built in plain JS with no booleans. The boolean route fused a revolved head
// with a hex prism, cut the socket, then fused on a thread of a thousand
// facets; that last fuse alone was most of a second (more when it had to be
// retried finer), and the head was where it went wrong. Here the pieces are
// stitched along loops they share by construction:
//
//   • the thread (geom/thread.ts) is cut flat where the head starts, and its
//     start cap's outline becomes a HOLE in the head's underside face;
//   • the socket is a hex hole in the head's top face, six wall quads and a
//     floor;
//   • a cosmetic screw is just the revolved profile, socket and all.
//
// Local frame as geom/thread.ts: x = r·cosθ, y = r·sinθ, z = depth along the
// axis (the head at negative depth, the tip at positive).
import { circleStations } from "./circleFacets";
import { orientPolyMesh, type PolyFace, type PolyMesh, type V3 } from "./polyMesh";
import { minorDiameter, snapToThreadGrid, threadMesh, threadSegments, type ThreadSpec } from "./thread";

export interface ScrewMeshSpec {
  /** (radius, depth) from the axis at the head's top. With a thread it is
   *  the head alone, ending back on the axis under the head (or empty for a
   *  hex head or no head); without, it runs on down to the tip. */
  profile: [number, number][];
  hexHead?: { across: number; z0: number; z1: number };
  /** A hex socket into the top face; only its depth (z1 − z0) is used — it
   *  starts wherever the top face actually is. */
  socket?: { across: number; z0: number; z1: number };
  thread?: Omit<ThreadSpec, "segments">;
  /** Facets per thread turn (a multiple of 16); default from the size. */
  segments?: number;
}

/** Radius a polygon on `stations` needs so its sides clear `r` by `margin`. */
const clearRadius = (r: number, n: number, margin: number) => (r + margin) / Math.cos(Math.PI / n);

export function screwMesh(spec: ScrewMeshSpec): PolyMesh {
  const vertices: V3[] = [];
  const faces: PolyFace[] = [];
  const stations = circleStations();
  const n = stations.length;
  const add = (p: V3) => vertices.push(p) - 1;
  const ring = (r: number, z: number) => stations.map((a) => add([r * Math.cos(a), r * Math.sin(a), z]));
  const hexRing = (across: number, z: number) => {
    const R = across / Math.sqrt(3);
    return Array.from({ length: 6 }, (_, k) =>
      add([R * Math.cos((k * Math.PI) / 3), R * Math.sin((k * Math.PI) / 3), z]),
    );
  };
  const quads = (A: number[], B: number[], name: (k: number) => string) => {
    for (let k = 0; k < A.length; k++) {
      const k1 = (k + 1) % A.length;
      faces.push({ loop: [A[k], A[k1], B[k1], B[k]], name: name(k) });
    }
  };

  // --- the thread, its start cap kept aside as the head's hole --------------
  let startLoop: number[] | null = null;
  let zJoin = 0;
  let crest = 0;
  if (spec.thread) {
    const t = spec.thread;
    crest = t.d / 2 + t.offset;
    const N = spec.segments ?? threadSegments(crest);
    zJoin = snapToThreadGrid(t.z0, t.pitch, N);
    const tm = threadMesh({ ...t, segments: N });
    const base = vertices.length;
    vertices.push(...tm.vertices);
    let i = 0;
    for (const f of tm.faces) {
      const loop = f.loop.map((v) => v + base);
      if (f.kind === "start") startLoop = loop;
      else faces.push({ loop, name: f.kind === "end" ? "threadEnd" : `thread${i++}` });
    }
  }

  // --- the head ---------------------------------------------------------------
  // The face the socket goes into.
  let top: PolyFace | null = null;
  if (spec.hexHead) {
    const { across, z0 } = spec.hexHead;
    const z1 = spec.thread ? zJoin : spec.hexHead.z1;
    const A = hexRing(across, z0);
    const B = hexRing(across, z1);
    top = { loop: A, name: "head/top" };
    faces.push(top);
    quads(A, B, (k) => `head/flat${k}`);
    // A cosmetic hex screw's shank: the profile from the seat down, its top
    // ring the hole in the head's underside.
    let hole = startLoop;
    if (!spec.thread) {
      const shank = spec.profile.slice(spec.profile[0][0] === 0 ? 1 : 0);
      shank[0] = [shank[0][0], z1];
      hole = revolve(shank, ring, faces, add, n).first;
    }
    faces.push({ loop: B, holes: hole ? [hole] : [], name: "head/bottom" });
  } else if (spec.profile.length) {
    const prof = spec.profile.map((p) => [...p] as [number, number]);
    if (spec.thread) {
      // The head alone: drop the closing point on the axis, end the last ring
      // where the thread was cut, and make sure that ring's polygon clears
      // the thread's crest (a countersunk head's cone ends at the major
      // diameter, right on it).
      if (prof[prof.length - 1][0] === 0) prof.pop();
      const last = prof[prof.length - 1];
      last[1] = zJoin;
      last[0] = Math.max(last[0], clearRadius(crest, n, 0.02));
    }
    const { last, disc } = revolve(prof, ring, faces, add, n);
    top = disc;
    if (spec.thread) {
      if (!last || !startLoop) throw new Error("screw: the head didn't end in a ring");
      faces.push({ loop: last, holes: [startLoop], name: "seat" });
    }
  } else if (startLoop) {
    // No head: the thread's own start cap is the top.
    top = { loop: startLoop, name: "threadStart" };
    faces.push(top);
  }

  // --- the socket ---------------------------------------------------------------
  if (spec.socket) {
    if (!top) throw new Error("screw: nowhere to put the socket");
    const zt = vertices[top.loop[0]][2];
    const A = hexRing(spec.socket.across, zt);
    const B = hexRing(spec.socket.across, zt + (spec.socket.z1 - spec.socket.z0));
    (top.holes ??= []).push(A);
    quads(A, B, (k) => `socket/flat${k}`);
    faces.push({ loop: B, name: "socket/bottom" });
  }

  const mesh = { vertices, faces };
  orientPolyMesh(mesh);
  return mesh;
}

/** A solid of revolution's faces from a (radius, depth) profile: a disc or
 *  cone where it leaves the axis, quads between rings, a disc or cone where it
 *  returns. Returns the first and last rings when the profile starts / ends
 *  off the axis (left open, for the caller to close), and the disc it started
 *  with, if any. */
function revolve(
  profile: [number, number][],
  ring: (r: number, z: number) => number[],
  faces: PolyFace[],
  add: (p: V3) => number,
  n: number,
): { first: number[] | null; last: number[] | null; disc: PolyFace | null } {
  let first: number[] | null = null;
  let disc: PolyFace | null = null;
  let prev: number[] | null = null; // the ring at profile[i], when off-axis
  if (profile[0][0] > 0) first = prev = ring(profile[0][0], profile[0][1]);
  for (let i = 0; i + 1 < profile.length; i++) {
    const [ra, za] = profile[i];
    const [rb, zb] = profile[i + 1];
    if (ra === 0 && rb === 0) continue;
    if (ra === 0) {
      const B = ring(rb, zb);
      if (Math.abs(zb - za) < 1e-12) {
        disc = { loop: B, name: `s${i}` };
        faces.push(disc);
      } else {
        const apex = add([0, 0, za]);
        for (let k = 0; k < n; k++) faces.push({ loop: [apex, B[(k + 1) % n], B[k]], name: `s${i}/${k}` });
      }
      prev = B;
      continue;
    }
    const A = prev!;
    if (rb === 0) {
      if (Math.abs(zb - za) < 1e-12) faces.push({ loop: A, name: "floor" });
      else {
        const apex = add([0, 0, zb]);
        for (let k = 0; k < n; k++) faces.push({ loop: [A[k], A[(k + 1) % n], apex], name: `s${i}/${k}` });
      }
      prev = null;
      continue;
    }
    if (Math.abs(ra - rb) < 1e-12 && Math.abs(za - zb) < 1e-12) continue;
    const B = ring(rb, zb);
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      faces.push({ loop: [A[k], A[k1], B[k1], B[k]], name: `s${i}/${k}` });
    }
    prev = B;
  }
  return { first, last: prev, disc };
}

/** The largest hex socket (across flats) that fits inside a thread's root
 *  with a wall of `wall` mm — for a set screw, whose socket goes into the
 *  thread's own end. */
export function maxSocketInThread(d: number, pitch: number, offset: number, wall = 0.15): number {
  const root = minorDiameter(d, pitch) / 2 + offset;
  // Corner radius = across / √3, and the root polygon's sides sit a little in.
  return Math.max(0, (root * Math.cos(Math.PI / 32) - wall) * Math.sqrt(3));
}
