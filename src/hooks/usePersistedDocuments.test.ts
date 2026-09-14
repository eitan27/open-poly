// @vitest-environment jsdom
//
// The first tests this subsystem has ever had. It is why Wave C waited for
// Wave B: every path here is effectful — IndexedDB, localStorage,
// BroadcastChannel, timers, a canvas — so no pure test could reach it, and the
// reference branch that first extracted it said as much and verified by hand.
//
// Setup mirrors src/storage/db.test.ts: a FRESH fake IDBFactory per test plus
// `__resetDBForTests()`, because the db module caches its connection. Storage
// comes from installWebStorage() — vitest's jsdom globals hand back a bare `{}`
// for localStorage (see src/test/webStorage.ts).

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { __resetDBForTests, listMeta, loadDoc, putDoc, setActiveDocId, type StoredDoc } from "../storage/db";
import { createDocument } from "../document/document";
import { serializeDocFile } from "../storage/docFile";
import { installWebStorage } from "../test/webStorage";
import { usePersistedDocuments, type UsePersistedDocumentsParams } from "./usePersistedDocuments";
import type { Document } from "../document/types";
import type { ViewportApi } from "../viewport/Viewport";

const record = (id: string, name: string, over: Partial<StoredDoc> = {}): StoredDoc => ({
  id,
  name,
  doc: createDocument(),
  updatedAt: Date.now(),
  createdAt: Date.now(),
  ...over,
});

/** The params App.tsx passes, with spies so a test can assert what the hook
 *  asked the app to do. Overridable per test. */
function params(over: Partial<UsePersistedDocumentsParams> = {}) {
  const viewApiRef = { current: null as ViewportApi | null };
  // Object.assign rather than a spread + `satisfies`: spreading `over` widens
  // each spy to `Mock | the plain signature`, and `.mock` then doesn't exist on
  // the union. tsc -b catches that; vitest alone does not.
  const base = {
    doc: createDocument(),
    resetDoc: vi.fn(),
    rawMeshes: [] as UsePersistedDocumentsParams["rawMeshes"],
    setRawMeshes: vi.fn(),
    regenSettledSeq: 0,
    sectionView: { enabled: false } as UsePersistedDocumentsParams["sectionView"],
    setSectionView: vi.fn(),
    setSelection: vi.fn(),
    viewApiRef,
    onDocumentAdopted: vi.fn(),
    downloadBlob: vi.fn(),
    safeFilename: (n: string) => n.replace(/[^a-z0-9_-]+/gi, "_"),
  };
  return Object.assign(base, over);
}

/** Render the hook and wait for the boot-restore effect to finish. It sets
 *  `activeId` in its `finally`, so that is the signal it has settled. */
async function boot(over: Partial<UsePersistedDocumentsParams> = {}) {
  const p = params(over);
  const r = renderHook(() => usePersistedDocuments(p));
  await waitFor(() => expect(r.result.current.activeId).not.toBeNull());
  return { ...r, p };
}

/** jsdom implements neither `Blob.prototype.text` nor `File.prototype.text`,
 *  which every browser has and which importDocumentFile calls. Shim it rather
 *  than reshape the hook around a test-environment gap. */
function fileWithText(text: string, name: string): File {
  const f = new File([text], name, { type: "application/json" });
  Object.defineProperty(f, "text", { value: async () => text });
  return f;
}

beforeEach(() => {
  installWebStorage();
  globalThis.indexedDB = new IDBFactory();
  __resetDBForTests();
});
afterEach(() => {
  // Unmount explicitly: vitest.config.ts does not set `globals: true`, so
  // @testing-library's automatic cleanup never registers. Without this a
  // previous test's hook stays mounted, its debounced autosave fires during a
  // LATER test and writes a record into that test's fresh IDBFactory — which
  // showed up as "deleting the last document" finding a stray `Untitled 2` and
  // adopting it instead of seeding. It passed in isolation and failed in the
  // suite, which is the signature of leaked state rather than a real defect.
  cleanup();
  vi.useRealTimers();
});

