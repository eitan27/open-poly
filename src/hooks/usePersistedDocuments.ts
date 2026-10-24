// Document persistence: the IndexedDB boot-restore, the debounced
// autosave, thumbnail capture, the multi-document actions (open/new/duplicate/
// delete/rename/export/import), and the same-document multi-tab guard.
//
// Split out of App.tsx, which keeps everything else — the document model, the
// kernel, selection, sketch mode, every dialog — and reaches in only through the
// params below plus the handlers returned. The coupling really is that narrow,
// which is what made this extractable at all; what held it up is that none of it
// is pure. It is IndexedDB, BroadcastChannel, timers and a canvas, so it could
// not be unit-tested at all until the suite could opt into jsdom per file.
//
// The logic is unchanged from App.tsx — same effects, same dependency arrays,
// same comments — with two adaptations that decouple it from App.tsx internals:
//   - `setVariablesOpen(doc.variables.length < VARS_OPEN_THRESHOLD)` became the
//     `onDocumentAdopted` callback: the Variables panel's default open state is
//     a panel concern this hook has no reason to know. It is read through a ref
//     so the boot-restore effect's `[resetDoc]` array (which must run exactly
//     once) does not have to widen to cover a fresh closure every render.
//   - `downloadBlob`/`safeFilename` are passed in rather than duplicated,
//     because App.tsx still uses both for the STL/STEP exports.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Document } from "../document/types";
import { DEFAULT_SECTION_VIEW, type SectionViewState } from "../document/sectionView";
import { createDocument, genId, migrateDocument } from "../document/document";
import {
  deleteDoc,
  duplicateDoc,
  getActiveDocId,
  listMeta,
  loadDoc,
  putDoc,
  renameDoc,
  setActiveDocId,
  setThumb,
  type StoredDoc,
} from "../storage/db";
import { copyName, dedupeName, isUntitled, nextUntitled } from "../storage/docNames";
import { SITE_TITLE } from "../lib/site";
import { parseDocFile, serializeDocFile } from "../storage/docFile";
import { CorruptDocError } from "../storage/docErrors";
import type { Selection } from "../selection/types";
import type { FeatureMesh, ViewportApi } from "../viewport/types";

type RawMesh = { id: string; mesh: FeatureMesh["mesh"] };

/** Why the working document could not be restored, for the dismissible banner.
 *  "corrupted" = the record loaded but its content didn't migrate (Export as
 *  JSON still works on it); "unreadable" = the record itself couldn't be read
 *  from IndexedDB, which is rarer and where Export may not help either. */
export type DocRecoveryBanner = { kind: "corrupted"; name: string } | { kind: "unreadable" } | null;

export interface UsePersistedDocumentsParams {
  doc: Document;
  /** Replaces the document AND clears undo history — a document boundary. */
  resetDoc: (doc: Document) => void;
  rawMeshes: RawMesh[];
  setRawMeshes: (meshes: RawMesh[]) => void;
  /** Bumped each time a kernel regen settles; drives the thumbnail refresh. */
  regenSettledSeq: number;
  sectionView: SectionViewState;
  setSectionView: (view: SectionViewState) => void;
  setSelection: (selection: Selection[]) => void;
  viewApiRef: RefObject<ViewportApi | null>;
  /** Called whenever a document is loaded or adopted (boot restore, open, new,
   *  duplicate, delete's fallback, import). Read through a ref internally, so
   *  passing a fresh closure every render is safe. */
  onDocumentAdopted: (doc: Document) => void;
  /** Saves a Blob to the user's machine — shared with App.tsx's other exports. */
  downloadBlob: (blob: Blob, filename: string) => void;
  /** Strips characters that are awkward in filenames across platforms. */
  safeFilename: (name: string) => string;
}

