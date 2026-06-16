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

/** A feature with all parameters already resolved to numbers (expressions
 *  are evaluated in the app layer before reaching the kernel). */
export interface ResolvedFeature {
  id: string;
  kind: PrimitiveKind;
  params: Record<string, number>;
}

export type RegenFeatureResult =
  | { id: string; ok: true; mesh: ShapeMeshPayload }
  | { id: string; ok: false; error: string };

/** The contract implemented by the worker-backed client. Grows per phase. */
export interface Kernel {
  regenerate(features: ResolvedFeature[]): Promise<RegenFeatureResult[]>;
  dispose(): void;
}
