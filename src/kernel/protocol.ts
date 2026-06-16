// Wire protocol between the main thread and the kernel Web Worker.
import type { BoxParams, ShapeMeshPayload } from "./types";

export type KernelRequest = { id: number; op: "buildBox"; params: BoxParams };

export type KernelResponse =
  | { id: number; ok: true; result: ShapeMeshPayload }
  | { id: number; ok: false; error: string };
