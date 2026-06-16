// Wire protocol between the main thread and the kernel Web Worker.
import type { RegenFeatureResult, ResolvedFeature } from "./types";

export type KernelRequest = {
  id: number;
  op: "regenerate";
  features: ResolvedFeature[];
};

export type KernelResponse =
  | { id: number; ok: true; results: RegenFeatureResult[] }
  | { id: number; ok: false; error: string };
