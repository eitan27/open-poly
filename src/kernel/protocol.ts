// Wire protocol between the main thread and the kernel Web Worker.
import type { ExportFormat, RegenFeatureResult, ResolvedFeature } from "./types";

export type KernelRequest =
  | { id: number; op: "regenerate"; features: ResolvedFeature[] }
  | { id: number; op: "export"; features: ResolvedFeature[]; bodyId: string; format: ExportFormat };

export type KernelResponse =
  // `warnings` are non-fatal, keyed by FEATURE id: references that had to be
  // re-matched geometrically (name churn from an upstream edit) or were lost.
  | { id: number; ok: true; op: "regenerate"; results: RegenFeatureResult[]; warnings: Record<string, string> }
  // Streamed ahead of the final "regenerate": one body's result the moment it's
  // meshed, so the viewport can paint the model progressively instead of waiting
  // for the whole fold. The final "regenerate" message is still authoritative
  // (it also removes bodies that no longer exist).
  | { id: number; ok: true; op: "regenerate-progress"; result: RegenFeatureResult }
  | { id: number; ok: true; op: "export"; blob: Blob }
  | { id: number; ok: false; error: string };
