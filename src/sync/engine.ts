// Two-way sync between this browser's IndexedDB documents and the user's
// Google Drive. IndexedDB stays the working copy — edits never wait on the
// network — and a sync pass reconciles it with Drive:
//
//   linked, only local changed   → push        (Drive keeps the old revision)
//   linked, only Drive changed   → pull        (the open doc reloads in place)
//   linked, both changed         → CONFLICT    (user picks: this device / Drive / both)
//   linked, Drive file gone      → REMOTE GONE (user picks: re-upload / keep local / delete)
//   unlinked, Drive file with the same doc id → relink if equal, else CONFLICT
//   unlinked, a Drive-only doc with the same NAME → NAME COLLISION
//                                  (user picks: rename / replace Drive's / use Drive's / keep local)
//                                  — except auto names ("Untitled N"): this
//                                  device's doc just takes the next free one
//   unlinked, untouched starter (auto name, empty) → BLANK: stays here until
//                                  edited or renamed, so every new device
//                                  doesn't push its own empty "Untitled"
//   unlinked, otherwise          → upload (at first connect too, unless a name
//                                  collision makes that connect ask first)
//   in Drive, not on this device → listed "in Drive"; Open downloads it
//
// Nothing destructive happens without a choice: every case where both sides
// hold different content becomes an issue for the user, never a silent
// last-writer-wins. "Changed" is decided by content hash, not timestamps, so a
// regen re-saving identical content (or Drive bumping its version for its own
// reasons) is never mistaken for an edit.
import type { StoredDoc } from "../storage/db";
import { listMeta, loadDoc, putDoc, renameDoc, type DocMeta } from "../storage/db";
import { parseDocFile, serializeDocFile } from "../storage/docFile";
import { dedupeName, isUntitled, nextUntitled } from "../storage/docNames";
import { genId, isStarterDocument, migrateDocument } from "../document/document";
import type { Document } from "../document/types";
import { docHash } from "./docHash";
import { DriveError, type DriveApi, type RemoteDoc } from "./driveApi";
import { deleteSyncLink, listSyncLinks, putSyncLink, type SyncLink } from "./syncStore";

export type DocSyncState =
  | "synced"
  | "pending" // has changes waiting for the next pass
  | "unsynced" // not in Drive yet (awaiting onboarding, or auto-upload is off)
  | "blank" // an untouched starter document: uploads once edited or renamed
  | "localOnly"
  | "conflict"
  | "nameCollision"
  | "remoteGone";

export type SyncIssue =
  | {
      kind: "conflict";
      docId: string;
      name: string;
      fileId: string;
      localUpdatedAt: number;
      remoteName: string;
      remoteModifiedTime: string;
    }
  | { kind: "nameCollision"; docId: string; name: string; fileId: string; remoteModifiedTime: string }
  | { kind: "remoteGone"; docId: string; name: string };

export type Resolution =
  /** conflict: overwrite Drive · nameCollision: replace the Drive doc with this
   *  one · remoteGone: upload again as a new Drive file */
  | { kind: "keepLocal" }
  /** conflict / nameCollision: replace this device's copy with Drive's */
  | { kind: "keepCloud" }
  /** conflict: this device's version becomes a separate "(conflict copy)" */
  | { kind: "keepBoth" }
  /** nameCollision: rename this device's doc, then upload it alongside */
  | { kind: "rename"; name: string }
  /** nameCollision / remoteGone: keep it on this device only */
  | { kind: "localOnly" }
  /** remoteGone: it was deleted in Drive — delete it here too */
  | { kind: "deleteLocal" };

/** What to do with each local document at first connect (onboarding). */
export type OnboardingChoice =
  | { kind: "upload" }
  | { kind: "localOnly" }
  | { kind: "rename"; name: string }
  | { kind: "keepLocal" } // name collision: replace the Drive doc
  | { kind: "keepCloud" }; // name collision: use the Drive doc

export interface OnboardingDoc {
  id: string;
  name: string;
  updatedAt: number;
  /** A Drive-only document with the same name, if any. */
  collision?: { fileId: string; remoteModifiedTime: string };
}

export type EngineStatus = "idle" | "syncing" | "offline" | "error" | "reauth";

export interface SyncSnapshot {
  status: EngineStatus;
  error: string | null;
  lastSyncedAt: number | null;
  docStates: Record<string, DocSyncState>;
  /** Documents in Drive that aren't on this device. */
  cloudOnly: RemoteDoc[];
  issues: SyncIssue[];
  /** Set at first connect while local documents await the upload choice. */
  onboarding: OnboardingDoc[] | null;
  /** Bumped whenever the engine changed local documents, so lists re-read. */
  localRevision: number;
}

