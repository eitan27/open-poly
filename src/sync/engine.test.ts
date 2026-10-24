// The sync engine against the real IndexedDB layer (fake-indexeddb) and the
// mock Drive (server/drive/mockDrive.ts) used as `fetch` — the same mock the
// local dev server serves, so these flows are the ones `npm run dev:api`
// exercises in the browser. Two "devices" are two IndexedDB factories sharing
// one Drive; `on(device, fn)` swaps the globals the storage modules read.
import { beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { __resetDBForTests, listMeta, loadDoc, putDoc, renameDoc, deleteDoc, type StoredDoc } from "../storage/db";
import { addFeature, createDocument, seedDocument } from "../document/document";
import type { Document } from "../document/types";
import { handleMockDrive } from "../../server/drive/mockDrive";
import { memoryKV, type KVLike } from "../../server/drive/kv";
import { mockAccessToken } from "../../server/drive/oauth";
import { createDriveApi, DriveError, type DriveApi } from "./driveApi";
import { __resetSyncStoreForTests, listSyncLinks } from "./syncStore";
import { ReauthError, SyncEngine, type SyncHost } from "./engine";

const BASE = "http://drive.test/api/mock-drive";

let kv: KVLike & { data: Map<string, string> };
beforeEach(() => {
  kv = memoryKV();
});

function driveFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handleMockDrive(new Request(input, init), kv)) as typeof fetch;
}

function apiFor(email: string, over: Partial<Parameters<typeof createDriveApi>[0]> = {}): DriveApi {
  return createDriveApi({
    apiBase: BASE,
    getToken: async () => mockAccessToken(email, Math.floor(Date.now() / 1000) + 3600),
    fetch: driveFetch(),
    sleep: async () => {},
    ...over,
  });
}

interface Device {
  idb: IDBFactory;
  engine: SyncEngine;
  host: SyncHost & { replaced: StoredDoc[]; renamed: string[]; active: string | null; dirty: boolean };
  onboarded: boolean;
}

let current: Device | null = null;
function switchTo(d: Device) {
  if (current === d) return;
  globalThis.indexedDB = d.idb;
  __resetDBForTests();
  __resetSyncStoreForTests();
  current = d;
}
async function on<T>(d: Device, fn: () => Promise<T>): Promise<T> {
  switchTo(d);
  return fn();
}

function device(email = "a@example.com", api?: DriveApi, onboarded = false): Device {
  const d = { idb: new IDBFactory(), onboarded } as Device;
  const host = {
    replaced: [] as StoredDoc[],
    renamed: [] as string[],
    active: null as string | null,
    dirty: false,
    getActiveId: () => host.active,
    flushActive: async () => {},
    canReplaceActive: () => !host.dirty,
    activeReplaced: (r: StoredDoc) => host.replaced.push(r),
    activeRenamed: (name: string) => host.renamed.push(name),
    deleteDocument: (id: string) => deleteDoc(id),
  };
  d.host = host;
  d.engine = new SyncEngine(api ?? apiFor(email), email, host, {
    isOnboarded: () => d.onboarded,
    setOnboarded: () => (d.onboarded = true),
    withLock: (fn) => fn(),
  });
  return d;
}

let clock = 1_000;
const tick = () => (clock += 1000);
function rec(id: string, name: string, doc: Document = createDocument()): StoredDoc {
  const t = tick();
  return { id, name, doc, createdAt: t, updatedAt: t };
}
const withVar = (value: string): Document => ({
  ...createDocument(),
  variables: [{ id: "v1", name: "w", expression: value }],
});
/** An edit as autosave would persist it: new content, new updatedAt. */
async function edit(id: string, value: string) {
  const r = (await loadDoc(id))!;
  await putDoc({ ...r, doc: withVar(value), updatedAt: tick() });
}