export interface UsePersistedDocumentsResult {
  /** The IndexedDB record id of the working document. Assigned synchronously on
   *  first render, so `.current` is never null once the hook has run. */
  docIdRef: RefObject<string | null>;
  docName: string;
  setDocName: (name: string) => void;
  /** State mirror of `docIdRef` for anything that must re-render or re-run when
   *  the active document changes (the dialog highlight, the multi-tab guard). */
  activeId: string | null;
  docInOtherTab: boolean;
  docRecoveryBanner: DocRecoveryBanner;
  setDocRecoveryBanner: (banner: DocRecoveryBanner) => void;
  openDocument: (id: string) => Promise<void>;
  newDocument: () => Promise<void>;
  duplicateDocument: (id: string) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  renameDocument: (id: string, name: string) => Promise<void>;
  exportDocument: (id: string) => Promise<void>;
  importDocumentFile: (file: File) => Promise<string | null>;
  /** Persist the working document now (Drive sync calls this before a pass). */
  flushSave: () => Promise<void>;
  /** True if the working document hasn't changed since it was last flushed or
   *  adopted — the only time Drive sync may replace it under the user. */
  canReplaceActive: () => boolean;
  /** Show a record Drive sync just wrote for the working document. Clears undo,
   *  like any other document boundary. */
  adoptExternalRecord: (record: StoredDoc) => void;
}