describe("boot restore", () => {
  it("seeds a fresh document when storage is empty", async () => {
    const { result, p } = await boot();
    expect(result.current.docName).toBe("Untitled");
    expect(result.current.docIdRef.current).toBeTruthy();
    expect(result.current.activeId).toBe(result.current.docIdRef.current);
    expect(result.current.docRecoveryBanner).toBeNull();
    // Nothing was restored, so the document was never replaced.
    expect(p.resetDoc).not.toHaveBeenCalled();
  });

  it("restores the tab's active document, not merely the most recent", async () => {
    // The distinction matters: another tab may have touched a newer record, and
    // this tab should still come back to the one IT had open.
    await putDoc(record("older", "Older", { updatedAt: 1 }));
    await putDoc(record("newer", "Newer", { updatedAt: 9_999_999 }));
    setActiveDocId("older");
    const { result } = await boot();
    expect(result.current.docName).toBe("Older");
    expect(result.current.docIdRef.current).toBe("older");
  });

  it("falls back to the most recent when there is no active pointer", async () => {
    await putDoc(record("a", "A", { updatedAt: 1 }));
    await putDoc(record("b", "B", { updatedAt: 9_999_999 }));
    const { result } = await boot();
    expect(result.current.docName).toBe("B");
  });

  it("paints the saved meshes immediately, so a heavy document is not blank", async () => {
    const meshes = [{ id: "m1", mesh: {} as never }];
    await putDoc(record("m", "Meshy", { meshes }));
    setActiveDocId("m");
    const { p } = await boot();
    expect(p.setRawMeshes).toHaveBeenCalledWith(meshes);
  });

  it("adopts the restored document and tells the app about it", async () => {
    await putDoc(record("x", "Restored"));
    setActiveDocId("x");
    const { p } = await boot();
    expect(p.resetDoc).toHaveBeenCalledTimes(1);
    expect(p.onDocumentAdopted).toHaveBeenCalledTimes(1);
  });

  it("names an empty record 'Untitled' rather than showing a blank title", async () => {
    await putDoc(record("x", ""));
    setActiveDocId("x");
    const { result } = await boot();
    expect(result.current.docName).toBe("Untitled");
  });
});

describe("boot restore — the corrupt-record path", () => {
  /** A record whose `doc` cannot migrate (`features` is not an array). */
  const corrupt = (id: string, name: string) =>
    ({ ...record(id, name), doc: { features: "not-an-array" } as unknown as Document }) satisfies StoredDoc;

  it("surfaces a banner instead of silently falling back to a blank document", async () => {
    await putDoc(corrupt("bad", "Broken"));
    setActiveDocId("bad");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await boot();
    expect(result.current.docRecoveryBanner).toEqual({ kind: "corrupted", name: "Broken" });
    warn.mockRestore();
  });

  it("NEVER adopts the broken record's id — the quiet-data-loss guard", async () => {
    // If docIdRef pointed at the corrupt record, the next autosave would
    // overwrite its real content with the fresh seed. This is the whole reason
    // migrateDocument runs before anything is mutated.
    await putDoc(corrupt("bad", "Broken"));
    setActiveDocId("bad");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result, p } = await boot();
    expect(result.current.docIdRef.current).not.toBe("bad");
    expect(p.resetDoc).not.toHaveBeenCalled();
    // And the record is still there to be exported/deleted by the user.
    expect(await loadDoc("bad")).toBeTruthy();
    warn.mockRestore();
  });

  it("the banner can be dismissed", async () => {
    await putDoc(corrupt("bad", "Broken"));
    setActiveDocId("bad");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await boot();
    act(() => result.current.setDocRecoveryBanner(null));
    expect(result.current.docRecoveryBanner).toBeNull();
    warn.mockRestore();
  });
});

describe("autosave", () => {
  it("writes the working document after the debounce, not before", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = await boot();
    const id = result.current.docIdRef.current!;
    expect(await loadDoc(id)).toBeUndefined(); // nothing yet
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await waitFor(async () => expect(await loadDoc(id)).toBeTruthy());
  });

  it("persists a rename through the same path", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = await boot();
    const id = result.current.docIdRef.current!;
    await act(async () => {
      result.current.setDocName("Bracket");
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
    await waitFor(async () => expect((await loadDoc(id))?.name).toBe("Bracket"));
  });

  it("preserves createdAt across saves — it is not reset on every write", async () => {
    await putDoc(record("x", "X", { createdAt: 12_345 }));
    setActiveDocId("x");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = await boot();
    await act(async () => {
      result.current.setDocName("Renamed");
      vi.advanceTimersByTime(700);
    });
    await waitFor(async () => expect((await loadDoc("x"))?.createdAt).toBe(12_345));
  });
});

