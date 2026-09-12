// The customisations we make to the stock three.js TransformControls gizmo.
//
// TransformControls draws one widget for every editor that ever used it, so its
// defaults are compromises: pure-RGB arrows, a shaft that only reaches the
// forward arrow, half-circle rotate rings meant to be read three-at-a-time. In
// this app each gizmo is shown alone and in a muted palette, and those defaults
// then read as rendering faults rather than as design. Each function here is one
// such repair, applied to the object `TransformControls.getHelper()` returns.
//
// All of them mutate the gizmo's own geometry or materials in place, which is
// safe: `setupGizmo` clones both per handle and bakes each handle's position,
// rotation and scale INTO its vertices, so touching them affects only this
// instance — and that baking is also why every function here identifies handles
// by their geometry's bounds rather than by their (always-zero) transforms.
//
// Split out of Viewport.tsx so the shape surgery can be unit-tested against a
// real TransformControls without standing up a renderer.

import * as THREE from "three";

/** The muted grey every gizmo is toned toward, so none of them read as the
 *  default pure-RGB three.js widget (see softenGizmo). */
const GIZMO_NEUTRAL = 0xc2cad8;

/** Mute TransformControls' default pure-RGB arrows so the gizmo fits the muted
 *  UI. TransformControls restores each handle's cached base colour/opacity every
 *  frame, so we override that cache (`_color`/`_opacity`) too — not just the live
 *  material — or the softening would be reset on the next render. The invisible
 *  picker handles (already near-zero opacity) just get fainter; hover-highlight
 *  still brightens the active axis from this softened base. */
export function softenGizmo(helper: THREE.Object3D): void {
  const neutral = new THREE.Color(GIZMO_NEUTRAL);
  helper.traverse((o) => {
    const mat = (o as THREE.Mesh).material;
    if (!mat) return;
    for (const raw of Array.isArray(mat) ? mat : [mat]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = raw as any;
      if (!m.color) continue;
      m.transparent = true;
      m.color.lerp(neutral, 0.3);
      m.opacity = m.opacity * 0.82;
      m._color = m.color.clone();
      m._opacity = m.opacity;
    }
  });
}

/** Delete the translate gizmo's backward-pointing Z arrow (and its pick
 *  target), leaving one arrow and the line it grows out of.
 *
 *  TransformControls draws every translate axis twice — an arrow at +0.5 and a
 *  mirrored one at -0.5, with the shaft only spanning the middle. With X and Y
 *  hidden, what's left reads as one arrow on a stick plus a second arrow
 *  stranded on the far side of the handle with nothing joining it, which on an
 *  extrude off a top face is a downward arrow floating under the profile. It
 *  says nothing the forward arrow doesn't: dragging the forward arrow back
 *  through the profile already reaches the other side (as a direction flip with
 *  a positive distance — see emitExtrudeDistance), which is what
 *  verify-extrude-gizmo.mjs pins down.
 *
 *  Removed rather than hidden, because TransformControls re-asserts `visible`
 *  on every handle each frame (the same reason softenGizmo has to stash its
 *  colours) — a one-time `visible = false` would be undone on the next render.
 *
 *  Identified by GEOMETRY, not by `position`: setupGizmo bakes each handle's
 *  offset into its geometry and then resets the object's transform to identity,
 *  so every child reports position (0,0,0) and only the baked bounds say which
 *  side of the origin it sits on. The shaft runs from the origin outwards, so a
 *  centre well below zero is the backward arrow and its picker, nothing else. */
export function dropBackwardArrow(helper: THREE.Object3D): void {
  const doomed: THREE.Object3D[] = [];
  const centre = new THREE.Vector3();
  helper.traverse((o) => {
    const geom = (o as THREE.Mesh).geometry;
    if (o.name !== "Z" || !geom) return;
    if (!geom.boundingBox) geom.computeBoundingBox();
    geom.boundingBox?.getCenter(centre);
    if (centre.z < -0.1) doomed.push(o);
  });
  for (const o of doomed) o.removeFromParent();
}

/** Which world axis a TransformControls handle named "X"/"Y"/"Z" runs along. */
const GIZMO_AXIS_INDEX: Record<string, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };

