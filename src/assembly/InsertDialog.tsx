// Insert: choose a part document, then which of its parts to place. The list
// is the Documents dialog's rows (meta only, never full records), limited to
// part documents; picking one reads it as a source — building it first if this
// device never has — to show its parts.
import { useEffect, useState } from "react";
import { listMeta, type DocMeta } from "../storage/db";
import { timeAgo } from "../storage/docNames";
import { Modal } from "../ui/Modal";
import { Thumb } from "../ui/DocumentsDialog";
import { readSource, type BuildDocument, type SourcePart, type SourceState } from "./useAssemblySources";

interface Props {
  onClose: () => void;
  onInsert: (docId: string, parts: SourcePart[]) => void;
  build: BuildDocument | null;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export function InsertDialog({ onClose, onInsert, build }: Props) {
  const [metas, setMetas] = useState<DocMeta[] | null>(null);
  const [chosen, setChosen] = useState<{ id: string; source: SourceState } | null>(null);
  // Part ids left unticked (default: every part).
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  useEffect(() => {
    listMeta()
      .then((all) => setMetas(all.filter((m) => m.kind !== "assembly")))
      .catch(() => setMetas([]));
  }, []);

  const choose = (id: string) => {
    setSkipped(new Set());
    setChosen({ id, source: { status: "loading" } });
    void readSource(id, build).then((source) => setChosen((c) => (c?.id === id ? { id, source } : c)));
  };

  const src = chosen?.source;
  const parts = src?.status === "ready" ? src.parts : [];
  const picked = parts.filter((p) => !skipped.has(p.partId));

  return (
    <Modal onClose={onClose} ariaLabel="Insert parts" className="docs-dialog insert-dialog" escapeCapture>
      <div className="docs-header">
        <h2>{chosen && src?.status === "ready" ? `Insert from ${src.name}` : "Insert parts"}</h2>
        {chosen && (
          <button className="text-btn" onClick={() => setChosen(null)}>
            ‹ All documents
          </button>
        )}
        <button className="row-icon docs-close" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>

      {!chosen ? (
        metas === null ? (
          <p className="hint">Loading…</p>
        ) : metas.length === 0 ? (
          <p className="hint">No part documents yet. Model a part in its own document, then insert it here.</p>
        ) : (
          <ul className="docs-list">
            {metas.map((m) => (
              <li key={m.id}>
                <button className="docs-row insert-doc" onClick={() => choose(m.id)}>
                  <Thumb thumb={m.thumb} />
                  <span className="docs-row-main">
                    <span className="docs-name docs-name--static">{m.name}</span>
                    <span className="docs-sub">
                      edited {timeAgo(m.updatedAt)}
                      {!m.unbuilt && ` · ${m.partCount} part${m.partCount === 1 ? "" : "s"}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : src?.status === "ready" ? (
        parts.length === 0 ? (
          <p className="hint">This document has no parts to insert.</p>
        ) : (
          <>
            <ul className="insert-parts">
              {parts.map((p) => (
                <li key={p.partId}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!skipped.has(p.partId)}
                      onChange={(e) =>
                        setSkipped((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.delete(p.partId);
                          else next.add(p.partId);
                          return next;
                        })
                      }
                    />
                    <span className="insert-swatch" style={{ background: hex(p.color) }} />
                    {p.name}
                  </label>
                </li>
              ))}
            </ul>
            <div className="insert-actions">
              <button
                className="text-btn insert-confirm"
                disabled={picked.length === 0}
                onClick={() => {
                  onInsert(chosen.id, picked);
                  onClose();
                }}
              >
                Insert {picked.length === 1 ? "1 part" : `${picked.length} parts`}
              </button>
            </div>
          </>
        )
      ) : src?.status === "error" ? (
        <p className="docs-error">
          Couldn't read {src.name}: {src.message}
        </p>
      ) : src?.status === "missing" ? (
        <p className="docs-error">That document no longer exists.</p>
      ) : (
        <p className="hint">{src?.status === "building" || !build ? "Building its parts…" : "Loading…"}</p>
      )}
    </Modal>
  );
}
