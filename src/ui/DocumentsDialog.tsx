// The Documents manager: a centered modal listing every stored
// document from the cheap `meta` store — full records (feature trees + cached
// meshes) are NEVER loaded just to browse. All mutations are owned by App
// (which owns the switch flow); the dialog re-lists after each action settles.
import { useCallback, useEffect, useRef, useState } from "react";
import { listMeta, onThumbChanged, type DocMeta } from "../storage/db";
import { timeAgo } from "../storage/docNames";
import { CorruptDocError } from "../storage/docErrors";
import type { DocSyncState } from "../sync/engine";
import type { RemoteDoc } from "../sync/driveApi";
import { Modal } from "./Modal";

/** Google Drive's view of the list, present only while Drive is connected. */
export interface DocsDriveProps {
  states: Record<string, DocSyncState>;
  /** Documents in Drive that aren't on this device. */
  cloudOnly: RemoteDoc[];
  /** Open issues + pending first-connect choice, for the "needs attention" line. */
  attention: number;
  /** Bumped when sync changed local documents — the list re-reads. */
  revision: number;
  /** Download a Drive-only document and open it. */
  onOpenCloud: (fileId: string) => Promise<void>;
  onTrashCloud: (fileId: string) => Promise<void>;
  /** Delete here AND move the Drive file to Drive's trash. */
  onDeleteEverywhere: (id: string) => Promise<void>;
  onUpload: (id: string) => Promise<void>;
  /** Open the Drive dialog, where issues are resolved. */
  onReview: () => void;
}

const SYNC_LABEL: Record<DocSyncState, string> = {
  synced: "☁ In Drive",
  pending: "☁ Syncing…",
  unsynced: "Not in Drive",
  blank: "Empty · syncs once edited",
  localOnly: "This device only",
  conflict: "⚠ Changed in two places",
  nameCollision: "⚠ Same name in Drive",
  remoteGone: "⚠ Deleted from Drive",
};
const IN_DRIVE: ReadonlySet<DocSyncState> = new Set(["synced", "pending", "conflict"]);

interface Props {
  /** The document currently open in this tab (highlighted; can't be Opened). */
  activeId: string | null;
  onClose: () => void;
  onOpen: (id: string) => Promise<void>;
  onDuplicate: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  /** Save as `.openpoly.json` (does not switch documents). */
  onExport: (id: string) => Promise<void>;
  /** Import a `.openpoly.json` file as a new document (opens it). Resolves an
   *  error message to display, or null on success. */
  onImport: (file: File) => Promise<string | null>;
  drive?: DocsDriveProps | null;
}