/** Stretch every translate shaft so it reaches BOTH of its arrows.
 *
 *  TransformControls builds each shaft as `lineGeometry2` — a cylinder half the
 *  axis long, pushed out to span [0, +0.5]. So it meets the forward arrow at
 *  +0.5 and stops dead at the origin, leaving the backward arrow at -0.5
 *  floating with nothing joining it: three arrowheads stranded in space around
 *  the pivot, which reads as a rendering fault rather than a design.
 *
 *  Doubling each shaft and re-centring it spans [-0.5, +0.5]; both arrow bases
 *  sit exactly at ±0.5 (arrowGeometry runs 0 -> 0.1 from there, pointing out),
 *  so the join is exact rather than approximately closed. Safe to mutate the
 *  geometry in place: setupGizmo clones per handle, so this touches only this
 *  gizmo instance.
 *
 *  Applied to whatever mode groups the helper carries. That reaches the SCALE
 *  gizmo's identical half-shafts as well — which is equally right (its handles
 *  also sit at ±0.5) and in any case invisible, since scale mode detaches the
 *  controls entirely in favour of the box gizmo. The rotate rings and the
 *  invisible pickers are excluded by shape, not by name. */
export function joinShaftsToBothArrows(helper: THREE.Object3D): void {
  const size = new THREE.Vector3();
  helper.traverse((o) => {
    const axis = GIZMO_AXIS_INDEX[o.name];
    if (axis === undefined || !(o instanceof THREE.Mesh) || !o.geometry) return;
    const geom = o.geometry;
    if (!geom.boundingBox) geom.computeBoundingBox();
    geom.boundingBox?.getSize(size);
    const along = size.getComponent(axis);
    const across = Math.max(size.getComponent((axis + 1) % 3), size.getComponent((axis + 2) % 3));
    // The shaft is the only handle that is long along its own axis AND hair-thin
    // across it: the arrows and scale cubes are short, the rotate rings are wide,
    // the invisible pick cones are wide, and the drag-helper lines are 1e6 long.
    if (across > 0.05 || along < 0.3 || along > 0.9) return;
    const scale = [1, 1, 1];
    const shift = [0, 0, 0];
    scale[axis] = 2;
    shift[axis] = -0.5;
    geom.applyMatrix4(
      new THREE.Matrix4()
        .makeScale(scale[0], scale[1], scale[2])
        .premultiply(new THREE.Matrix4().makeTranslation(shift[0], shift[1], shift[2])),
    );
    geom.computeBoundingBox();
    geom.computeBoundingSphere();
  });
}

/** Close the rotate gizmo's rings into full circles.
 *
 *  TransformControls draws each axis ring as a HALF torus (`CircleGeometry(0.5,
 *  0.5)` = arc π) and spins it about its own axis every frame so the visible
 *  half faces the camera. That is a sensible default for a three-ring gizmo —
 *  the far halves would just clutter — but here only ONE ring is ever shown (the
 *  axis being rotated about), so the half reads as a broken circle instead of as
 *  an axis of revolution. The invisible picker is already a full torus, so the
 *  half-ring also under-draws where the drag actually works.
 *
 *  The complement is the same half turned π about the ring's own normal, added
 *  as a CHILD of the ring rather than as another handle: children inherit the
 *  pose TransformControls writes onto the handle each frame (including the
 *  camera-facing spin, which a full circle is invariant under, and the
 *  scale-to-1e-10 it uses to hide one) and share its material, so the added half
 *  highlights, softens and hides exactly like the half it completes — while
 *  staying out of the handle list that drives picking and colouring.
 *
 *  The normal is read off the geometry rather than the handle's name: setupGizmo
 *  bakes each ring's rotation into its vertices, so the thin axis of its bounds
 *  IS the ring normal (0.015 across the tube against 1.0 across the ring). */
export function closeRotationRings(helper: THREE.Object3D): void {
  for (const { ring, geom, normal } of rotationRings(helper)) {
    const arc = (geom as THREE.TorusGeometry).parameters.arc;
    if (arc > Math.PI * 1.5) continue; // already a full ring
    if (ring.userData.ringHalf) continue; // already completed by an earlier call
    const turn = new THREE.Matrix4().makeRotationAxis(axisVector(normal), Math.PI);
    const other = new THREE.Mesh(geom.clone().applyMatrix4(turn), ring.material);
    other.renderOrder = ring.renderOrder;
    ring.userData.ringHalf = other;
    ring.add(other);
  }
}

