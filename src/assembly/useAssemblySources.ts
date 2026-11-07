// The part documents an open assembly reads from, loaded from IndexedDB.
//
// An assembly draws each instance from its source document's SAVED build (the
// meshes every part record caches), so showing one needs no kernel work at all
// — except for a document that has never been built on this device (it came
// down from Drive and was never opened). That one is built here, through the
// same kernel worker, and the meshes are written back to its record so the next
// open is instant. The worker's caches are content-keyed, so building another
// document's features beside the open (empty) part model is safe.
//
// References are live: a source edited elsewhere is reloaded when this tab
// next gets the focus (or the user asks).
import { useCallback, useEffect, useRef, useState } from "react";
import { migrateDocument } from "../document/document";
import { partAppearance } from "../document/parts";
import { DEFAULT_SOLID_COLOR } from "../document/colors";
import type { Document } from "../document/types";
import type { ShapeMeshPayload } from "../kernel/types";
import { listMeta, loadDoc, putMeshesIfUnchanged } from "../storage/db";

export interface SourcePart {
  partId: string;
  name: string;
  color: number;
  opacity: number;
  mesh: ShapeMeshPayload;
}

export type SourceState =
  | { status: "loading" }
  | { status: "building"; name: string }
  | { status: "missing" }
  | { status: "error"; name: string; message: string }
  | { status: "ready"; name: string; updatedAt: number; parts: SourcePart[] };

/** Builds a part document's bodies; null until the kernel is up. */
export type BuildDocument = (doc: Document) => Promise<{ id: string; mesh: ShapeMeshPayload }[]>;

/** One document's parts, named and coloured as its own Parts list shows them. */
export function sourceParts(doc: Document, meshes: { id: string; mesh: ShapeMeshPayload }[]): SourcePart[] {
  return meshes.map((m) => {
    const look = partAppearance(doc, m.id, DEFAULT_SOLID_COLOR);
    return { partId: m.id, name: look.name, color: look.color, opacity: look.opacity, mesh: m.mesh };
  });
}

/** Read one document as a source, building it first if it never was. */
export async function readSource(docId: string, build: BuildDocument | null): Promise<SourceState> {
  const rec = await loadDoc(docId);
  if (!rec || rec.assembly) return { status: "missing" };
  let doc: Document;
  try {
    doc = migrateDocument(rec.doc);
  } catch {
    return { status: "error", name: rec.name, message: "This document is corrupted." };
  }
  if (rec.meshes)
    return { status: "ready", name: rec.name, updatedAt: rec.updatedAt, parts: sourceParts(doc, rec.meshes) };
  if (!build) return { status: "building", name: rec.name };
  let meshes: { id: string; mesh: ShapeMeshPayload }[];
  try {
    meshes = await build(doc);
  } catch (e) {
    return { status: "error", name: rec.name, message: String((e as Error)?.message ?? e) };
  }
  // Saved back only if nothing changed meanwhile; either way these meshes are
  // what the record held when it was read, so they're right to show now.
  await putMeshesIfUnchanged(docId, rec.updatedAt, meshes).catch(() => false);
  return { status: "ready", name: rec.name, updatedAt: rec.updatedAt, parts: sourceParts(doc, meshes) };
}

export function useAssemblySources({
  assemblyId,
  docIds,
  build,
}: {
  /** The open assembly's id (null when a part is open): a new one starts fresh. */
  assemblyId: string | null;
  docIds: string[];
  build: BuildDocument | null;
}): {
  sources: ReadonlyMap<string, SourceState>;
  /** True once every referenced document has loaded, or failed to. */
  settled: boolean;
  /** Re-read every source whose saved version moved on. */
  refresh: () => void;
} {
  const [sources, setSources] = useState<ReadonlyMap<string, SourceState>>(new Map());
  // Which assembly `sources` was loaded for. Until the reset below lands, the
  // map still holds the previous assembly's, which must not read as settled.
  const [owner, setOwner] = useState(assemblyId);
  // Mirrors `sources` synchronously, so a pass started in the same commit as a
  // reset (switching assemblies) reads the cleared map, not the last one's.
  const sourcesRef = useRef(sources);
  const update = (fn: (m: Map<string, SourceState>) => void) => {
    const next = new Map(sourcesRef.current);
    fn(next);
    sourcesRef.current = next;
    setSources(next);
  };
  // A load answering for an assembly that's no longer open is dropped.
  const generation = useRef(0);
  const inFlight = useRef(new Set<string>());
  const buildRef = useRef(build);
  buildRef.current = build;
  const buildReady = !!build;
  const [refreshTick, setRefreshTick] = useState(0);

  // A different assembly (or none): forget everything. Declared before the
  // load pass, so it runs first in the same commit.
  useEffect(() => {
    generation.current += 1;
    setOwner(assemblyId);
    sourcesRef.current = new Map();
    setSources(sourcesRef.current);
    inFlight.current.clear();
  }, [assemblyId]);

  const key = docIds.join("|");
  useEffect(() => {
    if (!assemblyId) return;
    const gen = generation.current;
    const want = key ? key.split("|") : [];
    (async () => {
      // Which loaded sources are stale: their saved edit time moved on.
      const metas = new Map((await listMeta().catch(() => [])).map((m) => [m.id, m]));
      for (const id of want) {
        if (inFlight.current.has(id)) continue;
        const cur = sourcesRef.current.get(id);
        const meta = metas.get(id);
        const stale =
          !cur ||
          cur.status === "loading" ||
          (cur.status === "building" && buildReady) ||
          (cur.status === "ready" && (!meta || meta.updatedAt !== cur.updatedAt)) ||
          (cur.status === "missing" && !!meta);
        if (!stale) continue;
        inFlight.current.add(id);
        if (!cur) update((m) => m.set(id, { status: "loading" }));
        readSource(id, buildRef.current)
          .then((s) => {
            if (gen === generation.current) update((m) => m.set(id, s));
          })
          .finally(() => {
            if (gen === generation.current) inFlight.current.delete(id);
          });
      }
    })();
    // Passes run when the referenced set changes, the kernel comes up (an
    // unbuilt source can then build), or a refresh is asked for — never because
    // a load landed (`sources` is read through the ref).
  }, [assemblyId, key, buildReady, refreshTick]);

  // Live references: catch up with edits made elsewhere when the tab regains focus.
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  useEffect(() => {
    if (!assemblyId) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [assemblyId, refresh]);

  const settled =
    owner === assemblyId &&
    docIds.every((id) => {
      const s = sources.get(id);
      return s && s.status !== "loading" && s.status !== "building";
    });
  return { sources, settled, refresh };
}
