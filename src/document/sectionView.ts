// Section view: a view-only cross-section plane a user drags through the model
// to see the interior (Onshape's "Section view"). Deliberately NOT part of
// `Document` — it changes nothing about the geometry (mass properties, export,
// what a downstream feature sees), so it must not enter the timeline or undo
// stack. It lives alongside `doc` in app state and in storage (see
// storage/db.ts's `StoredDoc.sectionView`), the same way `datumVisibility` and
// selection filters are viewport state rather than document state.
import type { PlaneFrameData, SketchPlaneRef, Vec3 } from "./planes";

export interface SectionViewState {
  enabled: boolean;
  ref: SketchPlaneRef;
  /** Signed distance along the ref's own (unflipped) normal. */
  offset: number;
  /** Which half of the model is kept. */
  flip: boolean;
}

export const DEFAULT_SECTION_VIEW: SectionViewState = {
  enabled: false,
  ref: { kind: "datum", id: "plane-front" },
  offset: 0,
  flip: false,
};

/** The resolved, world-space clip plane for a section view: an origin (the
 *  frame's own origin, shifted along its own normal by `offset`) and the
 *  EFFECTIVE normal (the frame's normal, negated when `flip` is set — flip
 *  picks which half is kept, it doesn't move the plane). `offset` is always
 *  measured along the frame's unflipped normal, so dragging stays continuous
 *  across a flip toggle (see Viewport.tsx's on-canvas handle). Pure geometry
 *  — no THREE dependency — shared by both the GPU-clip/cap render sync and
 *  clip-aware picking, so the two can't drift apart. */
export interface ResolvedSectionPlane {
  origin: Vec3;
  normal: Vec3;
}

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

export function resolveSectionPlane(frame: PlaneFrameData, offset: number, flip: boolean): ResolvedSectionPlane {
  const n = normalize(frame.normal);
  const origin: Vec3 = [
    frame.origin[0] + n[0] * offset,
    frame.origin[1] + n[1] * offset,
    frame.origin[2] + n[2] * offset,
  ];
  const normal: Vec3 = flip ? [-n[0], -n[1], -n[2]] : n;
  return { origin, normal };
}

/** Half-space test: is `point` on the KEPT side of a resolved section plane
 *  (or is there no plane at all — section view off)? This is the exact rule
 *  clip-aware picking uses to reject a click that lands on geometry the GPU
 *  clip has visually discarded (BACKLOG.md: "picking must respect the clip"
 *  — otherwise clicking into the opening selects the invisible far face). A
 *  point exactly on the plane counts as kept (a small tolerance, not a
 *  strict >0), matching the GPU clip shader's own boundary. */
export function sectionKeeps(plane: ResolvedSectionPlane | null, point: Vec3, eps = 1e-6): boolean {
  if (!plane) return true;
  const d =
    plane.normal[0] * (point[0] - plane.origin[0]) +
    plane.normal[1] * (point[1] - plane.origin[1]) +
    plane.normal[2] * (point[2] - plane.origin[2]);
  return d >= -eps;
}
