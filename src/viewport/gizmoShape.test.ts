import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  addRotationArrowheads,
  closeRotationRings,
  dropBackwardArrow,
  joinShaftsToBothArrows,
  softenGizmo,
} from "./gizmoShape";

/** A real TransformControls, built headless. It only needs a camera and an
 *  element to listen on, so the whole stock gizmo — the thing these functions
 *  operate on — is available without a renderer. Using the real one on purpose:
 *  a hand-rolled stand-in would keep passing if three.js changed its gizmo. */
function stockGizmo(): THREE.Object3D {
  const camera = new THREE.PerspectiveCamera();
  const element = { addEventListener() {}, removeEventListener() {}, style: {} } as unknown as HTMLElement;
  return new TransformControls(camera, element).getHelper();
}

/** Every mesh handle named "X"/"Y"/"Z" whose geometry looks like a translate or
 *  scale shaft: long along its own axis, hair-thin across it. */
function shafts(helper: THREE.Object3D): { axis: number; box: THREE.Box3 }[] {
  const out: { axis: number; box: THREE.Box3 }[] = [];
  const index: Record<string, number> = { X: 0, Y: 1, Z: 2 };
  helper.traverse((o) => {
    const axis = index[o.name];
    if (axis === undefined || !(o instanceof THREE.Mesh)) return;
    o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    const along = size.getComponent(axis);
    const across = Math.max(size.getComponent((axis + 1) % 3), size.getComponent((axis + 2) % 3));
    if (across < 0.05 && along > 0.3 && along < 1.9) out.push({ axis, box });
  });
  return out;
}

/** The visible rotate rings: torus handles named for an axis. */
function rings(helper: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  helper.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !["X", "Y", "Z"].includes(o.name)) return;
    if (o.geometry.type === "TorusGeometry" && (o.geometry as THREE.TorusGeometry).parameters.radialSegments === 3) {
      out.push(o);
    }
  });
  return out;
}

