// The assembly document: instances of parts from OTHER documents, placed in
// one space and related by mates. See docs/ASSEMBLY-PLAN.md for the model and
// the phases; this file is the persisted shape only.
//
// An assembly never holds geometry of its own. Each instance names a part of a
// part document (`source`), and its shape is whatever that document's latest
// saved build is — references are live.
import type { Variable } from "../document/types";

/** A 4×4 matrix, column-major (three.js `Matrix4.elements` order). */
export type Mat4 = number[];

export interface Instance {
  id: string;
  /** "Bracket <1>" — editable, unique within the assembly. */
  name: string;
  /** `partId` is a part of that document: `<featureId>` or `<featureId>#<n>`
   *  (document/parts.ts). */
  source: { docId: string; partId: string };
  /** Fixed in world space; the roots the mate solver places everything from. */
  grounded?: boolean;
  /** Placement for an instance no mate chain positions. */
  transform: Mat4;
  hidden?: boolean;
  /** Override (0xRRGGBB); absent = the part's own colour. */
  color?: number;
}

export interface AssemblyDoc {
  instances: Instance[];
  /** Mates arrive in A2; the array exists from the start so documents saved
   *  before then don't need a migration. Typed loosely until then. */
  mates: unknown[];
  variables: Variable[];
}
