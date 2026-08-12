// Browser side of the agent bridge (Phase 9 L1). The tab can't be listened to,
// so it dials OUT to the local Node hub, announces itself (`hello`), then
// services `request` messages by calling the command layer and replying with
// `result`. Requests are processed **strictly one at a time** (await each before
// the next) — React state + kernel regen are async, so request N+1 must observe
// request N. Reconnects with capped backoff so it latches on whenever the user
// starts the MCP server (and survives tab reloads / server restarts).
import { BRIDGE_URL, PROTOCOL_VERSION, type HelloMsg, type RequestMsg, type ResultMsg } from "./protocol";

export type BridgeStatus = "disconnected" | "connecting" | "connected";

export interface BridgeClientOptions {
  /** Hub URL; defaults to the fixed localhost port. */
  url?: string;
  /** Stable per-tab session id (advertised in `hello`). */
  sessionId: string;
  token?: string;
  /** Capabilities to advertise (op + read names the tab supports). */
  conventions: HelloMsg["conventions"];
  /** Handle an `apply` request — returns the structured op result. */
  handleApply: (payload: unknown) => unknown | Promise<unknown>;
  /** Handle a `read` request — returns the read result. */
  handleRead: (payload: unknown) => unknown | Promise<unknown>;
  /** Connection-status changes (drives the "Agent connected" badge). */
  onStatus?: (status: BridgeStatus) => void;
}

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 10000;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private status: BridgeStatus = "disconnected";
  private backoff = MIN_BACKOFF;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  // Serial request pipeline: requests append here and drain one at a time.
  private queue: RequestMsg[] = [];
  private draining = false;

  constructor(private opts: BridgeClientOptions) {}

  /** Begin connecting (and auto-reconnecting until `close()`). */
  start(): void {
    this.closed = false;
    this.connect();
  }

  /** Stop for good — no further reconnects. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.queue = [];
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  private setStatus(s: BridgeStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private connect(): void {
    if (this.closed) return;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url ?? BRIDGE_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = MIN_BACKOFF;
      this.setStatus("connected");
      const hello: HelloMsg = {
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        sessionId: this.opts.sessionId,
        token: this.opts.token,
        conventions: this.opts.conventions,
      };
      this.sendRaw(hello);
    };

    ws.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return; // ignore non-JSON frames
      }
      if (msg && typeof msg === "object" && (msg as { type?: string }).type === "request") {
        this.queue.push(msg as RequestMsg);
        void this.drain();
      }
    };

    ws.onerror = () => {
      // onclose follows; reconnect is scheduled there.
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setStatus("disconnected");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const req = this.queue.shift()!;
        await this.handle(req);
      }
    } finally {
      this.draining = false;
    }
  }

  private async handle(req: RequestMsg): Promise<void> {
    let result: ResultMsg;
    try {
      const payload =
        req.kind === "apply" ? await this.opts.handleApply(req.payload) : await this.opts.handleRead(req.payload);
      result = { type: "result", id: req.id, ok: true, payload };
    } catch (err) {
      result = {
        type: "result",
        id: req.id,
        ok: false,
        error: { message: String((err as Error)?.message ?? err), kind: "invalid_op" },
      };
    }
    this.sendRaw(result);
  }

  private sendRaw(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
