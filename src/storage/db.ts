// Local-first persistence in the browser's IndexedDB. The parametric `Document`
// is plain JSON-serializable data, so we store records directly (structured
// clone). One object store keyed by document id; the app autosaves the working
// document and restores it on load. (Multi-document UI can build on this.)
import type { Document } from "../document/types";

const DB_NAME = "open-poly";
const DB_VERSION = 1;
const STORE = "documents";

/** A persisted document plus light metadata. */
export interface StoredDoc {
  id: string;
  name: string;
  doc: Document;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Run `fn` against the documents store in a transaction and resolve its result. */
async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function saveDoc(record: StoredDoc): Promise<IDBValidKey> {
  return tx("readwrite", (s) => s.put(record));
}

export function loadDoc(id: string): Promise<StoredDoc | undefined> {
  return tx<StoredDoc | undefined>("readonly", (s) => s.get(id));
}

export function deleteDoc(id: string): Promise<undefined> {
  return tx("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
}

/** All stored documents, most-recently-updated first. */
export async function listDocs(): Promise<StoredDoc[]> {
  const all = await tx<StoredDoc[]>("readonly", (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