describe("gizmo shape surgery", () => {
  let helper: THREE.Object3D;
  beforeEach(() => {
    helper = stockGizmo();
  });

  describe("joinShaftsToBothArrows", () => {
    it("finds stock shafts reaching only the forward arrow — the bug being fixed", () => {
      const found = shafts(helper);
      expect(found.length).toBeGreaterThan(0);
      for (const { axis, box } of found) {
        expect(box.min.getComponent(axis)).toBeCloseTo(0, 5); // stops dead at the origin
        expect(box.max.getComponent(axis)).toBeCloseTo(0.5, 5);
      }
    });

    it("stretches every shaft to span both arrows, on all three axes", () => {
      joinShaftsToBothArrows(helper);
      const found = shafts(helper);
      expect(found.length).toBeGreaterThan(0);
      const axesTouched = new Set(found.map((f) => f.axis));
      expect([...axesTouched].sort()).toEqual([0, 1, 2]); // not just the single-axis case
      for (const { axis, box } of found) {
        // The arrow bases sit at ±0.5, so the join is exact at both ends.
        expect(box.min.getComponent(axis)).toBeCloseTo(-0.5, 5);
        expect(box.max.getComponent(axis)).toBeCloseTo(0.5, 5);
      }
    });

    it("leaves the rotate rings alone", () => {
      const before = rings(helper).map((m) => m.geometry.getAttribute("position").count);
      joinShaftsToBothArrows(helper);
      expect(rings(helper).map((m) => m.geometry.getAttribute("position").count)).toEqual(before);
    });
  });

  describe("closeRotationRings", () => {
    it("finds stock rings drawn as half circles — the bug being fixed", () => {
      const found = rings(helper);
      expect(found.length).toBe(3);
      for (const m of found) expect((m.geometry as THREE.TorusGeometry).parameters.arc).toBeCloseTo(Math.PI, 5);
    });

    it("completes each ring with its other half, as a child that inherits the pose", () => {
      closeRotationRings(helper);
      for (const ring of rings(helper)) {
        expect(ring.children.length).toBe(1);
        const half = ring.children[0] as THREE.Mesh;
        expect(half.material).toBe(ring.material); // so it highlights and softens with it
        // Together the two halves cover the whole circle: the pair reaches the
        // full radius (plus the tube) on BOTH sides of centre in the ring's
        // plane, where one half alone only reaches one side.
        const { radius, tube } = (ring.geometry as THREE.TorusGeometry).parameters;
        const reach = radius + tube;
        const own = ring.geometry.boundingBox ?? ring.geometry.computeBoundingBox() ?? ring.geometry.boundingBox!;
        const box = new THREE.Box3().setFromObject(ring);
        const size = box.getSize(new THREE.Vector3());
        const thin = [0, 1, 2].sort((a, b) => size.getComponent(a) - size.getComponent(b))[0];
        let completed = 0;
        for (const i of [0, 1, 2]) {
          if (i === thin) continue;
          expect(box.min.getComponent(i)).toBeCloseTo(-reach, 4);
          expect(box.max.getComponent(i)).toBeCloseTo(reach, 4);
          // …and exactly one of those two directions was short before.
          if (Math.abs(own!.min.getComponent(i)) < reach - 1e-6 || own!.max.getComponent(i) < reach - 1e-6) completed++;
        }
        expect(completed).toBe(1);
      }
    });

    it("is a no-op on a gizmo whose rings are already whole", () => {
      closeRotationRings(helper);
      closeRotationRings(helper); // the added halves must not themselves be doubled
      for (const ring of rings(helper)) expect(ring.children.length).toBe(1);
    });
  });

  describe("addRotationArrowheads", () => {
    it("puts two heads on each ring, tangential and at opposite ends", () => {
      addRotationArrowheads(helper);
      for (const ring of rings(helper)) {
        const { radius } = (ring.geometry as THREE.TorusGeometry).parameters;
        const group = ring.children.find((c) => c.type === "Group");
        expect(group?.children.length).toBe(2);
        const centres = group!.children.map((h) => {
          const g = (h as THREE.Mesh).geometry;
          g.computeBoundingBox();
          return g.boundingBox!.getCenter(new THREE.Vector3());
        });
        // Diametrically opposite, both sitting ON the rim.
        expect(centres[0].clone().add(centres[1]).length()).toBeCloseTo(0, 4);
        for (const c of centres) expect(c.length()).toBeGreaterThan(radius * 0.9);
        for (const h of group!.children) expect((h as THREE.Mesh).material).toBe(ring.material);
      }
    });

    it("points each head along the ring, not across it — that is what reads as a turn", () => {
      addRotationArrowheads(helper);
      for (const ring of rings(helper)) {
        const group = ring.children.find((c) => c.type === "Group")!;
        const head = group.children[0] as THREE.Mesh;
        head.geometry.computeBoundingBox();
        const box = head.geometry.boundingBox!;
        const centre = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        // The cone's long axis is the one it spans furthest along; tangential
        // means that axis is perpendicular to the spoke out to its own centre.
        const longest = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a))[0];
        const along = new THREE.Vector3().setComponent(longest, 1);
        expect(Math.abs(along.dot(centre.clone().normalize()))).toBeLessThan(0.2);
      }
    });

    it("does not double up when called twice", () => {
      addRotationArrowheads(helper);
      addRotationArrowheads(helper);
      for (const ring of rings(helper)) {
        expect(ring.children.filter((c) => c.type === "Group").length).toBe(1);
      }
    });

    it("leaves the invisible pick torus alone, so the grab area is unchanged", () => {
      let pickers = 0;
      helper.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || !["X", "Y", "Z"].includes(o.name)) return;
        if (o.geometry.type !== "TorusGeometry") return;
        if ((o.geometry as THREE.TorusGeometry).parameters.tube > 0.05) {
          pickers++;
          expect(o.children.length).toBe(0);
        }
      });
      addRotationArrowheads(helper);
      expect(pickers).toBeGreaterThan(0);
      helper.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || o.geometry.type !== "TorusGeometry") return;
        if ((o.geometry as THREE.TorusGeometry).parameters.tube > 0.05) expect(o.children.length).toBe(0);
      });
    });
  });

  it("softenGizmo tones the arrows toward the neutral grey and stashes the result", () => {
    const arrow = shafts(helper)[0];
    expect(arrow).toBeTruthy();
    softenGizmo(helper);
    let checked = 0;
    helper.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (!mat?.color || o.name !== "X") return;
      // Pure red would be (1,0,0); toned toward the grey it can't be.
      if (mat.opacity > 0) checked++;
      expect(mat.color.g).toBeGreaterThan(0);
    });
    expect(checked).toBeGreaterThan(0);
  });

  it("dropBackwardArrow removes the stranded Z arrow, leaving the forward one", () => {
    const zHandles = () => {
      let n = 0;
      helper.traverse((o) => {
        if (o.name === "Z" && o instanceof THREE.Mesh) n++;
      });
      return n;
    };
    const before = zHandles();
    dropBackwardArrow(helper);
    expect(zHandles()).toBeLessThan(before);
  });
});