/** The app side of sync: the working document lives in React state, so the
 *  engine asks before touching it. */
export interface SyncHost {
  getActiveId(): string | null;
  /** Persist the open document's unsaved edits to IndexedDB now. */
  flushActive(): Promise<void>;
  /** True if the open document hasn't been edited since the last flush — the
   *  engine only overwrites it when no keystroke could be lost. */
  canReplaceActive(): boolean;
  /** The engine wrote a new version of the open document: show it. */
  activeReplaced(record: StoredDoc): void;
  /** The engine renamed the open document (content untouched): show the new
   *  name without resetting anything else — undo history survives. */
  activeRenamed(name: string): void;
  /** Delete a document the way the app does (switching away if it's open). */
  deleteDocument(id: string): Promise<void>;
}

export interface EngineOptions {
  /** Upload new local documents automatically once onboarded (default on). */
  autoUpload?: () => boolean;
  isOnboarded: () => boolean;
  setOnboarded: () => void;
  /** Cross-tab mutual exclusion; defaults to the Web Locks API when present. */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

export class ReauthError extends Error {
  constructor() {
    super("Google Drive needs to be reconnected");
  }
}

interface Pulled {
  name: string;
  doc: Document;
  hash: string;
}

const defaultLock = <T>(fn: () => Promise<T>): Promise<T> =>
  typeof navigator !== "undefined" && navigator.locks
    ? (navigator.locks.request("openpoly-drive-sync", fn) as Promise<T>)
    : fn();

export class SyncEngine {
  private snap: SyncSnapshot = {
    // Nothing is known until the first pass, so don't claim "idle" (the button
    // would show a tick for a sync that hasn't happened yet).
    status: "syncing",
    error: null,
    lastSyncedAt: null,
    docStates: {},
    cloudOnly: [],
    issues: [],
    onboarding: null,
    localRevision: 0,
  };
  private listeners = new Set<(s: SyncSnapshot) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly withLock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    private readonly api: DriveApi,
    readonly account: string,
    private readonly host: SyncHost,
    private readonly opts: EngineOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.withLock = opts.withLock ?? defaultLock;
  }