/** Every doc file in the shared mock Drive, by name. */
function driveFiles() {
  return [...kv.data.entries()]
    .filter(([k]) => k.startsWith("mockdrive:"))
    .map(([, v]) => JSON.parse(v) as { id: string; name: string; trashed: boolean; version: string; content?: string })
    .filter((f) => f.name.endsWith(".openpoly.json"));
}
const driveVar = (name: string) => {
  const f = driveFiles().find((x) => x.name === `${name}.openpoly.json` && !x.trashed);
  return f ? (JSON.parse(f.content!).doc.variables[0]?.expression ?? null) : undefined;
};
const localVar = async (id: string) => (await loadDoc(id))?.doc.variables[0]?.expression ?? null;

describe("first connect (onboarding)", () => {
  it("with no name clash, uploads every local document without asking", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("d1", "Bracket", withVar("10")));
      await putDoc(rec("d2", "Scratch"));
      await a.engine.sync();
      expect(a.engine.snapshot.onboarding).toBeNull();
      expect(a.onboarded).toBe(true);
      expect(driveVar("Bracket")).toBe("10");
      expect(driveVar("Scratch")).toBe(null);
      expect(a.engine.snapshot.docStates).toEqual({ d1: "synced", d2: "synced" });
    });
  });

  it("with nothing local, onboarding is skipped", async () => {
    const a = device();
    await on(a, async () => {
      await a.engine.sync();
      expect(a.engine.snapshot.onboarding).toBeNull();
      expect(a.onboarded).toBe(true);
    });
  });

  it("with a name clash, lists every local document and honours upload and keep-local", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("a1", "Bracket", withVar("1")));
      await a.engine.sync();
    });
    const b = device();
    await on(b, async () => {
      await putDoc(rec("b1", "Bracket", withVar("2")));
      await putDoc(rec("b2", "Plate"));
      await putDoc(rec("b3", "Scratch"));
      await b.engine.sync();
      expect(b.engine.snapshot.onboarding?.map((d) => d.name).sort()).toEqual(["Bracket", "Plate", "Scratch"]);
      expect(driveFiles().map((f) => f.name)).toEqual(["Bracket.openpoly.json"]); // nothing before the choice
      await b.engine.completeOnboarding({
        b1: { kind: "rename", name: "Bracket (laptop)" },
        b2: { kind: "upload" },
        b3: { kind: "localOnly" },
      });
      expect(b.onboarded).toBe(true);
      expect(driveVar("Plate")).toBe(null);
      expect(driveVar("Scratch")).toBeUndefined();
      expect(b.engine.snapshot.docStates).toEqual({ b1: "synced", b2: "synced", b3: "localOnly" });
    });
  });

  it("flags a same-named Drive document and honours each choice", async () => {
    // Device A already put "Bracket" (v=1) in Drive.
    const a = device();
    await on(a, async () => {
      await putDoc(rec("a1", "Bracket", withVar("1")));
      await a.engine.sync();
      await a.engine.completeOnboarding({});
    });
    // Device B made its own, different "Bracket" before ever connecting.
    for (const [choice, expectLocal, expectDrive, expectNames] of [
      [{ kind: "rename", name: "Bracket (laptop)" }, "2", "1", ["Bracket", "Bracket (laptop)"]],
      [{ kind: "keepCloud" }, "1", "1", ["Bracket"]],
      [{ kind: "keepLocal" }, "2", "2", ["Bracket"]],
    ] as const) {
      // Reset Drive's Bracket to v=1 for each choice.
      const b = device();
      await on(b, async () => {
        await putDoc(rec("b1", "Bracket", withVar("2")));
        await b.engine.sync();
        const ob = b.engine.snapshot.onboarding!;
        expect(ob[0].collision).toBeTruthy();
        await b.engine.completeOnboarding({ b1: choice });
        expect(await localVar("b1")).toBe(expectLocal);
        expect(b.engine.snapshot.docStates.b1).toBe("synced");
      });
      const names = driveFiles()
        .filter((f) => !f.trashed)
        .map((f) => f.name.replace(".openpoly.json", ""))
        .sort();
      expect(names).toEqual([...expectNames]);
      if (choice.kind !== "rename") expect(driveVar("Bracket")).toBe(expectDrive);
      // Clean up B's extra upload and restore A's content for the next round.
      for (const [k, v] of [...kv.data]) {
        const f = JSON.parse(v);
        if (k.startsWith("mockdrive:") && f.name === "Bracket (laptop).openpoly.json") kv.data.delete(k);
        if (k.startsWith("mockdrive:") && f.name === "Bracket.openpoly.json" && choice.kind === "keepLocal") {
          await on(a, async () => {
            await a.engine.sync(); // A pulls v=2…
            await edit("a1", "1"); // …and puts v=1 back
            await a.engine.sync();
          });
        }
      }
    }
  });
});