describe("multi-document actions", () => {
  it("newDocument creates a record that exists in the list before it is edited", async () => {
    const { result } = await boot();
    const firstId = result.current.docIdRef.current;
    await act(async () => {
      await result.current.newDocument();
    });
    expect(result.current.docIdRef.current).not.toBe(firstId);
    const metas = await listMeta();
    expect(metas.some((m) => m.id === result.current.docIdRef.current)).toBe(true);
  });

  it("newDocument picks the next free Untitled name", async () => {
    const { result } = await boot();
    await act(async () => {
      await result.current.newDocument();
    });
    expect(result.current.docName).toMatch(/^Untitled/);
  });

  it("openDocument switches the active id and clears the selection", async () => {
    // Seed the doc to switch TO *after* boot: boot's most-recent fallback would
    // otherwise adopt it, making the switch a no-op and the test vacuous.
    const { result, p } = await boot();
    await putDoc(record("other", "Other"));
    await act(async () => {
      await result.current.openDocument("other");
    });
    expect(result.current.docIdRef.current).toBe("other");
    expect(result.current.docName).toBe("Other");
    expect(result.current.activeId).toBe("other");
    expect(p.setSelection).toHaveBeenCalledWith([]);
  });

  it("openDocument is a no-op on the document already open", async () => {
    const { result, p } = await boot();
    const before = p.resetDoc.mock.calls.length;
    await act(async () => {
      await result.current.openDocument(result.current.docIdRef.current!);
    });
    expect(p.resetDoc.mock.calls.length).toBe(before);
  });

  it("openDocument rejects a document that no longer exists", async () => {
    const { result } = await boot();
    await expect(result.current.openDocument("ghost")).rejects.toThrow(/no longer exists/i);
  });

  it("openDocument raises CorruptDocError for a record that will not migrate", async () => {
    const { result } = await boot();
    await putDoc({ ...record("bad", "Broken"), doc: { features: 1 } as unknown as Document });
    await expect(result.current.openDocument("bad")).rejects.toMatchObject({ name: "CorruptDocError" });
  });

  it("duplicateDocument copies under a new id with a derived name", async () => {
    const { result } = await boot();
    await putDoc(record("src", "Bracket"));
    await act(async () => {
      await result.current.duplicateDocument("src");
    });
    expect(result.current.docIdRef.current).not.toBe("src");
    expect(result.current.docName).toMatch(/Bracket/);
    expect(await loadDoc("src")).toBeTruthy(); // the original survives
  });

  it("renameDocument renames the ACTIVE document in state and in storage", async () => {
    const { result } = await boot();
    const id = result.current.docIdRef.current!;
    await putDoc(record(id, "Untitled"));
    await act(async () => {
      await result.current.renameDocument(id, "Flange");
    });
    expect(result.current.docName).toBe("Flange");
    await waitFor(async () => expect((await loadDoc(id))?.name).toBe("Flange"));
  });

  it("renameDocument on an INACTIVE document leaves the open one's title alone", async () => {
    const { result } = await boot();
    await putDoc(record("other", "Other"));
    const openName = result.current.docName;
    await act(async () => {
      await result.current.renameDocument("other", "Renamed");
    });
    expect(result.current.docName).toBe(openName);
    expect((await loadDoc("other"))?.name).toBe("Renamed");
  });

  it("deleteDocument removes an inactive document without switching away", async () => {
    const { result } = await boot();
    await putDoc(record("other", "Other"));
    const id = result.current.docIdRef.current;
    await act(async () => {
      await result.current.deleteDocument("other");
    });
    expect(result.current.docIdRef.current).toBe(id);
    expect(await loadDoc("other")).toBeUndefined();
  });

  it("deleting the ACTIVE document falls back to the next most recent", async () => {
    const { result } = await boot();
    const active = result.current.docIdRef.current!;
    await putDoc(record(active, "Active", { updatedAt: 1 }));
    await putDoc(record("keep", "Keep", { updatedAt: 5 }));
    await act(async () => {
      await result.current.deleteDocument(active);
    });
    expect(result.current.docIdRef.current).toBe("keep");
    expect(result.current.docName).toBe("Keep");
  });

  it("deleting the LAST document seeds a fresh one rather than leaving none", async () => {
    const { result } = await boot();
    const active = result.current.docIdRef.current!;
    await putDoc(record(active, "Only"));
    await act(async () => {
      await result.current.deleteDocument(active);
    });
    expect(result.current.docIdRef.current).not.toBe(active);
    expect(result.current.docName).toBe("Untitled");
    expect(await listMeta()).toHaveLength(1);
  });
});