export function usePersistedDocuments({
  doc,
  resetDoc,
  rawMeshes,
  setRawMeshes,
  regenSettledSeq,
  sectionView,
  setSectionView,
  setSelection,
  viewApiRef,
  onDocumentAdopted,
  downloadBlob,
  safeFilename,
}: UsePersistedDocumentsParams): UsePersistedDocumentsResult {
  // Every collaborator App.tsx passes in is held in a ref, so the dependency
  // arrays below stay EXACTLY as narrow as they were in App.tsx. They were
  // useState setters there — stable by construction — and the boot-restore
  // effect's `[resetDoc]` is load-bearing: it must run once, and once only.
  // Keying it on props would make that guarantee depend on the caller never
  // passing a fresh closure, which is not a promise this file can enforce.
  const onDocumentAdoptedRef = useRef(onDocumentAdopted);
  onDocumentAdoptedRef.current = onDocumentAdopted;
  const setRawMeshesRef = useRef(setRawMeshes);
  setRawMeshesRef.current = setRawMeshes;
  const setSectionViewRef = useRef(setSectionView);
  setSectionViewRef.current = setSectionView;
  const setSelectionRef = useRef(setSelection);
  setSelectionRef.current = setSelection;
  const viewApiRefRef = useRef(viewApiRef);
  viewApiRefRef.current = viewApiRef;
  const downloadBlobRef = useRef(downloadBlob);
  downloadBlobRef.current = downloadBlob;
  const safeFilenameRef = useRef(safeFilename);
  safeFilenameRef.current = safeFilename;

  // The IndexedDB record id for the working document, and whether the initial
  // load has completed (autosave waits for it so the placeholder doesn't
  // clobber a saved doc).
  const docIdRef = useRef<string | null>(null);
  if (docIdRef.current === null) docIdRef.current = genId();
  const [persistLoaded, setPersistLoaded] = useState(false);
  // Document identity. The name lives OUTSIDE the parametric
  // `Document` (rename is a storage-level operation, not an undoable model
  // edit); `createdAt` rides along so autosaves preserve it.
  const [docName, setDocName] = useState("Untitled");
  const docCreatedAtRef = useRef<number>(Date.now());
  const [activeId, setActiveId] = useState<string | null>(null);
  // True while the SAME document is open in another tab (BroadcastChannel).
  const [docInOtherTab, setDocInOtherTab] = useState(false);
  const tabIdRef = useRef(genId());
  // Set once, at most, by the boot-restore effect when the saved active/most-
  // recent document couldn't be opened — a dismissible banner pointing at the
  // Documents dialog's existing Export/Delete actions, rather than the app
  // silently falling back to a blank doc.
  const [docRecoveryBanner, setDocRecoveryBanner] = useState<DocRecoveryBanner>(null);
  // What the last flush (or adoption) wrote, against the live values, for
  // canReplaceActive. Refs, because Drive sync asks between renders.
  const lastFlushedRef = useRef<{ doc: Document; name: string } | null>(null);
  const liveRef = useRef({ doc, name: docName });
  liveRef.current = { doc, name: docName };

  // Restore the working document from IndexedDB on first load: the tab's
  // active-document pointer (localStorage) first — NOT "most recent", which
  // another tab may have touched — falling back to the most recent meta row,
  // else keeping the fresh seed under its own id. Autosave only starts once
  // this completes so the placeholder can't overwrite a saved document.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const activeId = getActiveDocId();
        let record: StoredDoc | undefined;
        // Which document (if any) failed to open — surfaced as a dismissible
        // banner rather than silently discarded, since the failure mode used to
        // be "the app quietly falls back to a blank doc and the next autosave
        // overwrites the broken record" (see docIdRef note below).
        let recovery: DocRecoveryBanner = null;
        try {
          record = activeId ? await loadDoc(activeId) : undefined;
          if (!record) {
            const metas = await listMeta();
            if (metas.length > 0) record = await loadDoc(metas[0].id);
          }
        } catch (err) {
          console.warn("could not read saved document:", err);
          recovery = { kind: "unreadable" };
        }
        if (cancelled) return;
        if (record) {
          try {
            // Validate BEFORE touching docIdRef/state: migrateDocument throws on
            // malformed persisted data (e.g. `features` isn't an array). If it
            // threw AFTER docIdRef already pointed at this record, the fresh
            // seed doc would render under the BROKEN record's id, and the next
            // autosave would silently overwrite the corrupt data with an empty
            // box — the exact "quiet data loss" this fix exists to prevent.
            const migrated = migrateDocument(record.doc);
            docIdRef.current = record.id;
            docCreatedAtRef.current = record.createdAt ?? record.updatedAt;
            setDocName(record.name || "Untitled");
            // Paint the last-saved meshes immediately so a heavy document shows
            // its geometry at once — the regen `resetDoc` kicks off (which
            // rebuilds every feature through OCCT and can take many seconds)
            // then swaps in fresh meshes when it settles. Without this the
            // viewport stays blank until that full rebuild finishes.
            if (record.meshes?.length) setRawMeshesRef.current(record.meshes);
            resetDoc(migrated);
            setSectionViewRef.current(record.sectionView ?? DEFAULT_SECTION_VIEW);
            // Default the Variables section open/collapsed by the restored count.
            onDocumentAdoptedRef.current(migrated);
          } catch (err) {
            console.warn("saved document is corrupt:", err);
            recovery = { kind: "corrupted", name: record.name || "Untitled" };
          }
        }
        if (recovery) setDocRecoveryBanner(recovery);
        // Adopt whichever doc we ended up with (restored, or the fresh seed —
        // docIdRef never adopted a record that failed to open) as the tab's
        // active document.
        setActiveDocId(docIdRef.current!);
        setActiveId(docIdRef.current!);
      } finally {
        if (!cancelled) setPersistLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resetDoc]);

  // Autosave the working document to IndexedDB (debounced) after each change.
  // Meshes ride along so the next load can paint instantly (see the restore
  // effect); `rawMeshes` is a dependency so a completed regen re-saves the fresh
  // geometry — a doc-only edit persists with the meshes that are current when the
  // debounce fires (regen typically settles first, so they match the doc).
  // `putDoc` writes the full record AND its meta row atomically;
  // `docName` is a dependency so a rename persists through the same path.
  useEffect(() => {
    if (!persistLoaded) return;
    const t = setTimeout(() => {
      putDoc({
        id: docIdRef.current!,
        name: docName,
        doc,
        updatedAt: Date.now(),
        createdAt: docCreatedAtRef.current,
        meshes: rawMeshes,
        sectionView,
      }).catch((err) => console.warn("autosave failed:", err));
    }, 600);
    return () => clearTimeout(t);
  }, [doc, rawMeshes, docName, persistLoaded, sectionView]);

  // Mirror the document name to the browser tab — but only once there is a name
  // worth mirroring. A first visit (and every crawl, which starts with an empty
  // IndexedDB) would otherwise title the page "Untitled — Open Poly", which is
  // exactly what Google indexed.
  useEffect(() => {
    document.title = isUntitled(docName) ? SITE_TITLE : `${docName} — Open Poly`;
  }, [docName]);

  // --- Multi-document actions -----------------------------------------------

  /** Persist the working document NOW (same payload as the debounced autosave).
   *  Called before switching away so the last ≤600 ms of edits can't be lost;
   *  the pending debounce timer is cleared by its own effect when state changes,
   *  and a double-write is harmless. */
  const flushSave = useCallback(() => {
    if (!persistLoaded) return Promise.resolve();
    lastFlushedRef.current = { doc, name: docName };
    return putDoc({
      id: docIdRef.current!,
      name: docName,
      doc,
      updatedAt: Date.now(),
      createdAt: docCreatedAtRef.current,
      meshes: rawMeshes,
      sectionView,
    }).catch((err) => console.warn("flush save failed:", err));
  }, [doc, docName, rawMeshes, persistLoaded, sectionView]);

  /** Snapshot the CURRENT viewport into `meta.thumb` for `docId`, downscaled
   *  to ~256 px (offscreen canvas — capturePNG is Retina-sized, and a 2×/4×
   *  thumbnail would quadruple the stored bytes for no visible gain in a 56 px
   *  slot). Fire-and-forget: a failed capture just keeps the old thumb. */
  // When the open document's thumbnail was last captured (throttles recapture).
  const thumbAtRef = useRef<{ id: string; at: number } | null>(null);
  // A capture that couldn't be taken (tab hidden) or came back empty: the
  // document still owes a thumbnail, taken when the tab is next visible.
  const thumbOwedRef = useRef<string | null>(null);
  const captureThumb = useCallback((docId: string) => {
    // A hidden tab may not keep a WebGL drawing buffer, so its capture can
    // read back empty — and an empty capture saved as JPEG is a black tile
    // (that would also be sent to Drive).
    if (document.visibilityState !== "visible") {
      thumbOwedRef.current = docId;
      return;
    }
    // `plain` suppresses selection/hover highlights for the capture frame — a
    // thumbnail with an orange "selected" part would be misleading in the list.
    const dataUrl = viewApiRefRef.current.current?.capturePNG({ plain: true });
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
      const w = 256;
      const h = Math.max(1, Math.round((img.height / img.width) * w));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      // The scene's background is opaque and never pure black, so a real
      // capture has opaque, lit pixels; transparent or all-black means the
      // render didn't reach the buffer. Keep the old thumbnail and owe one.
      if (isBlankCapture(ctx.getImageData(0, 0, w, h).data)) {
        thumbOwedRef.current = docId;
        if (thumbAtRef.current?.id === docId) thumbAtRef.current = null; // next settle retries
        return;
      }
      if (thumbOwedRef.current === docId) thumbOwedRef.current = null;
      canvas.toBlob(
        (blob) => {
          if (blob) setThumb(docId, blob).catch(() => {});
        },
        "image/jpeg",
        0.75,
      );
    };
    img.src = dataUrl;
  }, []);

  // Refresh the thumbnail when a regen settles, at most once per 30 s per
  // document (never per keystroke — regens can settle several times a second
  // while dragging a dimension). Switch-away also captures (see openDocument).
  // Set when a document is switched in: its first settle frames it (Home view),
  // so the model starts in view and so does its thumbnail — the camera would
  // otherwise keep the previous document's framing. Not on boot (the default
  // camera is what it was), and not when sync swaps in a new version of the
  // open document (the camera stays where the user left it).
  const fitOnSettleRef = useRef(false);
  useEffect(() => {
    if (!persistLoaded || regenSettledSeq === 0) return;
    const id = docIdRef.current!;
    if (fitOnSettleRef.current) {
      fitOnSettleRef.current = false;
      viewApiRefRef.current.current?.homeView();
      thumbAtRef.current = null; // recapture in the new framing
    }
    // Throttled, not dropped: a settle inside the window is captured when the
    // window ends, so the thumbnail always catches up with the latest state.
    // (Each later settle re-arms the same deadline; switching documents clears it.)
    const last = thumbAtRef.current;
    const wait = last && last.id === id ? Math.max(0, 30_000 - (Date.now() - last.at)) : 0;
    // Give the freshly settled meshes one frame to actually paint.
    const t = setTimeout(() => {
      thumbAtRef.current = { id, at: Date.now() };
      captureThumb(id);
    }, wait + 300);
    return () => clearTimeout(t);
  }, [regenSettledSeq, persistLoaded, captureThumb]);

  // Pay an owed thumbnail once the tab is visible again (after a frame paints).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onVisible = () => {
      if (document.visibilityState !== "visible" || thumbOwedRef.current !== docIdRef.current) return;
      const id = thumbOwedRef.current!;
      t = setTimeout(() => captureThumb(id), 300);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(t);
    };
  }, [captureThumb]);

  /** Make `record` the working document. Ordering is load-bearing in TWO ways:
   *  1. `migrateDocument` runs FIRST, before anything is mutated — it throws on
   *     malformed persisted data, and if that happened after `docIdRef` already
   *     pointed at `record.id`, the app would be left in an inconsistent state
   *     (docIdRef says we're on the new doc; `doc` state is still the old one),
   *     and the next autosave would silently overwrite `record`'s real content.
   *  2. Once validated, `docIdRef` updates BEFORE `resetDoc`, so the first
   *     autosave after a switch can never write the incoming document's content
   *     under the outgoing id (the clobber bug — covered by verify-multidoc-
   *     m2.mjs). The saved meshes paint instantly while the kernel regen
   *     rebuilds behind.
   *  Throws (uncaught) if `record.doc` doesn't migrate — callers decide how to
   *  surface that (the Documents dialog shows it; the boot-restore effect
   *  falls back to a fresh doc + a recovery banner). */
  const adoptRecord = useCallback(
    (record: StoredDoc) => {
      const migrated = migrateDocument(record.doc);
      docIdRef.current = record.id;
      docCreatedAtRef.current = record.createdAt ?? record.updatedAt;
      lastFlushedRef.current = { doc: migrated, name: record.name || "Untitled" };
      setDocName(record.name || "Untitled");
      setActiveId(record.id);
      setActiveDocId(record.id);
      setSelectionRef.current([]);
      setRawMeshesRef.current(record.meshes ?? []);
      resetDoc(migrated); // clears undo history — a document boundary
      fitOnSettleRef.current = true;
      setSectionViewRef.current(record.sectionView ?? DEFAULT_SECTION_VIEW);
      onDocumentAdoptedRef.current(migrated);
    },
    [resetDoc],
  );

  const openDocument = useCallback(
    async (id: string) => {
      if (id === docIdRef.current) return;
      captureThumb(docIdRef.current!); // the canvas still shows the outgoing doc
      await flushSave();
      let record: StoredDoc | undefined;
      try {
        record = await loadDoc(id);
      } catch (err) {
        throw new Error(`Could not read this document from storage: ${String((err as Error)?.message ?? err)}`);
      }
      if (!record) throw new Error("This document no longer exists — it may have been deleted.");
      try {
        adoptRecord(record);
      } catch {
        // Swallow the raw parse error (e.g. a TypeError from migrateDocument) —
        // not actionable for the user. It's still in Documents either way: they
        // can Export as JSON (works regardless of doc validity) then Delete it.
        throw new CorruptDocError(record.name);
      }
    },
    [flushSave, adoptRecord, captureThumb],
  );

  const newDocument = useCallback(async () => {
    captureThumb(docIdRef.current!);
    await flushSave();
    const metas = await listMeta();
    const now = Date.now();
    const record: StoredDoc = {
      id: genId(),
      name: nextUntitled(metas.map((m) => m.name)),
      doc: createDocument(),
      createdAt: now,
      updatedAt: now,
    };
    await putDoc(record); // exists in the list before it's ever edited
    adoptRecord(record);
  }, [flushSave, adoptRecord, captureThumb]);

  const duplicateDocument = useCallback(
    async (id: string) => {
      captureThumb(docIdRef.current!);
      // Flush first so duplicating the ACTIVE doc copies its latest edits.
      if (id === docIdRef.current) await flushSave();
      const metas = await listMeta();
      const source = metas.find((m) => m.id === id);
      const copy = await duplicateDoc(
        id,
        genId(),
        copyName(
          source?.name ?? "Untitled",
          metas.map((m) => m.name),
        ),
      );
      if (!copy) throw new Error("This document no longer exists — it may have been deleted.");
      try {
        adoptRecord(copy); // throws if the SOURCE was itself corrupt (copied verbatim)
      } catch {
        throw new CorruptDocError(copy.name);
      }
    },
    [flushSave, adoptRecord, captureThumb],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      // No flush — deleting the active doc means discarding it.
      await deleteDoc(id);
      if (id !== docIdRef.current) return;
      // The active doc is gone: fall back to the next most recent, else seed.
      const metas = await listMeta();
      const next = metas.length ? await loadDoc(metas[0].id) : undefined;
      if (next) {
        adoptRecord(next);
      } else {
        const now = Date.now();
        const record: StoredDoc = {
          id: genId(),
          name: "Untitled",
          doc: createDocument(),
          createdAt: now,
          updatedAt: now,
        };
        await putDoc(record);
        adoptRecord(record);
      }
    },
    [adoptRecord],
  );

  const renameDocument = useCallback(async (id: string, name: string) => {
    // State first: for the active doc this alone persists (docName is an
    // autosave dependency), even if the record hasn't been written yet —
    // renameDoc is then a no-op-if-absent stores update.
    if (id === docIdRef.current) setDocName(name);
    await renameDoc(id, name);
  }, []);

  /** Save a document as `.openpoly.json` (envelope + parametric doc; cached
   *  meshes deliberately excluded — see storage/docFile.ts). */
  const exportDocument = useCallback(
    async (id: string) => {
      if (id === docIdRef.current) await flushSave(); // export the latest edits
      const record = await loadDoc(id);
      if (!record) return;
      const blob = new Blob([serializeDocFile(record.name, record.doc)], { type: "application/json" });
      downloadBlobRef.current(blob, `${safeFilenameRef.current(record.name)}.openpoly.json`);
    },
    [flushSave],
  );

  /** Import a `.openpoly.json` file as a NEW document (fresh id — an import
   *  must never overwrite an existing doc) and open it. Resolves an error
   *  message for the dialog to show, or null on success. */
  const importDocumentFile = useCallback(
    async (file: File): Promise<string | null> => {
      let parsed: ReturnType<typeof parseDocFile>;
      try {
        parsed = parseDocFile(await file.text());
      } catch (err) {
        return String((err as Error).message ?? err);
      }
      captureThumb(docIdRef.current!);
      await flushSave();
      const metas = await listMeta();
      const now = Date.now();
      const record: StoredDoc = {
        id: genId(),
        name: dedupeName(
          parsed.name,
          metas.map((m) => m.name),
        ),
        doc: migrateDocument(parsed.doc),
        createdAt: now,
        updatedAt: now,
      };
      await putDoc(record);
      adoptRecord(record);
      return null;
    },
    [flushSave, adoptRecord, captureThumb],
  );

  // Same-document multi-tab guard: announce which doc this tab holds; if
  // another tab announces (or answers for) the same doc, both show a warning.
  // Last-writer-wins autosaves make concurrent edits genuinely dangerous, so
  // surface it rather than silently clobbering.
  useEffect(() => {
    if (!activeId || typeof BroadcastChannel === "undefined") return;
    setDocInOtherTab(false);
    const tab = tabIdRef.current;
    const ch = new BroadcastChannel("openpoly-docs");
    ch.onmessage = (e: MessageEvent<{ t: string; docId: string; tab: string }>) => {
      const m = e.data;
      if (!m || m.tab === tab || m.docId !== activeId) return;
      if (m.t === "open") {
        setDocInOtherTab(true);
        ch.postMessage({ t: "present", docId: activeId, tab });
      } else if (m.t === "present") {
        setDocInOtherTab(true);
      } else if (m.t === "leave") {
        // The other holder left; re-announce to detect any remaining ones.
        setDocInOtherTab(false);
        ch.postMessage({ t: "open", docId: activeId, tab });
      }
    };
    ch.postMessage({ t: "open", docId: activeId, tab });
    return () => {
      ch.postMessage({ t: "leave", docId: activeId, tab });
      ch.close();
    };
  }, [activeId]);

  const canReplaceActive = useCallback(() => {
    const flushed = lastFlushedRef.current;
    return !!flushed && flushed.doc === liveRef.current.doc && flushed.name === liveRef.current.name;
  }, []);

  const adoptExternalRecord = useCallback(
    (record: StoredDoc) => {
      try {
        adoptRecord(record);
        fitOnSettleRef.current = false; // a new version of the open doc: keep the camera
      } catch (err) {
        console.warn("synced document could not be opened:", err);
      }
    },
    [adoptRecord],
  );

  return {
    docIdRef,
    docName,
    setDocName,
    activeId,
    docInOtherTab,
    docRecoveryBanner,
    setDocRecoveryBanner,
    openDocument,
    newDocument,
    duplicateDocument,
    deleteDocument,
    renameDocument,
    exportDocument,
    importDocumentFile,
    flushSave,
    canReplaceActive,
    adoptExternalRecord,
  };
}

/** True when an RGBA readback holds no picture: every sampled pixel fully
 *  transparent, or every one pure black. Samples a sparse grid — a real
 *  capture is the opaque, dark-grey-or-lighter viewport background at least. */
export function isBlankCapture(rgba: Uint8ClampedArray): boolean {
  let opaque = false;
  let lit = false;
  for (let i = 0; i < rgba.length; i += 4 * 37) {
    if (rgba[i + 3] > 0) opaque = true;
    if (rgba[i] > 8 || rgba[i + 1] > 8 || rgba[i + 2] > 8) lit = true;
    if (opaque && lit) return false;
  }
  return true;
}
