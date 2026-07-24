// Section view: a view-only cross-section plane a user drags through the model
// to see the interior (Onshape's "Section view"). Deliberately NOT part of
// `Document` — it changes nothing about the geometry (mass properties, export,
// what a downstream feature sees), so it must not enter the timeline or undo
// stack. It lives alongside `doc` in app state and in storage (see
// storage/db.ts's `StoredDoc.sectionView`), the same way `datumVisibility` and
// selection filters are viewport state rather than document state.
import type { SketchPlaneRef } from "./planes";

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
