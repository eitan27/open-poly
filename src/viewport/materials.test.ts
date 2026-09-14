import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { buttCaps, createSectionCapTriple, makeBodyMaterial } from "./materials";

describe("makeBodyMaterial", () => {
  it("builds a double-sided, polygon-offset body material of the given colour", () => {
    const m = makeBodyMaterial(0x123456, []);
    expect(m.color.getHex()).toBe(0x123456);
    expect(m.side).toBe(THREE.DoubleSide);
    expect(m.polygonOffset).toBe(true);
  });

  it("SHARES the clippingPlanes array by reference — the whole point of passing it in", () => {
    // Section view mutates one array in place; every material built from it must
    // see the change without being touched again.
    const planes: THREE.Plane[] = [];
    const a = makeBodyMaterial(0xff0000, planes);
    const b = makeBodyMaterial(0x00ff00, planes);
    planes.push(new THREE.Plane(new THREE.Vector3(0, 0, 1), -5));
    expect(a.clippingPlanes).toBe(planes);
    expect(b.clippingPlanes).toBe(planes);
    expect(a.clippingPlanes).toHaveLength(1);
  });
});

describe("buttCaps", () => {
  it("returns the same material it was given (it patches in place)", () => {
    const m = new LineMaterial({ color: 0xffffff });
    expect(buttCaps(m)).toBe(m);
  });

  it("installs a shader patch that discards the round endcap overhang", () => {
    const m = buttCaps(new LineMaterial({ color: 0xffffff }));
    const shader = { fragmentShader: "void main() {\n  gl_FragColor = vec4(1.0);\n}" };
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as never);
    expect(shader.fragmentShader).toContain("discard");
    expect(shader.fragmentShader).toContain("vUv.y");
  });
});

describe("createSectionCapTriple", () => {
  const build = (renderOrder = 1000) =>
    createSectionCapTriple(
      new THREE.BufferGeometry(),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshStandardMaterial(),
      renderOrder,
    );

  it("returns exactly three meshes: the two stencil writers and the visible cap", () => {
    expect(build()).toHaveLength(3);
  });

  it("makes the two stencil passes invisible to colour and depth", () => {
    const [back, front] = build();
    for (const m of [back, front]) {
      const mat = m.material as THREE.Material;
      expect(mat.colorWrite).toBe(false);
      expect(mat.depthWrite).toBe(false);
      expect(mat.stencilWrite).toBe(true);
    }
  });

  it("increments on back faces and decrements on front faces — the clipping-stencil rule", () => {
    const [back, front] = build();
    expect((back.material as THREE.Material).side).toBe(THREE.BackSide);
    expect((front.material as THREE.Material).side).toBe(THREE.FrontSide);
    expect((back.material as THREE.Material).stencilZPass).not.toBe((front.material as THREE.Material).stencilZPass);
  });

  it("claims a strictly increasing 3-slot renderOrder range, so bodies never bleed", () => {
    const [a, b, c] = build(1000);
    expect([a.renderOrder, b.renderOrder, c.renderOrder]).toEqual([1000, 1001, 1002]);
    const next = build(1003);
    expect(next[0].renderOrder).toBeGreaterThan(c.renderOrder);
  });

  it("gives the visible cap the material it was handed", () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0xabcdef });
    const cap = createSectionCapTriple(
      new THREE.BufferGeometry(),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      new THREE.PlaneGeometry(1, 1),
      mat,
      10,
    )[2];
    expect(cap.material).toBe(mat);
  });
});
