// The Documents manager (Phase 8.7 M2): a centered modal listing every stored
// document from the cheap `meta` store — full records (feature trees + cached
// meshes) are NEVER loaded just to browse. All mutations are owned by App
// (which owns the switch flow); the dialog re-lists after each action settles.
import { useCallback, useEffect, useRef, useState } from "react";
import { listMeta, type DocMeta } from "../storage/db";
import { timeAgo } from "../storage/docNames";

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
  // banner instead of a silent no-op / unhandled rejection.
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    listMeta()
      .then(setMetas)
      .catch(() => setMetas([]));
  }, []);
  useEffect(reload, [reload]);

  // Esc closes. Capture phase + stopPropagation so the app's global Escape
  // handling (cancel sketch drafts etc.) doesn't also fire underneath a modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

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
      setActionError(String((err as Error)?.message ?? err));
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
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="docs-dialog"
        role="dialog"
        aria-label="Documents"
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
        {actionError && <p className="docs-error">{actionError}</p>}

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
                    {confirmDelete === m.id ? (
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
      </div>
    </div>
  );
}

/** Thumbnail Blob → object URL, revoked on unmount/replace (M3 populates the
 *  blobs; until then this renders the empty placeholder). */
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
