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

/** Boolean combination operators (Phase 4). */
export type BooleanOp = "union" | "subtract" | "intersect";

/** A feature with all parameters already resolved to numbers (expressions
 *  are evaluated in the app layer before reaching the kernel). A boolean
 *  references its operands by id; the worker resolves those against the
 *  rest of the batch passed to `regenerate`. */
export type ResolvedFeature =
  | { id: string; type: "primitive"; kind: PrimitiveKind; params: Record<string, number> }
  | { id: string; type: "boolean"; op: BooleanOp; operands: string[] };

/** Ids of features consumed as an operand by some active boolean — these
 *  shouldn't be meshed/listed on their own, only the boolean's result should. */
export function consumedFeatureIds(features: ResolvedFeature[]): Set<string> {
  const ids = new Set<string>();
  for (const f of features) {
    if (f.type === "boolean") for (const id of f.operands) ids.add(id);
  }
  return ids;
}

export type RegenFeatureResult =
  | { id: string; ok: true; mesh: ShapeMeshPayload }
  | { id: string; ok: false; error: string };

export type ExportFormat = "step" | "stl";

/** The contract implemented by the worker-backed client. Grows per phase. */
export interface Kernel {
  regenerate(features: ResolvedFeature[]): Promise<RegenFeatureResult[]>;
  /** Rebuilds `featureId`'s shape (plus whatever boolean operands it
   *  transitively depends on, from the same batch) and exports it. Geometry
   *  is authored in millimetres throughout, so STEP files declare "mm"
   *  explicitly. */
  exportFeature(features: ResolvedFeature[], featureId: string, format: ExportFormat): Promise<Blob>;
  dispose(): void;
}