describe("steady state", () => {
  async function pair() {
    const a = device();
    const b = device();
    await on(a, async () => {
      await putDoc(rec("d1", "Bracket", withVar("10")));
      await a.engine.sync();
      await a.engine.completeOnboarding({});
    });
    await on(b, async () => {
      await b.engine.sync(); // empty → onboarded
      expect(b.engine.snapshot.cloudOnly.map((r) => r.name)).toEqual(["Bracket"]);
      const id = await b.engine.download(b.engine.snapshot.cloudOnly[0].fileId);
      expect(id).toBe("d1"); // same identity on every device
    });
    return { a, b };
  }

  it("pushes a local edit, and the other device pulls it", async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      await edit("d1", "20");
      await a.engine.sync();
    });
    expect(driveVar("Bracket")).toBe("20");
    await on(b, async () => {
      await b.engine.sync();
      expect(await localVar("d1")).toBe("20");
      expect(b.engine.snapshot.docStates.d1).toBe("synced");
    });
  });

  it("re-saving identical content uploads nothing", async () => {
    const { a } = await pair();
    const before = driveFiles()[0].version;
    await on(a, async () => {
      const r = (await loadDoc("d1"))!;
      await putDoc({ ...r, updatedAt: tick() }); // a regen re-persisting meshes
      await a.engine.sync();
    });
    expect(driveFiles()[0].version).toBe(before);
  });

  it("a rename on either side syncs as a rename", async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      await renameDoc("d1", "Bracket v2"); // renames don't bump updatedAt
      await a.engine.sync();
    });
    expect(driveFiles()[0].name).toBe("Bracket v2.openpoly.json");
    await on(b, async () => {
      await b.engine.sync();
      expect((await listMeta())[0].name).toBe("Bracket v2");
    });
  });

  it("a rename made in Drive's own UI is pulled", async () => {
    const { a } = await pair();
    const f = driveFiles()[0];
    await handleMockDrive(
      new Request(`${BASE}/drive/v3/files/${f.id}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${mockAccessToken("a@example.com", 9e9)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Renamed in Drive.openpoly.json" }),
      }),
      kv,
    );
    await on(a, async () => {
      await a.engine.sync();
      expect((await loadDoc("d1"))!.name).toBe("Renamed in Drive");
    });
  });

  it("edits on both sides become a conflict, never a silent overwrite", async () => {
    for (const [resolution, expectLocal, expectDrive, copies] of [
      [{ kind: "keepLocal" }, "B", "B", 0],
      [{ kind: "keepCloud" }, "A", "A", 0],
      [{ kind: "keepBoth" }, "A", "A", 1],
    ] as const) {
      kv = memoryKV();
      const { a, b } = await pair();
      await on(a, async () => {
        await edit("d1", "A");
        await a.engine.sync();
      });
      await on(b, async () => {
        await edit("d1", "B");
        await b.engine.sync();
        expect(b.engine.snapshot.docStates.d1).toBe("conflict");
        expect(b.engine.snapshot.issues).toMatchObject([{ kind: "conflict", docId: "d1" }]);
        expect(await localVar("d1")).toBe("B"); // untouched until the user chooses
        await b.engine.resolve("d1", resolution);
        expect(await localVar("d1")).toBe(expectLocal);
        const metas = await listMeta();
        const copy = metas.find((m) => m.name === "Bracket (conflict copy)");
        expect(copy ? 1 : 0).toBe(copies);
        if (copy) expect(await localVar(copy.id)).toBe("B");
        expect(b.engine.snapshot.issues).toEqual([]);
      });
      expect(driveVar("Bracket")).toBe(expectDrive);
      if (copies) expect(driveVar("Bracket (conflict copy)")).toBe("B");
    }
  });

  it("the same edit made on both sides converges without a conflict", async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      await edit("d1", "same");
      await a.engine.sync();
    });
    await on(b, async () => {
      await edit("d1", "same");
      await b.engine.sync();
      expect(b.engine.snapshot.docStates.d1).toBe("synced");
    });
  });

  it("never overwrites the open document while it has unflushed edits", async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      await edit("d1", "remote");
      await a.engine.sync();
    });
    await on(b, async () => {
      b.host.active = "d1";
      b.host.dirty = true;
      await b.engine.sync();
      expect(await localVar("d1")).toBe("10");
      expect(b.engine.snapshot.docStates.d1).toBe("pending");
      b.host.dirty = false;
      await b.engine.sync();
      expect(await localVar("d1")).toBe("remote");
      expect(b.host.replaced.map((r) => r.id)).toEqual(["d1"]);
    });
  });

  it("removing from one device leaves it in Drive, listed as Drive-only", async () => {
    const { b } = await pair();
    await on(b, async () => {
      await deleteDoc("d1"); // the app's delete; the link lives in another DB
      await b.engine.sync();
      expect(b.engine.snapshot.cloudOnly.map((r) => r.name)).toEqual(["Bracket"]);
      expect(await listSyncLinks()).toEqual([]);
    });
    expect(driveVar("Bracket")).toBe("10");
  });

  it("delete everywhere moves the Drive file to the trash", async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      await a.engine.deleteEverywhere("d1");
      expect(await loadDoc("d1")).toBeUndefined();
    });
    expect(driveFiles()[0].trashed).toBe(true);
    await on(b, async () => {
      await b.engine.sync();
      expect(b.engine.snapshot.issues).toMatchObject([{ kind: "remoteGone", docId: "d1" }]);
      expect(await localVar("d1")).toBe("10"); // B's copy survives until B decides
      await b.engine.resolve("d1", { kind: "deleteLocal" });
      expect(await loadDoc("d1")).toBeUndefined();
    });
  });

  it("a document deleted in Drive can be uploaded again or kept local", async () => {
    const { a } = await pair();
    const trash = async () => {
      const f = driveFiles().find((x) => !x.trashed)!;
      await handleMockDrive(
        new Request(`${BASE}/drive/v3/files/${f.id}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${mockAccessToken("a@example.com", 9e9)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ trashed: true }),
        }),
        kv,
      );
    };
    await trash();
    await on(a, async () => {
      await a.engine.sync();
      expect(a.engine.snapshot.docStates.d1).toBe("remoteGone");
      await a.engine.resolve("d1", { kind: "keepLocal" });
      expect(a.engine.snapshot.docStates.d1).toBe("synced");
    });
    expect(driveVar("Bracket")).toBe("10");
    await trash();
    await on(a, async () => {
      await a.engine.sync();
      await a.engine.resolve("d1", { kind: "localOnly" });
      expect(a.engine.snapshot.docStates.d1).toBe("localOnly");
      await edit("d1", "private");
      await a.engine.sync();
    });
    expect(driveVar("Bracket")).toBeUndefined();
  });

  it("relinks by document id after links are lost, without re-uploading", async () => {
    const { a } = await pair();
    const before = driveFiles().length;
    // A disconnect + reconnect as another session: same account, no links.
    const fresh = device("a@example.com", undefined, true);
    fresh.idb = a.idb;
    current = null;
    await on(fresh, async () => {
      for (const l of await listSyncLinks()) {
        const { deleteSyncLink } = await import("./syncStore");
        await deleteSyncLink(l.docId);
      }
      await fresh.engine.sync();
      expect(fresh.engine.snapshot.docStates.d1).toBe("synced");
    });
    expect(driveFiles().length).toBe(before);
  });

  it("new documents upload automatically once onboarded, unless their name collides", async () => {
    const { a, b } = await pair();
    await on(a, async () => {
      await putDoc(rec("d2", "Plate"));
      await a.engine.sync();
      expect(a.engine.snapshot.docStates.d2).toBe("synced");
    });
    await on(b, async () => {
      await putDoc(rec("b2", "Plate")); // B's own Plate; A's is Drive-only here
      await b.engine.sync();
      expect(b.engine.snapshot.docStates.b2).toBe("nameCollision");
      await b.engine.resolve("b2", { kind: "rename", name: "Plate 2" });
      expect(b.engine.snapshot.docStates.b2).toBe("synced");
    });
    expect(
      driveFiles()
        .map((f) => f.name)
        .sort(),
    ).toEqual(["Bracket.openpoly.json", "Plate 2.openpoly.json", "Plate.openpoly.json"]);
  });
});

