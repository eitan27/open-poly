// Hub side of the agent bridge (Phase 9 L2). A localhost WebSocket server the
// Open Poly browser tab dials into (the tab can't be listened to, so it connects
// OUT). The MCP server forwards each LLM tool call here as a `request`; the tab
// applies it and replies with a `result`, correlated by `id`.
//
// All logging goes to **stderr** — stdout is the MCP stdio JSON-RPC channel and
// must not be polluted.
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  BRIDGE_PORT,
  type HelloMsg,
  type RequestMsg,
  type ResultMsg,
} from "../../src/agent/protocol.ts";

const log = (...args: unknown[]) => console.error("[hub]", ...args);

/** A clear, taxonomy-tagged error the MCP tools turn into a readable message. */
export class HubError extends Error {
  constructor(public kind: "no_session" | "timeout", message: string) {
    super(message);
  }
}

export class WsHub {
  private wss: WebSocketServer;
  private tab: WebSocket | null = null;
  private session: HelloMsg | null = null;
  private pending = new Map<string, { resolve: (r: ResultMsg) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(port = BRIDGE_PORT) {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    this.wss.on("listening", () => log(`listening on ws://127.0.0.1:${port}`));
    this.wss.on("connection", (ws) => this.onConnection(ws));
    this.wss.on("error", (e) => log("server error:", e.message));
  }

  private onConnection(ws: WebSocket): void {
    ws.on("message", (data) => {
      let msg: { type?: string; id?: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") {
        // Single active tab for v1: last-connected wins.
        this.tab = ws;
        this.session = msg as unknown as HelloMsg;
        log("tab connected:", this.session.sessionId);
      } else if (msg.type === "result" && typeof msg.id === "string") {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg as unknown as ResultMsg);
        }
      }
    });
    ws.on("close", () => {
      if (this.tab === ws) {
        this.tab = null;
        this.session = null;
        log("tab disconnected");
      }
    });
    ws.on("error", () => {/* close handler does cleanup */});
  }

  hasTab(): boolean {
    return !!this.tab && this.tab.readyState === WebSocket.OPEN;
  }

  /** Forward a command to the tab and await its result (correlated by id).
   *  Rejects with a HubError if no tab is connected or the tab doesn't reply. */
  request(kind: "apply" | "read", payload: unknown, timeoutMs = 20000): Promise<ResultMsg> {
    return new Promise((resolve, reject) => {
      if (!this.hasTab()) {
        reject(new HubError("no_session", "No Open Poly tab is connected. Open the app in your browser (and keep the tab focused) so the agent can drive it."));
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HubError("timeout", `The Open Poly tab did not respond within ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      const req: RequestMsg = { type: "request", id, kind, payload };
      this.tab!.send(JSON.stringify(req));
    });
  }

  close(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    this.wss.close();
  }
}
