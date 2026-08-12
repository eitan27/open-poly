// DB v2 (Phase 8.7): meta/payload split, dual-write atomicity, v1→v2
// migration. Runs against fake-indexeddb — each test gets a FRESH factory so
// state can't leak between tests (the module caches its connection; the
// __resetDBForTests hook drops it).
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { __resetDBForTests, deleteDoc, duplicateDoc, listMeta, loadDoc, putDoc, renameDoc, type StoredDoc } from "./db";
import { createDocument } from "../document/document";

function record(id: string, name: string, overrides: Partial<StoredDoc> = {}): StoredDoc {
  return {
    id,
    name,
    doc: createDocument(),
    updatedAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetDBForTests();
});

describe("putDoc / loadDoc / listMeta", () => {
  it("round-trips a record and derives its meta row", async () => {
    const doc = createDocument();
    await putDoc({
      id: "a",
      name: "Bracket",
      doc,
      updatedAt: 111,
      createdAt: 100,
      meshes: [
        { id: "b1", mesh: { name: "b1", faces: { vertices: [], triangles: [] }, edges: { lines: [] } } },
        { id: "b2", mesh: { name: "b2", faces: { vertices: [], triangles: [] }, edges: { lines: [] } } },
      ],
    });
    const rec = await loadDoc("a");
    expect(rec?.name).toBe("Bracket");
    expect(rec?.doc.features).toEqual(doc.features);

    const metas = await listMeta();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      id: "a",
      name: "Bracket",
      updatedAt: 111,
      createdAt: 100,
      featureCount: doc.features.length,
      partCount: 2,
    });
  });

  it("lists most-recently-updated first and never loads full payloads", async () => {
    await putDoc(record("old", "Old", { updatedAt: 1 }));
    await putDoc(record("new", "New", { updatedAt: 2 }));
    const metas = await listMeta();
    expect(metas.map((m) => m.id)).toEqual(["new", "old"]);
    // A meta row is a projection — no document tree, no meshes.
    expect(metas[0]).not.toHaveProperty("doc");
    expect(metas[0]).not.toHaveProperty("meshes");
  });

  it("preserves an existing thumbnail and createdAt across autosaves", async () => {
    await putDoc(record("a", "Doc", { createdAt: 100, updatedAt: 100 }));
    // Simulate the thumbnail path writing straight to meta (M3 API will wrap
    // this; here we prove putDoc doesn't clobber what it doesn't know about).
    const thumb = new Blob(["png-bytes"], { type: "image/png" });
    const withThumb = (await listMeta())[0];
    await new Promise<void>((resolve, reject) => {
      const req = globalThis.indexedDB.open("open-poly", 2);
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction("meta", "readwrite");
        t.objectStore("meta").put({ ...withThumb, thumb });
        t.oncomplete = () => {
          db.close();
          resolve();
        };
        t.onerror = () => reject(t.error);
      };
      req.onerror = () => reject(req.error);
    });

    // A later autosave (fresh updatedAt, no thumb knowledge) keeps both.
    await putDoc(record("a", "Doc", { createdAt: 999, updatedAt: 200 }));
    const meta = (await listMeta())[0];
    expect(meta.updatedAt).toBe(200);
    expect(meta.createdAt).toBe(100); // original creation time wins
    expect(meta.thumb).toBeDefined();
  });
});

describe("renameDoc", () => {
  it("renames both stores without bumping updatedAt", async () => {
    await putDoc(record("a", "Untitled", { updatedAt: 42 }));
    await renameDoc("a", "Chute v2");
    expect((await loadDoc("a"))?.name).toBe("Chute v2");
    const meta = (await listMeta())[0];
    expect(meta.name).toBe("Chute v2");
    expect(meta.updatedAt).toBe(42); // content unchanged → list order stable
  });

  it("is a no-op for a missing id", async () => {
    await expect(renameDoc("ghost", "x")).resolves.toBeUndefined();
    expect(await listMeta()).toHaveLength(0);
  });
});

describe("duplicateDoc", () => {
  it("copies content + meshes under a fresh identity", async () => {
    await putDoc(
      record("a", "Bracket", {
        updatedAt: 5,
        createdAt: 5,
        meshes: [{ id: "b1", mesh: { name: "b1", faces: { vertices: [], triangles: [] }, edges: { lines: [] } } }],
      }),
    );
    const copy = await duplicateDoc("a", "a2", "Copy of Bracket");
    expect(copy?.id).toBe("a2");
    const rec = await loadDoc("a2");
    expect(rec?.name).toBe("Copy of Bracket");
    expect(rec?.meshes).toHaveLength(1); // copy paints instantly too
    expect(rec?.createdAt).toBeGreaterThan(5); // fresh dates
    const metas = await listMeta();
    expect(metas.map((m) => m.id).sort()).toEqual(["a", "a2"]);
    expect(metas.find((m) => m.id === "a2")?.thumb).toBeUndefined(); // earns its own
  });

  it("returns undefined when the source vanished", async () => {
    expect(await duplicateDoc("ghost", "g2", "x")).toBeUndefined();
    expect(await listMeta()).toHaveLength(0);
  });
});

describe("deleteDoc", () => {
  it("removes both stores atomically", async () => {
    await putDoc(record("a", "Doc"));
    await deleteDoc("a");
    expect(await loadDoc("a")).toBeUndefined();
    expect(await listMeta()).toHaveLength(0);
  });
});

describe("v1 → v2 migration", () => {
  it("backfills meta rows for records written by DB v1", async () => {
    // Hand-build a v1 database: single `documents` store, no meta, and a
    // record WITHOUT createdAt (v1 shape).
    await new Promise<void>((resolve, reject) => {
      const req = globalThis.indexedDB.open("open-poly", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("documents", { keyPath: "id" });
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction("documents", "readwrite");
        t.objectStore("documents").put({
          id: "legacy",
          name: "Untitled",
          doc: createDocument(),
          updatedAt: 777,
          meshes: [{ id: "b1", mesh: { name: "b1", faces: { vertices: [], triangles: [] }, edges: { lines: [] } } }],
        });
        t.oncomplete = () => {
          db.close();
          resolve();
        };
        t.onerror = () => reject(t.error);
      };
      req.onerror = () => reject(req.error);
    });

    // First module-level open upgrades to v2 and backfills.
    const metas = await listMeta();
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({
      id: "legacy",
      name: "Untitled",
      updatedAt: 777,
      createdAt: 777, // falls back to updatedAt for v1 records
      partCount: 1,
    });
    // The full record is untouched.
    expect((await loadDoc("legacy"))?.updatedAt).toBe(777);
  });
});

describe("setThumb", () => {
  it("writes the thumbnail onto meta only, surviving later autosaves", async () => {
    const { setThumb } = await import("./db");
    await putDoc(record("a", "Doc", { updatedAt: 1 }));
    await setThumb("a", new Blob(["img"], { type: "image/jpeg" }));
    expect((await listMeta())[0].thumb).toBeDefined();
    await putDoc(record("a", "Doc", { updatedAt: 2 })); // autosave after capture
    const meta = (await listMeta())[0];
    expect(meta.thumb).toBeDefined();
    expect(meta.updatedAt).toBe(2);
    // The full record never carries a thumb.
    expect(await loadDoc("a")).not.toHaveProperty("thumb");
  });
});