/** Half-length of a rotation arrowhead, as a multiple of the ring's tube radius. */
const ROTATION_HEAD_LENGTH = 26;
/** Base radius of a rotation arrowhead, likewise — fat enough against a
 *  hair-thin ring to read as a head, matched to the translate arrows' taper. */
const ROTATION_HEAD_RADIUS = 8;

/** Put a pair of tangential arrowheads on each rotate ring, so the ring says
 *  what it does.
 *
 *  A bare circle is a poor affordance: nothing about it says "drag me round",
 *  and with the translate gizmo one keystroke away — all arrows, obviously
 *  draggable — the rotate ring reads as decoration by comparison. Two heads
 *  lying along the ring's own tangent at opposite ends turn it into the
 *  circular-arrow symbol everyone already knows.
 *
 *  They circulate the SAME way rather than opposing each other. Two heads
 *  pointing at each other across the ring are collinear on screen, which reads
 *  as a translate pair; two circulating heads are anti-parallel and offset, and
 *  read as a turn. The drag itself is bidirectional either way.
 *
 *  Added as children of the ring, for the reasons closeRotationRings gives:
 *  they inherit its per-frame pose and share its material, so they highlight,
 *  soften and hide with it and never enter the picking or colouring passes. */
export function addRotationArrowheads(helper: THREE.Object3D): void {
  for (const { ring, geom, normal } of rotationRings(helper)) {
    if (ring.userData.rotationHeads) continue; // already marked by an earlier call
    const { radius, tube } = (geom as THREE.TorusGeometry).parameters;
    // The ring's plane, as two axes: `u` points at one head, `v` is the tangent
    // there. (u, v, normal) is right-handed, so both heads circulate one way.
    const n = axisVector(normal);
    const u = axisVector(((normal + 1) % 3) as 0 | 1 | 2);
    const v = new THREE.Vector3().crossVectors(n, u);
    const heads = new THREE.Group();
    for (const sign of [1, -1]) {
      // A cone standing on the origin and pointing +Y, swung onto the tangent
      // and carried out to the rim.
      const cone = new THREE.CylinderGeometry(0, tube * ROTATION_HEAD_RADIUS, tube * ROTATION_HEAD_LENGTH, 12);
      cone.translate(0, (tube * ROTATION_HEAD_LENGTH) / 2, 0);
      const tangent = v.clone().multiplyScalar(sign);
      cone.applyMatrix4(
        new THREE.Matrix4().makeRotationFromQuaternion(
          new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent),
        ),
      );
      const at = u.clone().multiplyScalar(radius * sign);
      cone.translate(at.x, at.y, at.z);
      const head = new THREE.Mesh(cone, ring.material);
      head.renderOrder = ring.renderOrder;
      heads.add(head);
    }
    ring.userData.rotationHeads = heads;
    ring.add(heads);
  }
}

/** The unit vector along world axis 0/1/2. */
function axisVector(index: 0 | 1 | 2): THREE.Vector3 {
  return new THREE.Vector3(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0);
}

/** The VISIBLE rotate rings — one per axis — with each one's plane normal.
 *
 *  Identified by shape rather than by name alone, which excludes the invisible
 *  pick torus sharing the same name (a far fatter tube) and the free-rotation
 *  rings (named XYZE/E). The normal is read off the geometry because setupGizmo
 *  bakes each ring's rotation into its vertices: the thin axis of its bounds IS
 *  the ring normal (0.015 across the tube against 1.0 across the ring). */
function rotationRings(helper: THREE.Object3D): { ring: THREE.Mesh; geom: THREE.BufferGeometry; normal: 0 | 1 | 2 }[] {
  const size = new THREE.Vector3();
  const out: { ring: THREE.Mesh; geom: THREE.BufferGeometry; normal: 0 | 1 | 2 }[] = [];
  helper.traverse((o) => {
    if (GIZMO_AXIS_INDEX[o.name] === undefined || !(o instanceof THREE.Mesh) || !o.geometry) return;
    const geom = o.geometry;
    if (geom.type !== "TorusGeometry") return;
    const params = (geom as THREE.TorusGeometry).parameters;
    if (params?.arc === undefined || params.tube > 0.05) return; // the pick torus
    if (!geom.boundingBox) geom.computeBoundingBox();
    geom.boundingBox?.getSize(size);
    const normal = size.x <= size.y && size.x <= size.z ? 0 : size.y <= size.z ? 1 : 2;
    out.push({ ring: o, geom, normal });
  });
  return out;
}