describe("accounts, failures, big files", () => {
  it("links made under another account are ignored", async () => {
    const a = device("a@example.com");
    await on(a, async () => {
      await putDoc(rec("d1", "Bracket"));
      await a.engine.sync();
      await a.engine.completeOnboarding({});
    });
    const other = device("z@example.com");
    other.idb = a.idb;
    current = null;
    await on(other, async () => {
      await other.engine.sync();
      // z's Drive is empty and a's link to d1 means nothing for z, so d1 uploads
      // again as z's own file — a reused link would have found no such file.
      expect(other.engine.snapshot.docStates).toEqual({ d1: "synced" });
      expect(driveFiles().filter((f) => f.name === "Bracket.openpoly.json")).toHaveLength(2);
    });
  });

  it("goes offline, recovers, and retries rate limits", async () => {
    let offline = true;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline) throw new TypeError("Failed to fetch");
      return handleMockDrive(new Request(input, init), kv);
    }) as typeof fetch;
    const a = device("a@example.com", apiFor("a@example.com", { fetch: flaky }));
    await on(a, async () => {
      await expect(a.engine.sync()).rejects.toBeInstanceOf(DriveError);
      expect(a.engine.snapshot.status).toBe("offline");
      offline = false;
      kv.data.set("mockdrive-fail:a@example.com", JSON.stringify({ status: 429, count: 2 }));
      await a.engine.sync();
      expect(a.engine.snapshot.status).toBe("idle");
    });
  });

  it("a dead grant surfaces as reauth", async () => {
    const api = apiFor("a@example.com", {
      getToken: async () => {
        throw new ReauthError();
      },
    });
    const a = device("a@example.com", api);
    await on(a, async () => {
      await expect(a.engine.sync()).rejects.toBeInstanceOf(ReauthError);
      expect(a.engine.snapshot.status).toBe("reauth");
    });
  });

  it("documents over Drive's multipart limit go through a resumable upload", async () => {
    const big = { ...createDocument(), variables: [{ id: "v", name: "x", expression: "1".repeat(5_000_000) }] };
    const a = device();
    const b = device();
    await on(a, async () => {
      await putDoc(rec("big", "Imported STEP", big));
      await a.engine.sync();
      await a.engine.completeOnboarding({});
    });
    await on(b, async () => {
      await b.engine.sync();
      await b.engine.download(b.engine.snapshot.cloudOnly[0].fileId);
      expect((await localVar("big"))?.length).toBe(5_000_000);
    });
  });
});