describe("export / import", () => {
  it("exportDocument hands a .openpoly.json blob to the caller's downloader", async () => {
    const { result, p } = await boot();
    await putDoc(record("x", "My Part"));
    await act(async () => {
      await result.current.exportDocument("x");
    });
    expect(p.downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = p.downloadBlob.mock.calls[0];
    expect(filename).toBe("My_Part.openpoly.json");
    expect(blob).toBeInstanceOf(Blob);
  });

  it("exportDocument does nothing for a document that is not there", async () => {
    const { result, p } = await boot();
    await act(async () => {
      await result.current.exportDocument("ghost");
    });
    expect(p.downloadBlob).not.toHaveBeenCalled();
  });

  it("importDocumentFile opens the file as a NEW document, never overwriting one", async () => {
    const { result } = await boot();
    await putDoc(record("existing", "Existing"));
    // Build the fixture with the real serializer, so the envelope can't drift
    // out from under the test the way a hand-written literal would.
    const file = fileWithText(serializeDocFile("Imported", createDocument()), "Imported.openpoly.json");
    let err: string | null = "unset";
    await act(async () => {
      err = await result.current.importDocumentFile(file);
    });
    expect(err).toBeNull();
    expect(result.current.docName).toMatch(/Imported/);
    expect(result.current.docIdRef.current).not.toBe("existing");
    expect(await loadDoc("existing")).toBeTruthy();
  });

  it("importDocumentFile returns the parse error rather than throwing at the dialog", async () => {
    const { result } = await boot();
    const file = fileWithText("{ not json", "bad.json");
    let err: string | null = null;
    await act(async () => {
      err = await result.current.importDocumentFile(file);
    });
    expect(err).toBeTruthy();
  });
});

describe("the multi-tab guard", () => {
  it("does not warn when this tab is the only holder", async () => {
    const { result } = await boot();
    await waitFor(() => expect(result.current.docInOtherTab).toBe(false));
  });

  it("warns when another tab announces the SAME document", async () => {
    const { result } = await boot();
    const id = result.current.activeId!;
    const other = new BroadcastChannel("openpoly-docs");
    act(() => {
      other.postMessage({ t: "open", docId: id, tab: "another-tab" });
    });
    await waitFor(() => expect(result.current.docInOtherTab).toBe(true));
    other.close();
  });

  it("ignores a tab holding a DIFFERENT document", async () => {
    const { result } = await boot();
    const other = new BroadcastChannel("openpoly-docs");
    act(() => {
      other.postMessage({ t: "open", docId: "some-other-doc", tab: "another-tab" });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.docInOtherTab).toBe(false);
    other.close();
  });

  it("clears the warning when the other holder leaves", async () => {
    const { result } = await boot();
    const id = result.current.activeId!;
    const other = new BroadcastChannel("openpoly-docs");
    act(() => {
      other.postMessage({ t: "open", docId: id, tab: "another-tab" });
    });
    await waitFor(() => expect(result.current.docInOtherTab).toBe(true));
    act(() => {
      other.postMessage({ t: "leave", docId: id, tab: "another-tab" });
    });
    await waitFor(() => expect(result.current.docInOtherTab).toBe(false));
    other.close();
  });
});
