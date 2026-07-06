// Main-thread implementation of the Kernel facade. Spawns the worker and
// correlates request/response pairs by id, exposing a clean Promise API.

import type { ExportFormat, Kernel, RegenFeatureResult, RegenOutcome, ResolvedFeature } from "./types";
import type { KernelRequest, KernelResponse } from "./protocol";

type Pending =
  | {
      op: "regenerate";
      resolve: (value: RegenOutcome) => void;
      reject: (reason: Error) => void;
      onProgress?: (result: RegenFeatureResult) => void;
    }
  | { op: "export"; resolve: (value: Blob) => void; reject: (reason: Error) => void };

export class KernelClient implements Kernel {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<KernelResponse>) => {
      const res = event.data;
      const p = this.pending.get(res.id);
      if (!p) return;
      // Progressive body results arrive before the final message — forward them
      // and keep the request pending (don't resolve or delete it yet).
      if (res.ok && res.op === "regenerate-progress") {
        if (p.op === "regenerate") p.onProgress?.(res.result);
        return;
      }
      this.pending.delete(res.id);
      if (!res.ok) {
        p.reject(new Error(res.error));
      } else if (p.op === "regenerate" && res.op === "regenerate") {
        p.resolve({ results: res.results, warnings: res.warnings });
      } else if (p.op === "export" && res.op === "export") {
        p.resolve(res.blob);
      }
    };
    // A failure while loading/evaluating the worker module (e.g. the WASM glue)
    // fires `error` rather than a message — surface it instead of hanging.
    this.worker.onerror = (event) => this.failAll(event.message || "worker error");
    this.worker.onmessageerror = () => this.failAll("worker message deserialization failed");
  }

  private failAll(message: string): void {
    const error = new Error(message);
    for (const [, p] of this.pending) p.reject(error);
    this.pending.clear();
  }

  regenerate(
    features: ResolvedFeature[],
    onProgress?: (result: RegenFeatureResult) => void,
  ): Promise<RegenOutcome> {
    const id = this.nextId++;
    const req: KernelRequest = { id, op: "regenerate", features };
    return new Promise<RegenOutcome>((resolve, reject) => {
      this.pending.set(id, { op: "regenerate", resolve, reject, onProgress });
      this.worker.postMessage(req);
    });
  }

  exportBody(features: ResolvedFeature[], bodyId: string, format: ExportFormat): Promise<Blob> {
    const id = this.nextId++;
    const req: KernelRequest = { id, op: "export", features, bodyId, format };
    return new Promise<Blob>((resolve, reject) => {
      this.pending.set(id, { op: "export", resolve, reject });
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
