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

export interface BoxParams {
  width: number;
  height: number;
  depth: number;
}

/** The contract implemented by the worker-backed client. Grows per phase. */
export interface Kernel {
  buildBox(params: BoxParams): Promise<ShapeMeshPayload>;
  dispose(): void;
}
