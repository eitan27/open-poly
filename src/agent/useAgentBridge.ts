// Mounts the agent command layer into the live app. Builds an AgentContext that
// reads the latest committed state through refs (never a stale closure — mirrors
// Viewport's selectionRef) and routes mutations through the undo setter. Owns the
// WebSocket bridge client (L1): it dials the local hub, services requests via the
// command layer, and surfaces the connection status for the "Agent connected"
// badge. Also exposes `window.__openpoly = { apply, read }` in dev for manual
// console testing without any networking.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  applyOperation,
  getDocument,
  getSceneSummary,
  getSelection,
  screenshot,
  type AgentContext,
  type AgentMesh,
  type RegenSettle,
} from "./commands";
import {
  operationSchema,
  readQuerySchema,
  OPERATION_NAMES,
  READ_NAMES,
  type Operation,
  type OpResult,
  type ReadQuery,
  type SceneSummary,
} from "./operations";
import { BridgeClient, type BridgeStatus } from "./bridgeClient";
import { genId } from "../document/document";
import type { Document } from "../document/types";
import type { Selection, ViewName, ViewportApi } from "../viewport/Viewport";

interface BridgeDeps {
  doc: Document;
  /** The useHistory setter — each agent op becomes its own undo step. */
  setDoc: (next: Document) => void;
  selection: Selection[];
  setSelection: (sel: Selection[]) => void;
  /** Latest regenerated bodies, fed synchronously when regen settles. */
  meshesRef: RefObject<AgentMesh[]>;
  /** Merged per-feature error map (resolve + kernel), refreshed each regen. */
  errorsRef: RefObject<Record<string, string>>;
  /** Resolves after the next kernel regen settles. */
  waitForRegen: () => Promise<RegenSettle>;
  viewApiRef: RefObject<ViewportApi | null>;
}

/** The dev-console handle. `apply` validates the op with the shared zod schema
 *  (so console typos get readable errors) and resolves once regen settles;
 *  `read` runs a typed read query. */
export interface OpenPolyApi {
  apply(op: Operation): Promise<OpResult>;
  read(query: ReadQuery): Document | SceneSummary | Selection[] | string | null;
  document(): Document;
  summary(): SceneSummary;
  selection(): Selection[];
  screenshot(view?: ViewName): string | null;
}

declare global {
  interface Window {
    __openpoly?: OpenPolyApi;
  }
}

export interface AgentBridge {
  ctx: AgentContext;
  /** Live WS connection status (drives the badge). */
  status: BridgeStatus;
}

export function useAgentBridge(deps: BridgeDeps): AgentBridge {
  // Refs always hold the latest committed state, so ctx getters never close over
  // stale values. `setDoc` also writes docRef synchronously so a chain of ops in
  // one tick composes (each sees the prior op's doc) before React re-renders.
  const docRef = useRef(deps.doc);
  docRef.current = deps.doc;
  const selectionRef = useRef(deps.selection);
  selectionRef.current = deps.selection;
  const setDocRef = useRef(deps.setDoc);
  setDocRef.current = deps.setDoc;
  const setSelectionRef = useRef(deps.setSelection);
  setSelectionRef.current = deps.setSelection;
  const waitForRegenRef = useRef(deps.waitForRegen);
  waitForRegenRef.current = deps.waitForRegen;
  // These refs are owned by App's regen effect (synchronously fresh on settle).
  const meshesRef = deps.meshesRef;
  const errorsRef = deps.errorsRef;
  const viewApiRef = deps.viewApiRef;

  const ctx = useMemo<AgentContext>(
    () => ({
      getDoc: () => docRef.current,
      setDoc: (next) => {
        docRef.current = next;
        setDocRef.current(next);
      },
      getSelection: () => selectionRef.current,
      setSelection: (sel) => {
        selectionRef.current = sel;
        setSelectionRef.current(sel);
      },
      getMeshes: () => meshesRef.current,
      getErrors: () => errorsRef.current,
      waitForRegen: () => waitForRegenRef.current(),
      getViewport: () => viewApiRef.current,
    }),
    [meshesRef, errorsRef, viewApiRef],
  );

  // Apply/read handlers shared by the WS bridge and the dev console. Validate
  // every payload with the shared zod schemas (same as the MCP server will).
  const handleApply = useMemo(
    () => (payload: unknown): Promise<OpResult> => applyOperation(ctx, operationSchema.parse(payload)),
    [ctx],
  );
  const handleRead = useMemo(
    () => (payload: unknown) => {
      const q = readQuerySchema.parse(payload);
      switch (q.read) {
        case "document":
          return getDocument(ctx);
        case "sceneSummary":
          return getSceneSummary(ctx);
        case "selection":
          return getSelection(ctx);
        case "screenshot":
          return screenshot(ctx, q.view ? { view: q.view } : undefined);
      }
    },
    [ctx],
  );

  // WebSocket bridge: dial the hub, auto-reconnect, service requests serially.
  const [status, setStatus] = useState<BridgeStatus>("disconnected");
  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current) sessionIdRef.current = genId();

  useEffect(() => {
    const client = new BridgeClient({
      sessionId: sessionIdRef.current,
      conventions: { units: "mm", up: "z", operations: OPERATION_NAMES, reads: READ_NAMES },
      handleApply,
      handleRead,
      onStatus: setStatus,
    });
    client.start();
    return () => client.close();
  }, [handleApply, handleRead]);

  // Dev-only console handle for manual testing before any networking is up.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const api: OpenPolyApi = {
      apply: (op) => applyOperation(ctx, operationSchema.parse(op)),
      read: (query) => handleRead(query) as ReturnType<OpenPolyApi["read"]>,
      document: () => getDocument(ctx),
      summary: () => getSceneSummary(ctx),
      selection: () => getSelection(ctx),
      screenshot: (view) => screenshot(ctx, view ? { view } : undefined),
    };
    window.__openpoly = api;
    return () => {
      if (window.__openpoly === api) delete window.__openpoly;
    };
  }, [ctx, handleRead]);

  return { ctx, status };
}
