// Shared WebSocket protocol between the browser tab (the command layer / state
// holder) and the local Node bridge+MCP hub. This is the **single source of
// truth** for the wire format — imported by both the browser bridge client
// (`bridgeClient.ts`) and, later, the Node server (`mcp-server/`).
// Keep it dependency-free and isomorphic (no DOM, no Node APIs).
//
// Data flow: the tab can't be listened to, so it connects OUT to the hub. The
// hub forwards LLM tool calls to the tab as `request`s; the tab applies them via
// the command layer and replies with `result`s. Conventions everywhere:
// **millimetres**, world is **Z-up**.

/** Fixed localhost port the hub listens on and the tab dials. */
export const BRIDGE_PORT = 7373;
export const BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
/** Bumped on any breaking change to the message shapes below. */
export const PROTOCOL_VERSION = 1;

/** What a connecting tab advertises: who it is + a capabilities blob the hub can
 *  relay to the LLM (and the conventions to state in tool descriptions). */
export interface HelloMsg {
  type: "hello";
  protocolVersion: number;
  /** Stable per-tab id (so the hub can track / dedupe sessions). */
  sessionId: string;
  /** Shared secret (L4); echoed from the MCP config. Optional for v1. */
  token?: string;
  conventions: {
    units: "mm";
    up: "z";
    /** Operation `op` names this tab can apply. */
    operations: string[];
    /** Read-query `read` names this tab supports. */
    reads: string[];
  };
}

/** Hub → tab: run one command. `payload` is an `Operation` (apply) or a
 *  `ReadQuery` (read); the tab validates it with the shared zod schemas. */
export interface RequestMsg {
  type: "request";
  id: string;
  kind: "apply" | "read";
  payload: unknown;
}

/** Tab → hub: the outcome of a `request` (correlated by `id`). Transport-level
 *  `ok` means "the request was handled"; for an apply, the op's own success is
 *  inside `payload` (an `OpResult` with its own `ok`). */
export interface ResultMsg {
  type: "result";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { message: string; kind?: string };
}

/** Tab → hub: an unsolicited notification (e.g. selection changed). Optional;
 *  reserved for later (subscribable resources). */
export interface EventMsg {
  type: "event";
  event: string;
  payload?: unknown;
}

/** Messages the tab sends to the hub. */
export type TabMessage = HelloMsg | ResultMsg | EventMsg;
/** Messages the hub sends to the tab. */
export type HubMessage = RequestMsg;
/** Any bridge message. */
export type BridgeMessage = TabMessage | HubMessage;
