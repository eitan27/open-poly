// The assembly document: instances of parts from OTHER documents, placed in
// one space and related by mates. See docs/ASSEMBLY-PLAN.md for the model and
// what is not built yet; this file is the persisted shape only.
//
// An assembly never holds geometry of its own. Each instance names a part of a
// part document (`source`), and its shape is whatever that document's latest
// saved build is — references are live.
import type { Variable } from "../document/types";
import type { Anchor, ConnectorRef } from "./frames";

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

export type MateType = "fastened" | "revolute" | "slider" | "cylindrical" | "planar" | "ball" | "width";

/** A mate's free degrees of freedom, in the frame of its first connector:
 *  translations along and rotations about that frame's axes. */
export type Dof = "tx" | "ty" | "tz" | "rx" | "ry" | "rz";

/** One side of a mate: a frame on an instance's part, found from a face or
 *  edge of it (see frames.ts). */
export interface MateConnector {
  instanceId: string;
  ref: ConnectorRef;
  /** A width mate's second face: the connector is then the plane midway
   *  between `ref` and this (see frames.ts midplaneShape). Other types ignore
   *  it. */
  ref2?: ConnectorRef;
  anchor: Anchor;
  /** Moves the connector within its own frame (mm, as expressions that may
   *  name the assembly's variables): a frame where no face or edge sits, say
   *  a corner set in from a part's edge. Absent = none. */
  offset?: Partial<Record<"x" | "y" | "z", string>>;
}

export interface Mate {
  id: string;
  /** "Revolute 1" — editable. */
  name: string;
  type: MateType;
  /** The two sides. Which is "parent" is the solver's business (it orients
   *  each mate as it reaches it from a grounded instance); values are always
   *  `b` relative to `a`. */
  a: MateConnector;
  b: MateConnector;
  /** One value per free DOF (see MATE_DOFS), as text — millimetres, or
   *  degrees for a rotation. Absent = 0. */
  values?: Partial<Record<Dof, string>>;
  limits?: Partial<Record<Dof, { min?: string; max?: string }>>;
  /** By default the two Z axes face each other (two faces touching); flipped,
   *  they point the same way. A width mate is the other way round: its two
   *  mid-planes point the same way unless flipped. */
  flip?: boolean;
  /** Quarter turns of `b` about Z (0–3), for orienting a fastened part. */
  turns?: number;
  suppressed?: boolean;
}

export interface AssemblyDoc {
  instances: Instance[];
  mates: Mate[];
  variables: Variable[];
}
