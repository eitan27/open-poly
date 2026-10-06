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
  listDocuments,
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
  type DocumentListing,
  type Operation,
  type OpResult,
  type ReadQuery,
  type SceneSummary,
} from "./operations";
import { BridgeClient, type BridgeStatus } from "./bridgeClient";
import { genId } from "../document/document";
import type { Document } from "../document/types";
import type { SectionViewState } from "../document/sectionView";
import type { Selection, ViewName, ViewportApi } from "../viewport/Viewport";

interface BridgeDeps {
  doc: Document;
  /** The useHistory setter — each agent op becomes its own undo step. */
  setDoc: (next: Document) => void;
  selection: Selection[];
  setSelection: (sel: Selection[]) => void;
  /** Section view — pure viewport state, like selection (no undo/regen). */
  sectionView: SectionViewState;
  setSectionView: (next: SectionViewState) => void;
  /** Latest regenerated bodies, fed synchronously when regen settles. */
  meshesRef: RefObject<AgentMesh[]>;
  /** Merged per-feature error map (resolve + kernel), refreshed each regen. */
  errorsRef: RefObject<Record<string, string>>;
  /** Resolves after the next kernel regen settles. */
  waitForRegen: () => Promise<RegenSettle>;
  viewApiRef: RefObject<ViewportApi | null>;
  /** Multi-document workspace API. App refreshes the ref each
   *  render so the getters/actions always see the latest switch-flow closures. */
  docApiRef: RefObject<AgentContext["documents"]>;
}

/** The dev-console handle. `apply` validates the op with the shared zod schema
 *  (so console typos get readable errors) and resolves once regen settles;
 *  `read` runs a typed read query. */
export interface OpenPolyApi {
  apply(op: Operation): Promise<OpResult>;
  /** `documents` resolves async (IndexedDB); the rest return synchronously. */
  read(query: ReadQuery): Document | SceneSummary | Selection[] | string | null | Promise<DocumentListing[]>;
  document(): Document;
  summary(): SceneSummary;
  selection(): Selection[];
  screenshot(view?: ViewName): string | null;
  /** Project a world point to canvas CSS pixels (dev/console + e2e scripts:
   *  lets a test compute where to synthesize a real viewport click). */
  worldToScreen(p: [number, number, number]): { x: number; y: number } | null;
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

/** Whether this instance is running locally (so the agent bridge, which dials a
 *  hub on 127.0.0.1, is worth starting). True for the Vite dev server and for a
 *  build opened from a loopback / *.local host; false for a public deployment.
 *  TODO: replace this host sniff with an explicit signal — a build-time flag,
 *  an env var, or a user-facing "enable agent" toggle — for a more robust and
 *  generic condition (e.g. so a LAN-hosted dev box or a remote hub can opt in). */
function isLocalDeployment(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".local");
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
  const sectionViewRef = useRef(deps.sectionView);
  sectionViewRef.current = deps.sectionView;
  const setSectionViewRef = useRef(deps.setSectionView);
  setSectionViewRef.current = deps.setSectionView;
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
      getSectionView: () => sectionViewRef.current,
      setSectionView: (next) => {
        sectionViewRef.current = next;
        setSectionViewRef.current(next);
      },
      getMeshes: () => meshesRef.current,
      getErrors: () => errorsRef.current,
      waitForRegen: () => waitForRegenRef.current(),
      getViewport: () => viewApiRef.current,
      // Delegate through the ref so the ctx stays stable while App's switch
      // flow callbacks (which close over doc/docName/rawMeshes) are refreshed.
      documents: {
        info: () => deps.docApiRef.current.info(),
        open: (id) => deps.docApiRef.current.open(id),
        create: () => deps.docApiRef.current.create(),
        duplicate: (id) => deps.docApiRef.current.duplicate(id),
        rename: (id, name) => deps.docApiRef.current.rename(id, name),
      },
    }),
    [meshesRef, errorsRef, viewApiRef, deps.docApiRef],
  );

  // Apply/read handlers shared by the WS bridge and the dev console. Validate
  // every payload with the shared zod schemas (same as the MCP server will).
  const handleApply = useMemo(
    () =>
      (payload: unknown): Promise<OpResult> =>
        applyOperation(ctx, operationSchema.parse(payload)),
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
        case "documents":
          return listDocuments(ctx); // async — the bridge awaits handler results
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
    // The bridge only makes sense when the app runs locally, since the hub it
    // dials lives on 127.0.0.1 (see BRIDGE_URL). On a deployed/public build that
    // connection can never succeed, so skip it — no reconnection churn, and the
    // "Agent connected" badge (gated on status === "connected") stays hidden.
    if (!isLocalDeployment()) return;
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
      worldToScreen: (p) => viewApiRef.current?.worldToScreen(p) ?? null,
    };
    window.__openpoly = api;
    return () => {
      if (window.__openpoly === api) delete window.__openpoly;
    };
  }, [ctx, handleRead]);

  return { ctx, status };
}
