// Insert: choose a part document, then which of its parts to place, and how
// many of each (copies.ts lays several out in a grid). The list
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
  onInsert: (docId: string, picks: { part: SourcePart; count: number }[]) => void;
  build: BuildDocument | null;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
/** The most copies one insert or duplicate makes. */
export const MAX_COPIES = 100;

export function InsertDialog({ onClose, onInsert, build }: Props) {
  const [metas, setMetas] = useState<DocMeta[] | null>(null);
  const [chosen, setChosen] = useState<{ id: string; source: SourceState } | null>(null);
  // Part ids left unticked (default: every part), and how many of each.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const countOf = (partId: string) => counts.get(partId) ?? 1;

  useEffect(() => {
    listMeta()
      .then((all) => setMetas(all.filter((m) => m.kind !== "assembly")))
      .catch(() => setMetas([]));
  }, []);

  const choose = (id: string) => {
    setSkipped(new Set());
    setCounts(new Map());
    setChosen({ id, source: { status: "loading" } });
    void readSource(id, build).then((source) => setChosen((c) => (c?.id === id ? { id, source } : c)));
  };

  const src = chosen?.source;
  const parts = src?.status === "ready" ? src.parts : [];
  const picked = parts.filter((p) => !skipped.has(p.partId));
  const total = picked.reduce((n, p) => n + countOf(p.partId), 0);

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
                  <label className="insert-count" title="How many to insert">
                    ×
                    <input
                      type="number"
                      min={1}
                      max={MAX_COPIES}
                      aria-label={`How many ${p.name}`}
                      disabled={skipped.has(p.partId)}
                      value={countOf(p.partId)}
                      onChange={(e) => {
                        const n = Math.max(1, Math.min(MAX_COPIES, Math.round(Number(e.target.value) || 1)));
                        setCounts((c) => new Map(c).set(p.partId, n));
                      }}
                      onFocus={(e) => e.target.select()}
                    />
                  </label>
                </li>
              ))}
            </ul>
            <div className="insert-actions">
              <button
                className="text-btn insert-confirm"
                disabled={picked.length === 0}
                onClick={() => {
                  onInsert(
                    chosen.id,
                    picked.map((part) => ({ part, count: countOf(part.partId) })),
                  );
                  onClose();
                }}
              >
                Insert {total === 1 ? "1 part" : picked.length === total ? `${total} parts` : `${total} instances`}
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
