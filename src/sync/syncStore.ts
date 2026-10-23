// Per-document Google Drive links, in their OWN IndexedDB database rather than
// a new store in "open-poly". Adding a store means bumping that database's
// version, and an upgrade waits for every other open connection to close — a
// tab still running an older build never closes its connection (it has no
// `versionchange` handler), so the freshly loaded tab would hang at boot. A
// separate database sidesteps that. The cost is that deleting a document can't
// drop its link in the same transaction; the engine treats a link whose
// document is gone as "removed from this device" and drops it then.

const DB_NAME = "open-poly-sync";
const DB_VERSION = 1;
const LINKS = "links";

/** How one local document relates to Google Drive, under one Google account
 *  (`account` = the email it was linked under; links made under another
 *  account are ignored, so switching accounts never cross-wires documents).
 *  Either linked to a Drive file, or opted out (`localOnly`). */
export interface SyncLink {
  docId: string;
  account: string;
  /** The Drive file this document syncs with. Absent when `localOnly`. */
  fileId?: string;
  /** Drive's `version` of that file at the last sync — any other value means
   *  it changed in Drive since. */
  remoteVersion?: string;
  /** docHash of what both sides held at the last sync. */
  syncedHash?: string;
  /** The local `updatedAt` at the last sync. Unchanged = no local edits, known
   *  without loading and hashing the full record. */
  syncedUpdatedAt?: number;
  /** The name at the last sync. A rename doesn't bump `updatedAt` (db.ts), so
   *  this is how a rename alone is noticed. */
  syncedName?: string;
  /** The user chose to keep this document off Drive. */
  localOnly?: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(LINKS)) req.result.createObjectStore(LINKS, { keyPath: "docId" });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a future version's upgrade through instead of blocking it — the
      // mistake this database exists to route around.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(LINKS, mode);
    const req = fn(t.objectStore(LINKS));
    t.oncomplete = () => resolve(req ? req.result : (undefined as T));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function listSyncLinks(): Promise<SyncLink[]> {
  return tx<SyncLink[]>("readonly", (s) => s.getAll());
}

export function putSyncLink(link: SyncLink): Promise<void> {
  return tx<void>("readwrite", (s) => {
    s.put(link);
  });
}

export function deleteSyncLink(docId: string): Promise<void> {
  return tx<void>("readwrite", (s) => {
    s.delete(docId);
  });
}

/** Test hook: drop the cached connection (see db.ts's twin). */
export function __resetSyncStoreForTests(): void {
  dbPromise = null;
}
