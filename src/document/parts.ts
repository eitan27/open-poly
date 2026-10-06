// Parts, and how they relate to features.
//
// A feature used to BE a part: one feature, one body, and the body's colour,
// opacity, hidden flag and name were the feature's own fields. That broke as
// soon as one feature could produce several disjoint solids — three regions
// extruded in one go, a cut that severs a bar, a pattern's copies. The kernel
// now splits any disconnected result into one part per solid (splitPartsPass),
// and this module is how the document talks about them.
//
// The id scheme is chosen so nothing had to be migrated: the FIRST lump keeps
// the feature's own id, so every reference already written down — a chamfer's
// targetId, a boolean operand, a saved document — still names it. Only the
// second and later lumps take a suffix.
//
//    Extrude 1  ->  "ext1"      the feature id, as before
//                   "ext1#1"    its second part
//                   "ext1#2"    its third
//
// Appearance follows the same split: lump 0 reads and writes the feature's
// fields (unchanged behaviour, unchanged serialisation), and the sub-parts live
// in `doc.parts`, an optional map that old documents simply don't have.

import { siblingBodyColor } from "./colors";
import type { Document, Feature, PartOverride, PlaneFeature } from "./types";

/** A feature that produces a body of its own, and therefore owns that body's
 *  appearance (colour / opacity / hidden). A copy-transform produces a body
 *  keyed by its own id; an in-place transform doesn't (its body keeps the
 *  target's id), so it isn't one of these.
 *
 *  Derived from `Feature` by the presence of `opacity` rather than listed by
 *  hand, because the hand-written list was the thing that went wrong: the same
 *  ten `f.type === …` tests were spelled out in five places and nothing tied
 *  them together. Opacity is the right discriminator and not a coincidence —
 *  only a body can be made translucent. A new body-producing feature kind joins
 *  this type the moment it gains the field, and the compiler then demands it in
 *  `BODY_FEATURE_TYPES` below, which is the one remaining list. */
export type SolidFeature = Extract<Feature, { opacity: number }>;

/** A feature whose visibility can be toggled. The solids, plus reference planes:
 *  a plane is hideable and has a colour, but has no opacity, which is exactly
 *  why it is not a `SolidFeature`. That asymmetry used to show up as one of the
 *  four inlined lists having an extra `|| f.type === "plane"` in it, where it was
 *  indistinguishable from a typo. */
export type HideableFeature = SolidFeature | PlaneFeature;

/** The feature that produced this part. */
export function featureIdOfPart(partId: string): string {
  const i = partId.indexOf("#");
  return i === -1 ? partId : partId.slice(0, i);
}

/** True for the 2nd, 3rd… part of a feature — the ones whose appearance can't
 *  live on the feature, because a sibling part is already using it. */
export function isSubPart(partId: string): boolean {
  return partId.includes("#");
}

/** 0 for a feature's first part, n for `id#n`. */
export function partIndex(partId: string): number {
  const i = partId.indexOf("#");
  return i === -1 ? 0 : Number(partId.slice(i + 1)) || 0;
}

/** Every `SolidFeature["type"]` as a runtime value. Typed as a `Record` over the
 *  union, so the compiler demands every member and rejects anything that isn't
 *  one: the list cannot drift from the type the way five hand-written copies of
 *  it did. The test on `type` (rather than on the presence of `opacity`) is what
 *  the five copies did and is deliberate — a transform feature written by an old
 *  enough version of the app has no `opacity` field until `upgradeDocument`
 *  fills it in. */
const BODY_FEATURE_TYPES: Record<SolidFeature["type"], true> = {
  primitive: true,
  extrude: true,
  boolean: true,
  transform: true,
  mirror: true,
  pattern: true,
  revolve: true,
  sweep: true,
  loft: true,
  import: true,
};

/** Does this feature produce a body of its own — and so own its appearance? A
 *  body modified in place (an Add/Remove extrude, a dress-up, a shell, a non-copy
 *  transform) keeps the id, and therefore the appearance, of the body it
 *  modified. The single source of truth for the question; see `SolidFeature`. */
export function isBodyFeature(f: Feature | undefined): f is SolidFeature {
  return f !== undefined && f.type in BODY_FEATURE_TYPES;
}

/** Can this feature be hidden? See `HideableFeature` for why planes are in and
 *  why they are not body features. */
export function isHideableFeature(f: Feature | undefined): f is HideableFeature {
  return isBodyFeature(f) || f?.type === "plane";
}

export interface PartAppearance {
  name: string;
  color: number;
  opacity: number;
  hidden: boolean;
  /** False when the part's body was produced by a feature that doesn't own an
   *  appearance (it modified someone else's body in place) — the caller renders
   *  it with the default look and doesn't offer to recolour it. */
  owned: boolean;
}

/** How a part should look and read, resolving feature fields, the sub-part
 *  overrides, and the defaults in that order. */
export function partAppearance(doc: Document, partId: string, defaultColor: number): PartAppearance {
  const feature = doc.features.find((f) => f.id === featureIdOfPart(partId));
  const owned = isBodyFeature(feature);
  const base = {
    name: feature?.name ?? partId,
    color: owned ? feature.color : defaultColor,
    opacity: owned ? feature.opacity : 1,
    hidden: owned ? !!feature.hidden : false,
    owned,
  };
  if (!isSubPart(partId)) return base;
  // A sub-part is named after its feature with its ordinal — "Extrude 1 (2)" —
  // and takes the next palette colour along, so a split result reads as the
  // several bodies it is.
  const o: PartOverride | undefined = doc.parts?.[partId];
  return {
    name: o?.name ?? `${base.name} (${partIndex(partId) + 1})`,
    // Siblings get their own colour rather than the feature's — three lumps
    // painted alike read as one object (see siblingBodyColor).
    color: o?.color ?? siblingBodyColor(base.color, partIndex(partId)),
    opacity: o?.opacity ?? base.opacity,
    hidden: o?.hidden ?? base.hidden,
    owned,
  };
}

/** Write one part's appearance. Lump 0 writes the feature's own fields (so a
 *  single-part feature serialises exactly as it always did); a sub-part writes
 *  `doc.parts`, which is created on first use and pruned when a part is left
 *  with nothing to say. */
export function setPartAppearance(doc: Document, partId: string, patch: Partial<PartOverride>): Document {
  if (!isSubPart(partId)) {
    const featureId = featureIdOfPart(partId);
    return {
      ...doc,
      features: doc.features.map((f) => (f.id === featureId && isBodyFeature(f) ? { ...f, ...patch } : f)),
    };
  }
  const next: PartOverride = { ...doc.parts?.[partId], ...patch };
  for (const k of Object.keys(next) as (keyof PartOverride)[]) if (next[k] === undefined) delete next[k];
  const parts = { ...doc.parts };
  if (Object.keys(next).length === 0) delete parts[partId];
  else parts[partId] = next;
  return Object.keys(parts).length === 0 ? { ...doc, parts: undefined } : { ...doc, parts };
}
