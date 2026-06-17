// The Kernel facade. Application code (UI, document model) talks ONLY to these
// types — replicad / OpenCascade never leak past this boundary. This is the
// swap-point that lets us replace the implementation with direct opencascade.js
// calls later without touching the rest of the app.

export interface MeshedFaces {
  vertices: number[];
  triangles: number[];
  normals?: number[];
  /** Maps ranges of the triangle buffer back to a topological face id (for picking). */
  faceGroups?: { start: number; count: number; faceId: number }[];
}

export interface MeshedEdges {
  lines: number[];
  /** Maps ranges of the line buffer back to a topological edge id (for picking). */
  edgeGroups?: { start: number; count: number; edgeId: number }[];
}

/** A tessellated shape ready to be uploaded to three.js. */
export interface ShapeMeshPayload {
  name: string;
  faces: MeshedFaces;
  edges: MeshedEdges;
}

/** Primitive solids the kernel knows how to build (Phase 1). */
export type PrimitiveKind = "box" | "cylinder" | "sphere";

/** An orthonormal coordinate frame (world space). */
export interface ResolvedFrame {
  origin: [number, number, number];
  uAxis: [number, number, number];
  vAxis: [number, number, number];
  normal: [number, number, number];
}

/** A closed planar profile to extrude: an outer loop in sketch (u,v) coords on
 *  a frame. (Inner loops / holes come later.) */
export interface ResolvedProfile {
  outline: [number, number][];
  frame: ResolvedFrame;
}

/** How an extrude combines with the running body set. */
export type ExtrudeMode = "new" | "add" | "remove";

/** Features with all parameters already resolved to numbers/geometry
 *  (expressions are evaluated in the app layer before reaching the kernel). */
export type ResolvedFeature =
  | { id: string; type: "primitive"; kind: PrimitiveKind; params: Record<string, number> }
  | { id: string; type: "extrude"; profile: ResolvedProfile; distance: number; flip: boolean; mode: ExtrudeMode };

export type RegenFeatureResult =
  | { id: string; ok: true; mesh: ShapeMeshPayload }
  | { id: string; ok: false; error: string };

/** The contract implemented by the worker-backed client. Grows per phase. */
export interface Kernel {
  regenerate(features: ResolvedFeature[]): Promise<RegenFeatureResult[]>;
  dispose(): void;
}