describe("auto-named documents", () => {
  it("an untouched starter document stays on this device until it's edited", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("d1", "Untitled"));
      await a.engine.sync();
      expect(a.engine.snapshot.onboarding).toBeNull();
      expect(a.engine.snapshot.docStates).toEqual({ d1: "blank" });
      expect(driveFiles()).toHaveLength(0);
      await edit("d1", "5");
      await a.engine.sync();
      expect(a.engine.snapshot.docStates).toEqual({ d1: "synced" });
      expect(driveVar("Untitled")).toBe("5");
    });
  });

  it("the first-load seed box counts as untouched; any change to it doesn't", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("d1", "Untitled", seedDocument()));
      await a.engine.sync();
      expect(a.engine.snapshot.docStates).toEqual({ d1: "blank" });
      const r = (await loadDoc("d1"))!;
      await putDoc({ ...r, doc: addFeature(r.doc, "sphere").doc, updatedAt: tick() });
      await a.engine.sync();
      expect(a.engine.snapshot.docStates).toEqual({ d1: "synced" });
    });
  });

  it("a starter document renamed by the user uploads even while empty", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("d1", "Untitled"));
      await a.engine.sync();
      await renameDoc("d1", "Bracket");
      await a.engine.sync();
      expect(a.engine.snapshot.docStates).toEqual({ d1: "synced" });
      expect(driveVar("Bracket")).toBe(null);
    });
  });

  it("a second device's starter document neither asks nor clashes, and takes the next free name once edited", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("a1", "Untitled", withVar("1")));
      await a.engine.sync();
    });
    const b = device();
    await on(b, async () => {
      await putDoc(rec("b1", "Untitled"));
      b.host.active = "b1";
      await b.engine.sync();
      expect(b.engine.snapshot.onboarding).toBeNull();
      expect(b.engine.snapshot.issues).toEqual([]);
      expect(b.engine.snapshot.docStates).toEqual({ b1: "blank" });

      await edit("b1", "2");
      await b.engine.sync();
      expect(b.engine.snapshot.issues).toEqual([]);
      expect(b.engine.snapshot.docStates).toEqual({ b1: "synced" });
      expect((await loadDoc("b1"))!.name).toBe("Untitled 2");
      expect(b.host.renamed).toEqual(["Untitled 2"]);
      expect(b.host.replaced).toEqual([]); // renamed in place: undo history kept
      expect(driveVar("Untitled")).toBe("1");
      expect(driveVar("Untitled 2")).toBe("2");
    });
  });

  it("the next free name skips names taken on either side", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("a1", "Untitled", withVar("1")));
      await putDoc(rec("a2", "Untitled 2", withVar("1")));
      await a.engine.sync();
    });
    const b = device();
    await on(b, async () => {
      await putDoc(rec("b1", "Untitled", withVar("2")));
      await putDoc(rec("b2", "Untitled 3", withVar("3")));
      await b.engine.sync();
      expect(b.engine.snapshot.onboarding).toBeNull();
      expect((await loadDoc("b1"))!.name).toBe("Untitled 4");
      expect(driveVar("Untitled 4")).toBe("2");
      expect(driveVar("Untitled 3")).toBe("3");
    });
  });

  it("the open document isn't renamed mid-edit; the next pass does it", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("a1", "Untitled", withVar("1")));
      await a.engine.sync();
    });
    const b = device();
    await on(b, async () => {
      await putDoc(rec("b1", "Untitled", withVar("2")));
      b.host.active = "b1";
      b.host.dirty = true;
      await b.engine.sync();
      expect(b.engine.snapshot.docStates).toEqual({ b1: "pending" });
      expect((await loadDoc("b1"))!.name).toBe("Untitled");
      b.host.dirty = false;
      await b.engine.sync();
      expect(b.engine.snapshot.docStates).toEqual({ b1: "synced" });
      expect(b.host.renamed).toEqual(["Untitled 2"]);
    });
  });

  it("a real clash still asks at first connect; an auto-named clash in the same list is already renamed", async () => {
    const a = device();
    await on(a, async () => {
      await putDoc(rec("a1", "Bracket", withVar("1")));
      await putDoc(rec("a2", "Untitled", withVar("1")));
      await a.engine.sync();
    });
    const b = device();
    await on(b, async () => {
      await putDoc(rec("b1", "Bracket", withVar("2")));
      await putDoc(rec("b2", "Untitled", withVar("2")));
      await b.engine.sync();
      const list = b.engine.snapshot.onboarding!;
      expect(list.find((d) => d.id === "b1")!.collision).toBeDefined();
      expect(list.find((d) => d.id === "b2")).toMatchObject({ name: "Untitled 2" });
      expect(list.find((d) => d.id === "b2")!.collision).toBeUndefined();
    });
  });
});
