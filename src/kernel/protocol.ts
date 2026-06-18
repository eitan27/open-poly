// Wire protocol between the main thread and the kernel Web Worker.
import type { ExportFormat, RegenFeatureResult, ResolvedFeature } from "./types";

export type KernelRequest =
  | { id: number; op: "regenerate"; features: ResolvedFeature[] }
  | { id: number; op: "export"; features: ResolvedFeature[]; bodyId: string; format: ExportFormat };

export type KernelResponse =
  | { id: number; ok: true; op: "regenerate"; results: RegenFeatureResult[] }
  | { id: number; ok: true; op: "export"; blob: Blob }
  | { id: number; ok: false; error: string };
