// Mounts the agent command layer into the live app. Builds an AgentContext that
// reads the latest committed state through refs (never a stale closure — mirrors
// Viewport's selectionRef) and routes mutations through the undo setter. For now
// it only exposes `window.__openpoly = { apply, read }` for manual console
// testing (L0 exit: drive the model from the dev console end-to-end). The
// WebSocket bridge client (L1) plugs into this same ctx.
import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  applyOperation,
  getDocument,
  getSceneSummary,
  getSelection,
  screenshot,
  type AgentContext,
} from "./commands";
import {
  operationSchema,
  readQuerySchema,
  type Operation,
  type OpResult,
  type ReadQuery,
  type SceneSummary,
} from "./operations";
import type { Document } from "../document/types";
import type { FeatureMesh, Selection, ViewName, ViewportApi } from "../viewport/Viewport";

interface BridgeDeps {
  doc: Document;
  /** The useHistory setter — each agent op becomes its own undo step. */
  setDoc: (next: Document) => void;
  selection: Selection[];
  setSelection: (sel: Selection[]) => void;
  meshes: FeatureMesh[];
  /** App's merged per-feature error map (resolve + kernel). */
  errors: Record<string, string>;
  viewApiRef: RefObject<ViewportApi | null>;
}

/** The dev-console handle. `apply` validates the op with the shared zod schema
 *  (so console typos get readable errors); `read` runs a typed read query. */
export interface OpenPolyApi {
  apply(op: Operation): OpResult;
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

export function useAgentBridge(deps: BridgeDeps): AgentContext {
  // Refs always hold the latest committed state, so ctx getters never close over
  // stale values. `setDoc` also writes docRef synchronously so a chain of
  // console ops in one tick composes (each sees the prior op's doc) before React
  // re-renders.
  const docRef = useRef(deps.doc);
  docRef.current = deps.doc;
  const selectionRef = useRef(deps.selection);
  selectionRef.current = deps.selection;
  const meshesRef = useRef(deps.meshes);
  meshesRef.current = deps.meshes;
  const errorsRef = useRef(deps.errors);
  errorsRef.current = deps.errors;
  const setDocRef = useRef(deps.setDoc);
  setDocRef.current = deps.setDoc;
  const setSelectionRef = useRef(deps.setSelection);
  setSelectionRef.current = deps.setSelection;
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
      getViewport: () => viewApiRef.current,
    }),
    [viewApiRef],
  );

  // Dev-only console handle for manual testing before any networking exists.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const api: OpenPolyApi = {
      apply: (op) => applyOperation(ctx, operationSchema.parse(op)),
      read: (query) => {
        const q = readQuerySchema.parse(query);
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
      document: () => getDocument(ctx),
      summary: () => getSceneSummary(ctx),
      selection: () => getSelection(ctx),
      screenshot: (view) => screenshot(ctx, view ? { view } : undefined),
    };
    window.__openpoly = api;
    return () => {
      if (window.__openpoly === api) delete window.__openpoly;
    };
  }, [ctx]);

  return ctx;
}