  get snapshot(): SyncSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: SyncSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }

  private touchedLocal() {
    this.set({ localRevision: this.snap.localRevision + 1 });
  }

  /** Run `fn` after everything queued before it, inside the cross-tab lock,
   *  mapping Drive failures onto the status. Every public action goes through
   *  here, so a pass and a user's choice can never interleave. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() =>
      this.withLock(async () => {
        this.set({ status: "syncing", error: null });
        try {
          const out = await fn();
          this.set({ status: "idle", lastSyncedAt: this.now() });
          return out;
        } catch (e) {
          if (e instanceof ReauthError) this.set({ status: "reauth", error: e.message });
          else if (e instanceof DriveError && e.status === 0) this.set({ status: "offline", error: e.message });
          else this.set({ status: "error", error: String((e as Error)?.message ?? e) });
          throw e;
        }
      }),
    );
    this.queue = next.catch(() => {});
    return next;
  }

  /** One reconciliation pass. Rejects on failure (status says why). */
  sync(): Promise<void> {
    return this.run(() => this.pass());
  }

  // --- the pass -----------------------------------------------------------

  private async pass(): Promise<void> {
    await this.host.flushActive();
    const remotes = await this.api.listDocs();
    const metas = await listMeta();
    const allLinks = await listSyncLinks();
    const links = new Map(allLinks.filter((l) => l.account === this.account).map((l) => [l.docId, l]));
    const metaIds = new Set(metas.map((m) => m.id));
    const remoteById = new Map(remotes.map((r) => [r.fileId, r]));

    // A link whose document is gone = the document was removed from this
    // device (deleteDoc can't reach this database — see syncStore.ts). Its
    // Drive file, if any, becomes "in Drive" below.
    for (const l of links.values()) {
      if (!metaIds.has(l.docId)) {
        await deleteSyncLink(l.docId);
        links.delete(l.docId);
      }
    }
    const claimed = new Set<string>();
    for (const l of links.values()) if (l.fileId) claimed.add(l.fileId);

    const docStates: Record<string, DocSyncState> = {};
    const issues: SyncIssue[] = [];
    const unlinked: DocMeta[] = [];

    for (const meta of metas) {
      const link = links.get(meta.id);
      if (link?.localOnly) {
        docStates[meta.id] = "localOnly";
        continue;
      }
      if (link?.fileId) {
        const remote = remoteById.get(link.fileId);
        if (!remote) {
          docStates[meta.id] = "remoteGone";
          issues.push({ kind: "remoteGone", docId: meta.id, name: meta.name });
          continue;
        }
        const out = await this.syncLinked(meta, link, remote);
        docStates[meta.id] = out.state;
        if (out.issue) issues.push(out.issue);
        continue;
      }
      // Unlinked, but Drive holds a file uploaded under this very doc id — the
      // same document (links lost to a disconnect, or the other device). Equal
      // content just relinks; different content is a real conflict.
      const twin = remotes.find((r) => r.docId === meta.id && !claimed.has(r.fileId));
      if (twin) {
        claimed.add(twin.fileId);
        const out = await this.relink(meta, twin);
        docStates[meta.id] = out.state;
        if (out.issue) issues.push(out.issue);
        continue;
      }
      // An untouched starter document (an auto name, nothing in it) has
      // nothing worth keeping: leave it here until it's edited or renamed.
      if (isUntitled(meta.name) && (await this.isBlank(meta.id))) {
        docStates[meta.id] = "blank";
        continue;
      }
      unlinked.push(meta);
    }

    const cloudOnly = remotes.filter((r) => !claimed.has(r.fileId));
    const collisionFor = (name: string) => cloudOnly.find((r) => r.name === name);

    // Auto names identify nothing, so two "Untitled"s aren't the same document
    // and there's nothing to ask: this device's one takes the next name free
    // on both sides. The open document is renamed only between keystrokes.
    const taken = new Set([...metas.map((m) => m.name), ...remotes.map((r) => r.name)]);
    for (let i = 0; i < unlinked.length; i++) {
      const m = unlinked[i];
      if (!isUntitled(m.name) || !collisionFor(m.name)) continue;
      const active = this.host.getActiveId() === m.id;
      if (active && !this.host.canReplaceActive()) {
        docStates[m.id] = "pending";
        unlinked.splice(i--, 1);
        continue;
      }
      const name = nextUntitled([...taken]);
      taken.add(name);
      await renameDoc(m.id, name);
      if (active) this.host.activeRenamed(name);
      unlinked[i] = { ...m, name };
      this.touchedLocal();
    }

    // First connect asks only when there is something to decide: a document here
    // shares its name with a different one already in Drive. Then every document
    // is listed, so the choice is made with the whole picture. Otherwise this
    // device's documents simply upload, like any document created later.
    let onboarding: OnboardingDoc[] | null = null;
    let onboarded = this.opts.isOnboarded();
    if (!onboarded && !unlinked.some((m) => collisionFor(m.name))) {
      this.opts.setOnboarded();
      onboarded = true;
    }
    if (!onboarded) {
      onboarding = unlinked.map((m) => {
        const c = collisionFor(m.name);
        return {
          id: m.id,
          name: m.name,
          updatedAt: m.updatedAt,
          ...(c ? { collision: { fileId: c.fileId, remoteModifiedTime: c.modifiedTime } } : {}),
        };
      });
      for (const m of unlinked) docStates[m.id] = "unsynced";
    } else {
      const auto = this.opts.autoUpload?.() ?? true;
      for (const m of unlinked) {
        const c = collisionFor(m.name);
        if (c) {
          docStates[m.id] = "nameCollision";
          issues.push({
            kind: "nameCollision",
            docId: m.id,
            name: m.name,
            fileId: c.fileId,
            remoteModifiedTime: c.modifiedTime,
          });
        } else if (auto) {
          await this.uploadNew(m.id);
          docStates[m.id] = "synced";
        } else {
          docStates[m.id] = "unsynced";
        }
      }
    }

    // Uploads above don't change the cloud-only set (they're new files).
    this.set({ docStates, issues, cloudOnly, onboarding });
  }

  private async syncLinked(
    meta: DocMeta,
    link: SyncLink,
    remote: RemoteDoc,
  ): Promise<{ state: DocSyncState; issue?: SyncIssue }> {
    let localChanged = meta.updatedAt !== link.syncedUpdatedAt || meta.name !== link.syncedName;
    let remoteChanged = remote.version !== link.remoteVersion;
    if (!localChanged && !remoteChanged) return { state: "synced" };

    let local: { record: StoredDoc; hash: string } | null = null;
    if (localChanged) {
      local = await this.loadLocal(meta.id);
      if (!local) return { state: "synced" }; // vanished mid-pass; next pass drops the link
      if (local.hash === link.syncedHash) {
        // Re-saved, not edited (a regen re-persisting meshes, say).
        localChanged = false;
        link = { ...link, syncedUpdatedAt: local.record.updatedAt, syncedName: local.record.name };
        await putSyncLink(link);
      }
    }
    let pulled: Pulled | null = null;
    if (remoteChanged) {
      pulled = await this.fetchRemote(remote);
      if (pulled.hash === link.syncedHash) {
        // Drive bumps `version` for things that aren't content changes.
        remoteChanged = false;
        link = { ...link, remoteVersion: remote.version };
        await putSyncLink(link);
      }
    }

    if (!localChanged && !remoteChanged) return { state: "synced" };
    if (localChanged && !remoteChanged) {
      const pushed = await this.push(link.fileId!, local!.record, local!.hash, remote.version);
      return { state: pushed ? "synced" : "pending" };
    }
    if (!localChanged && remoteChanged) {
      const applied = await this.writeLocal(meta.id, remote, pulled!);
      return { state: applied ? "synced" : "pending" };
    }
    // Both sides moved. Converged by coincidence (the same edit made twice, or
    // a resolution another tab already applied)? Then just record it.
    if (local!.hash === pulled!.hash) {
      await putSyncLink({
        ...link,
        remoteVersion: remote.version,
        syncedHash: local!.hash,
        syncedUpdatedAt: local!.record.updatedAt,
        syncedName: local!.record.name,
      });
      return { state: "synced" };
    }
    return {
      state: "conflict",
      issue: {
        kind: "conflict",
        docId: meta.id,
        name: meta.name,
        fileId: remote.fileId,
        localUpdatedAt: meta.updatedAt,
        remoteName: remote.name,
        remoteModifiedTime: remote.modifiedTime,
      },
    };
  }

  private async relink(meta: DocMeta, remote: RemoteDoc): Promise<{ state: DocSyncState; issue?: SyncIssue }> {
    const local = await this.loadLocal(meta.id);
    if (!local) return { state: "synced" };
    const pulled = await this.fetchRemote(remote);
    if (local.hash === pulled.hash) {
      await this.linkTo(meta.id, remote, local.hash, local.record);
      return { state: "synced" };
    }
    return {
      state: "conflict",
      issue: {
        kind: "conflict",
        docId: meta.id,
        name: meta.name,
        fileId: remote.fileId,
        localUpdatedAt: meta.updatedAt,
        remoteName: remote.name,
        remoteModifiedTime: remote.modifiedTime,
      },
    };
  }

  // --- primitives ---------------------------------------------------------

  private async isBlank(id: string): Promise<boolean> {
    const record = await loadDoc(id);
    if (!record) return false;
    return isStarterDocument(record.doc);
  }

  private async loadLocal(id: string): Promise<{ record: StoredDoc; hash: string } | null> {
    const record = await loadDoc(id);
    if (!record) return null;
    return { record, hash: await docHash(record.name, record.doc) };
  }

  /** Download and parse a Drive document. The name comes from the Drive FILE
   *  name, not the envelope, so a rename made in Drive's own UI carries over. */
  private async fetchRemote(remote: RemoteDoc): Promise<Pulled> {
    const parsed = parseDocFile(await this.api.download(remote.fileId));
    const doc = migrateDocument(parsed.doc);
    return { name: remote.name, doc, hash: await docHash(remote.name, doc) };
  }

  private async linkTo(docId: string, remote: RemoteDoc, hash: string, record: StoredDoc) {
    await putSyncLink({
      docId,
      account: this.account,
      fileId: remote.fileId,
      remoteVersion: remote.version,
      syncedHash: hash,
      syncedUpdatedAt: record.updatedAt,
      syncedName: record.name,
    });
  }

  /** Overwrite a Drive file with a local record. With `expectVersion`, first
   *  re-check the file hasn't moved since the listing — Drive has no
   *  conditional write, so this narrows the race with another device to the
   *  gap between two requests. Returns false (try next pass) if it moved. */
  private async push(fileId: string, record: StoredDoc, hash: string, expectVersion?: string): Promise<boolean> {
    if (expectVersion !== undefined) {
      const current = await this.api.getDoc(fileId);
      if (current && current.version !== expectVersion) return false;
    }
    const updated = await this.api.updateDoc(fileId, {
      name: record.name,
      docId: record.id,
      content: serializeDocFile(record.name, record.doc),
    });
    await this.linkTo(record.id, updated, hash, record);
    return true;
  }

  private async uploadNew(docId: string): Promise<void> {
    const local = await this.loadLocal(docId);
    if (!local) return;
    const created = await this.api.createDoc({
      name: local.record.name,
      docId,
      content: serializeDocFile(local.record.name, local.record.doc),
    });
    await this.linkTo(docId, created, local.hash, local.record);
  }

  /** Write Drive's version into local document `docId` and link them. The open
   *  document is only replaced if it has no unflushed edits — otherwise this
   *  returns false and the next pass sees a conflict or retries. Cached meshes
   *  are dropped (they'd paint the OLD geometry); the regen rebuilds them. */
  private async writeLocal(docId: string, remote: RemoteDoc, pulled: Pulled): Promise<boolean> {
    const active = this.host.getActiveId() === docId;
    if (active && !this.host.canReplaceActive()) return false;
    const existing = await loadDoc(docId);
    const now = this.now();
    const record: StoredDoc = {
      id: docId,
      name: pulled.name,
      doc: pulled.doc,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.sectionView ? { sectionView: existing.sectionView } : {}),
    };
    await putDoc(record);
    await this.linkTo(docId, remote, pulled.hash, record);
    if (active) this.host.activeReplaced(record);
    this.touchedLocal();
    return true;
  }

  private issueFor(docId: string): SyncIssue | undefined {
    return this.snap.issues.find((i) => i.docId === docId);
  }

  private async remoteFor(fileId: string): Promise<RemoteDoc> {
    const remote = await this.api.getDoc(fileId);
    if (!remote) throw new Error("That document is no longer in Google Drive.");
    return remote;
  }

  // --- user actions -------------------------------------------------------

  /** Apply the user's choice for an open issue, then re-sync. */
  resolve(docId: string, resolution: Resolution): Promise<void> {
    return this.run(async () => {
      const issue = this.issueFor(docId);
      if (!issue) return;
      if (this.host.getActiveId() === docId) await this.host.flushActive();
      const local = await this.loadLocal(docId);
      if (!local) return;

      if (issue.kind === "remoteGone") {
        if (resolution.kind === "keepLocal") await this.uploadNew(docId);
        else if (resolution.kind === "localOnly") await this.markLocalOnly(docId);
        else if (resolution.kind === "deleteLocal") {
          await deleteSyncLink(docId);
          await this.host.deleteDocument(docId);
          this.touchedLocal();
        }
      } else if (issue.kind === "conflict" || issue.kind === "nameCollision") {
        const remote = await this.remoteFor(issue.fileId);
        switch (resolution.kind) {
          case "keepLocal":
            await this.push(remote.fileId, local.record, local.hash);
            break;
          case "keepCloud":
            await this.forceWriteLocal(docId, remote);
            break;
          case "keepBoth": {
            // This device's version moves to a new document (uploaded next
            // pass); the original keeps following Drive.
            const metas = await listMeta();
            const copy: StoredDoc = {
              ...local.record,
              id: genId(),
              name: dedupeName(
                `${local.record.name} (conflict copy)`,
                metas.map((m) => m.name),
              ),
              createdAt: this.now(),
              updatedAt: this.now(),
            };
            await putDoc(copy);
            await this.forceWriteLocal(docId, remote);
            break;
          }
          case "rename":
            await renameDoc(docId, resolution.name);
            if (this.host.getActiveId() === docId) this.host.activeRenamed(resolution.name);
            await this.uploadNew(docId);
            this.touchedLocal();
            break;
          case "localOnly":
            await this.markLocalOnly(docId);
            break;
        }
      }
      await this.pass();
    });
  }

  /** Overwrite local with Drive at the user's explicit request — unlike the
   *  automatic pull this replaces the open document even with fresh edits
   *  (they asked for Drive's version), after flushing so nothing is half-saved. */
  private async forceWriteLocal(docId: string, remote: RemoteDoc) {
    const pulled = await this.fetchRemote(remote);
    if (this.host.getActiveId() === docId) await this.host.flushActive();
    const existing = await loadDoc(docId);
    const now = this.now();
    const record: StoredDoc = {
      id: docId,
      name: pulled.name,
      doc: pulled.doc,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.sectionView ? { sectionView: existing.sectionView } : {}),
    };
    await putDoc(record);
    await this.linkTo(docId, remote, pulled.hash, record);
    if (this.host.getActiveId() === docId) this.host.activeReplaced(record);
    this.touchedLocal();
  }

  private async markLocalOnly(docId: string) {
    await putSyncLink({ docId, account: this.account, localOnly: true });
  }

  /** First-connect choices, one per listed document; then the first full pass. */
  completeOnboarding(choices: Record<string, OnboardingChoice>): Promise<void> {
    return this.run(async () => {
      const pending = this.snap.onboarding ?? [];
      for (const doc of pending) {
        const choice = choices[doc.id] ?? { kind: "upload" };
        if (choice.kind === "localOnly") await this.markLocalOnly(doc.id);
        else if (choice.kind === "rename") {
          await renameDoc(doc.id, choice.name);
          if (this.host.getActiveId() === doc.id) this.host.activeRenamed(choice.name);
          await this.uploadNew(doc.id);
          this.touchedLocal();
        } else if ((choice.kind === "keepLocal" || choice.kind === "keepCloud") && doc.collision) {
          const remote = await this.remoteFor(doc.collision.fileId);
          if (choice.kind === "keepCloud") await this.forceWriteLocal(doc.id, remote);
          else {
            const local = await this.loadLocal(doc.id);
            if (local) await this.push(remote.fileId, local.record, local.hash);
          }
        } else await this.uploadNew(doc.id);
      }
      this.opts.setOnboarded();
      this.set({ onboarding: null });
      await this.pass();
    });
  }

  /** Put one local-only or unsynced document in Drive. */
  upload(docId: string): Promise<void> {
    return this.run(async () => {
      await deleteSyncLink(docId);
      if (this.host.getActiveId() === docId) await this.host.flushActive();
      await this.uploadNew(docId);
      await this.pass();
    });
  }

  /** Stop syncing a document without deleting either copy. */
  keepLocalOnly(docId: string): Promise<void> {
    return this.run(async () => {
      await this.markLocalOnly(docId);
      await this.pass();
    });
  }

  /** Bring a Drive-only document onto this device. Resolves its local id. */
  download(fileId: string): Promise<string> {
    return this.run(async () => {
      const id = await this.downloadOne(fileId);
      await this.pass();
      return id;
    });
  }

  /** Right after connecting, a device holding nothing but untouched starter
   *  documents has nothing worth showing: bring down the Drive document edited
   *  most recently, to open in their place. Resolves its local id and how many
   *  other Drive documents remain, or null when there's real local work (or
   *  nothing in Drive). */
  downloadLatestIfOnlyStarters(): Promise<{ id: string; name: string; others: number } | null> {
    return this.run(async () => {
      const states = Object.values(this.snap.docStates);
      if (states.some((st) => st !== "blank") || this.snap.cloudOnly.length === 0) return null;
      const latest = this.snap.cloudOnly.reduce((a, b) =>
        Date.parse(b.modifiedTime) > Date.parse(a.modifiedTime) ? b : a,
      );
      const id = await this.downloadOne(latest.fileId);
      await this.pass();
      return { id, name: latest.name, others: this.snap.cloudOnly.length };
    });
  }

  private async downloadOne(fileId: string): Promise<string> {
    const remote = await this.remoteFor(fileId);
    const pulled = await this.fetchRemote(remote);
    // Reuse the doc id it was uploaded under, so every device agrees on
    // identity — unless that id is somehow taken here already.
    const id = remote.docId && !(await loadDoc(remote.docId)) ? remote.docId : genId();
    const now = this.now();
    const record: StoredDoc = { id, name: pulled.name, doc: pulled.doc, createdAt: now, updatedAt: now };
    await putDoc(record);
    await this.linkTo(id, remote, pulled.hash, record);
    this.touchedLocal();
    return id;
  }

  /** Delete a document here AND move its Drive file to Drive's trash. */
  deleteEverywhere(docId: string): Promise<void> {
    return this.run(async () => {
      const link = (await listSyncLinks()).find((l) => l.docId === docId && l.account === this.account);
      if (link?.fileId) await this.api.trash(link.fileId);
      await deleteSyncLink(docId);
      await this.host.deleteDocument(docId);
      this.touchedLocal();
      await this.pass();
    });
  }

  /** Move a Drive-only document to Drive's trash. */
  trashRemote(fileId: string): Promise<void> {
    return this.run(async () => {
      await this.api.trash(fileId);
      await this.pass();
    });
  }
}