export function DocumentsDialog({
  activeId,
  onClose,
  onOpen,
  onDuplicate,
  onDelete,
  onRename,
  onExport,
  onImport,
  drive,
}: Props) {
  const [metas, setMetas] = useState<DocMeta[] | null>(null); // null = loading
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  // Two-step delete: first click arms this row, second confirms; any other
  // action (or re-listing) disarms.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  // Set when Open/Duplicate/Rename/Delete/Export throws (most commonly: the
  // document is corrupt, or vanished under a concurrent action) — shown as a
  // banner instead of a silent no-op / unhandled rejection. "corrupted" gets
  // its own shape so the message can bold "Export as JSON" (still works on a
  // corrupt record); anything else renders as plain text.
  const [actionError, setActionError] = useState<
    { kind: "corrupted"; name: string } | { kind: "plain"; message: string } | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    listMeta()
      .then(setMetas)
      .catch(() => setMetas([]));
  }, []);
  const driveRevision = drive?.revision ?? 0;
  useEffect(reload, [reload, driveRevision]);
  useEffect(() => onThumbChanged(reload), [reload]);

  // Run an action with the list disarmed + refreshed afterwards. Actions that
  // switch the active document also close the dialog (via `closeAfter`). A
  // thrown error (e.g. the document is corrupt) surfaces as a banner instead
  // of closing/switching — the dialog stays open so the user can act on it
  // (Export as JSON still works on a corrupt doc; Delete always does).
  const run = async (action: () => Promise<void>, closeAfter = false) => {
    setBusy(true);
    setConfirmDelete(null);
    setActionError(null);
    setImportError(null);
    try {
      await action();
      if (closeAfter) onClose();
      else reload();
    } catch (err) {
      setActionError(
        err instanceof CorruptDocError
          ? { kind: "corrupted", name: err.docName }
          : { kind: "plain", message: String((err as Error)?.message ?? err) },
      );
      reload(); // the doc may have vanished/changed — refresh what we show
    } finally {
      setBusy(false);
    }
  };

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    const id = renaming.id;
    setRenaming(null);
    if (name) void run(() => onRename(id, name));
  };

  // Import a picked/dropped file. Success switches to the imported doc and
  // closes; failure keeps the dialog open with the (readable) error.
  const importFile = async (file: File) => {
    setBusy(true);
    setImportError(null);
    setActionError(null);
    try {
      const err = await onImport(file);
      if (err) setImportError(err);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Documents"
      className="docs-dialog"
      escapeCapture
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) void importFile(file);
      }}
    >
      <div className="docs-header">
        <h2>Documents</h2>
        <button
          className="text-btn"
          disabled={busy}
          title="Import a document from an Open Poly .json file"
          onClick={() => fileInputRef.current?.click()}
        >
          Import from JSON
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // re-picking the same file fires again
            if (file) void importFile(file);
          }}
        />
        <button className="row-icon docs-close" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      {importError && <p className="docs-error">{importError}</p>}
      {actionError && (
        <p className="docs-error">
          {actionError.kind === "corrupted" ? (
            <>
              "{actionError.name}" is corrupted and can't be opened. Use <strong>Export as JSON</strong> to save its
              data, then Delete it.
            </>
          ) : (
            actionError.message
          )}
        </p>
      )}

      {drive && drive.attention > 0 && (
        <p className="docs-attention">
          {drive.attention} document{drive.attention === 1 ? " needs" : "s need"} a decision before it can sync.{" "}
          <button className="banner-link" onClick={drive.onReview}>
            Review
          </button>
        </p>
      )}

      {metas === null ? (
        <p className="hint">Loading…</p>
      ) : metas.length === 0 ? (
        <p className="hint">No documents yet.</p>
      ) : (
        <ul className="docs-list">
          {metas.map((m) => {
            const active = m.id === activeId;
            return (
              <li key={m.id} className={"docs-row" + (active ? " active" : "")}>
                <Thumb thumb={m.thumb} />
                <div className="docs-row-main">
                  {renaming?.id === m.id ? (
                    <input
                      className="docs-name-input"
                      autoFocus
                      value={renaming.draft}
                      onChange={(e) => setRenaming({ id: m.id, draft: e.target.value })}
                      onFocus={(e) => e.target.select()}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") {
                          e.stopPropagation(); // keep the dialog open
                          setRenaming(null);
                        }
                      }}
                    />
                  ) : (
                    <button
                      className="docs-name"
                      title="Rename"
                      onClick={() => setRenaming({ id: m.id, draft: m.name })}
                    >
                      {m.name}
                      {active && <span className="docs-current"> · current</span>}
                    </button>
                  )}
                  <span className="docs-sub">
                    edited {timeAgo(m.updatedAt)} · {m.featureCount} feature{m.featureCount === 1 ? "" : "s"} ·{" "}
                    {m.partCount} part{m.partCount === 1 ? "" : "s"}
                    {drive?.states[m.id] && (
                      <>
                        {" · "}
                        <span className={`docs-sync docs-sync--${drive.states[m.id]}`}>
                          {SYNC_LABEL[drive.states[m.id]]}
                        </span>
                      </>
                    )}
                  </span>
                </div>
                <div className="docs-row-actions">
                  {!active && (
                    <button className="text-btn" disabled={busy} onClick={() => void run(() => onOpen(m.id), true)}>
                      Open
                    </button>
                  )}
                  <button className="text-btn" disabled={busy} onClick={() => void run(() => onDuplicate(m.id), true)}>
                    Duplicate
                  </button>
                  <button
                    className="text-btn"
                    disabled={busy}
                    title="Save this document as an Open Poly .json file"
                    onClick={() => void run(() => onExport(m.id))}
                  >
                    Export as JSON
                  </button>
                  {drive && (drive.states[m.id] === "unsynced" || drive.states[m.id] === "localOnly") && (
                    <button
                      className="text-btn"
                      disabled={busy}
                      title="Put this document in your Google Drive"
                      onClick={() => void run(() => drive.onUpload(m.id))}
                    >
                      Put in Drive
                    </button>
                  )}
                  {confirmDelete === m.id && drive && IN_DRIVE.has(drive.states[m.id]) ? (
                    <>
                      <button
                        className="text-btn"
                        disabled={busy}
                        title="Delete the copy on this device. It stays in Google Drive and can be opened again."
                        onClick={() => void run(() => onDelete(m.id))}
                      >
                        Remove from this device
                      </button>
                      <button
                        className="text-btn docs-delete-confirm"
                        disabled={busy}
                        title="Delete it here and move it to Google Drive's trash"
                        onClick={() => void run(() => drive.onDeleteEverywhere(m.id))}
                      >
                        Delete everywhere
                      </button>
                    </>
                  ) : confirmDelete === m.id ? (
                    <button
                      className="text-btn docs-delete-confirm"
                      disabled={busy}
                      onClick={() => void run(() => onDelete(m.id))}
                    >
                      Really delete?
                    </button>
                  ) : (
                    <button className="text-btn" disabled={busy} onClick={() => setConfirmDelete(m.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {drive && drive.cloudOnly.length > 0 && (
        <>
          <h3 className="docs-section-title">In Google Drive, not on this device</h3>
          <ul className="docs-list">
            {drive.cloudOnly.map((r) => (
              <li key={r.fileId} className="docs-row cloud-only">
                <CloudThumb url={r.thumbnailUrl} />
                <div className="docs-row-main">
                  <span className="docs-name docs-name--static">{r.name}</span>
                  <span className="docs-sub">edited {timeAgo(Date.parse(r.modifiedTime))} · in Google Drive</span>
                </div>
                <div className="docs-row-actions">
                  <button
                    className="text-btn"
                    disabled={busy}
                    onClick={() => void run(() => drive.onOpenCloud(r.fileId), true)}
                  >
                    Open
                  </button>
                  {confirmDelete === r.fileId ? (
                    <button
                      className="text-btn docs-delete-confirm"
                      disabled={busy}
                      onClick={() => void run(() => drive.onTrashCloud(r.fileId))}
                    >
                      Move to Drive's trash?
                    </button>
                  ) : (
                    <button className="text-btn" disabled={busy} onClick={() => setConfirmDelete(r.fileId)}>
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

/** A Drive-only document's preview, from Drive's thumbnail link. Those links
 *  are short-lived and Google may refuse one, so any failure falls back to the
 *  cloud placeholder rather than a broken image. */
function CloudThumb({ url }: { url?: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <div className="docs-thumb placeholder">☁</div>;
  return <img className="docs-thumb" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

/** Thumbnail Blob → object URL, revoked on unmount/replace. A document that has
 *  not been captured yet has no blob, and renders the empty placeholder. */
function Thumb({ thumb }: { thumb?: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = thumb ? URL.createObjectURL(thumb) : null;
    setUrl(urlRef.current);
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [thumb]);
  return url ? <img className="docs-thumb" src={url} alt="" /> : <div className="docs-thumb placeholder" />;
}
