// Local-first persistence in the browser's IndexedDB. The parametric `Document`
// is plain JSON-serializable data, so we store records directly (structured
// clone). Two object stores, both keyed by document id:
//  • `documents` — the full payload (doc + cached meshes). Loaded ONLY for the
//    active document (boot / open / switch).
//  • `meta` — light metadata (name, dates, counts, thumbnail). This is all a
//    document list ever reads — full records carry the tessellation cache, and
//    deserializing every document's meshes just to show a picker would make
//    "open the Documents dialog" scale with total geometry, not document count.
// Every write goes through `putDoc`/`renameDoc`/`deleteDoc`, which update both
// stores in ONE transaction so they can't drift.
import type { Document } from "../document/types";
import type { ShapeMeshPayload } from "../kernel/types";
import type { SectionViewState } from "../document/sectionView";

const DB_NAME = "open-poly";
const DB_VERSION = 2;
const DOCS = "documents";
const META = "meta";

/** A persisted document plus light metadata. */
export interface StoredDoc {
  id: string;
  name: string;
  doc: Document;
  updatedAt: number;
  /** Absent on records written before DB v2. */
  createdAt?: number;
  /** Last-regenerated body meshes (plain JSON-serializable arrays). Saved so the
   *  viewport can paint the model INSTANTLY on load while the kernel re-runs the
   *  (expensive) full regen in the background — without them a heavy document
   *  shows a blank viewport until every feature rebuilds through OCCT. Purely a
   *  render-time cache: the parametric `doc` remains the source of truth, and the
   *  meshes are replaced the moment regen settles. Optional (older records and
   *  documents that never regenerated have none). */
  meshes?: { id: string; mesh: ShapeMeshPayload }[];
  /** Section-view UI state (plane ref, offset, flip, on/off) — pure view state,
   *  never part of `doc`/undo (see document/sectionView.ts), but persisted here
   *  so reopening a document restores it. Absent on records written before this
   *  field existed, and on any freshly-created document. */
  sectionView?: SectionViewState;
}

/** The list-view projection of a document — everything a picker needs, nothing
 *  a picker doesn't (no feature tree, no meshes). */
export interface DocMeta {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  featureCount: number;
  partCount: number;
  /** Small downscaled snapshot for the Documents dialog, written by the
   *  thumbnail capture in usePersistedDocuments. */
  thumb?: Blob;
}

/** Derive a meta row from a full record (thumb is carried separately — see
 *  `putDoc`, which preserves an existing thumbnail across autosaves). */
function metaOf(record: StoredDoc): DocMeta {
  return {
    id: record.id,
    name: record.name,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt ?? record.updatedAt,
    featureCount: record.doc.features.length,
    partCount: record.meshes?.length ?? 0,
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOCS)) {
        db.createObjectStore(DOCS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "id" });
        // v1 → v2: backfill a meta row for every existing document, inside the
        // upgrade transaction (the only place both stores are writable here).
        const t = req.transaction!;
        const docs = t.objectStore(DOCS);
        const meta = t.objectStore(META);
        docs.openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          meta.put(metaOf(cursor.value as StoredDoc));
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Run `fn` against both stores in one readwrite transaction; resolves on
 *  transaction COMPLETE (not first request success), so multi-request writes
 *  are atomic from the caller's point of view. */
async function dualTx<T>(fn: (docs: IDBObjectStore, meta: IDBObjectStore) => T): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction([DOCS, META], "readwrite");
    const result = fn(t.objectStore(DOCS), t.objectStore(META));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** Run a single-store read and resolve the request's result. */
async function readTx<T>(store: string, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Write a full document record + its derived meta row atomically. An existing
 *  thumbnail is preserved (autosave doesn't know about thumbs; only the
 *  explicit thumbnail capture path replaces them). */
export function putDoc(record: StoredDoc): Promise<void> {
  return dualTx((docs, meta) => {
    docs.put(record);
    const row = metaOf(record);
    const get = meta.get(record.id);
    get.onsuccess = () => {
      const prev = get.result as DocMeta | undefined;
      if (prev?.createdAt) row.createdAt = prev.createdAt;
      if (prev?.thumb) row.thumb = prev.thumb;
      meta.put(row);
    };
  });
}

/** Rename in both stores. Deliberately does NOT bump `updatedAt` — the model's
 *  content didn't change, so the list order shouldn't reshuffle. */
export function renameDoc(id: string, name: string): Promise<void> {
  return dualTx((docs, meta) => {
    const getDoc = docs.get(id);
    getDoc.onsuccess = () => {
      const rec = getDoc.result as StoredDoc | undefined;
      if (rec) docs.put({ ...rec, name });
    };
    const getMeta = meta.get(id);
    getMeta.onsuccess = () => {
      const row = getMeta.result as DocMeta | undefined;
      if (row) meta.put({ ...row, name });
    };
  });
}

/** Copy a document under a new identity (fresh id/name/dates; same content and
 *  cached meshes, so the copy paints instantly too). No thumb — the copy earns
 *  its own on first regen. Resolves the new record, or undefined if the source
 *  vanished. */
export async function duplicateDoc(sourceId: string, newId: string, name: string): Promise<StoredDoc | undefined> {
  const src = await loadDoc(sourceId);
  if (!src) return undefined;
  const now = Date.now();
  const copy: StoredDoc = { ...src, id: newId, name, createdAt: now, updatedAt: now };
  await dualTx((docs, meta) => {
    docs.put(copy);
    meta.put(metaOf(copy));
  });
  return copy;
}

const thumbListeners = new Set<() => void>();

/** Called after any thumbnail is replaced, so an open Documents list can
 *  repaint its tiles: a document seen for the first time on this device has
 *  none until it has drawn once, which is often just after the list opened. */
export function onThumbChanged(fn: () => void): () => void {
  thumbListeners.add(fn);
  return () => thumbListeners.delete(fn);
}

/** Replace a document's list thumbnail (meta only — the full record doesn't
 *  carry it). No-op if the document vanished. */
export async function setThumb(id: string, thumb: Blob): Promise<void> {
  await dualTx((_docs, meta) => {
    const get = meta.get(id);
    get.onsuccess = () => {
      const row = get.result as DocMeta | undefined;
      if (row) meta.put({ ...row, thumb });
    };
  });
  for (const fn of thumbListeners) fn();
}

export function loadDoc(id: string): Promise<StoredDoc | undefined> {
  return readTx<StoredDoc | undefined>(DOCS, (s) => s.get(id));
}

export function deleteDoc(id: string): Promise<void> {
  return dualTx((docs, meta) => {
    docs.delete(id);
    meta.delete(id);
  });
}

/** All documents' metadata, most-recently-updated first — the ONLY list read
 *  (never load full records to browse). */
export async function listMeta(): Promise<DocMeta[]> {
  const all = await readTx<DocMeta[]>(META, (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

// --- Active-document pointer (localStorage) --------------------------------
// Which document the tab is looking at. NOT "most recent in the DB": another
// tab may have touched a different doc more recently, and a refresh should
// reopen what YOU were working on. Guarded — localStorage can throw in private
// browsing / blocked-storage contexts, and persistence is best-effort there.

const ACTIVE_KEY = "openpoly.activeDocId";

export function getActiveDocId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveDocId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* best-effort */
  }
}

/** Test hook: drop the cached connection so a test can swap the global
 *  `indexedDB` (fake-indexeddb) for a fresh, isolated database. */
export function __resetDBForTests(): void {
  dbPromise = null;
}
