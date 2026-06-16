// Main-thread implementation of the Kernel facade. Spawns the worker and
// correlates request/response pairs by id, exposing a clean Promise API.

import type { BoxParams, Kernel, ShapeMeshPayload } from "./types";
import type { KernelRequest, KernelResponse } from "./protocol";

type Pending = {
  resolve: (value: ShapeMeshPayload) => void;
  reject: (reason: Error) => void;
};

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
      this.pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error));
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

  buildBox(params: BoxParams): Promise<ShapeMeshPayload> {
    const id = this.nextId++;
    const req: KernelRequest = { id, op: "buildBox", params };
    return new Promise<ShapeMeshPayload>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
