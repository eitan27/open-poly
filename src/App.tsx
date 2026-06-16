import { useEffect, useMemo, useRef, useState } from "react";
import { KernelClient } from "./kernel/KernelClient";
import {
  addFeature,
  addVariable,
  createDocument,
  moveFeature,
  removeFeature,
  removeVariable,
  renameFeature,
  resolveDocument,
  setRollbackIndex,
  setSuppressed,
  updateParam,
  updateVariable,
} from "./document/document";
import type { Document, FeatureKind } from "./document/types";
import { useHistory } from "./hooks/useHistory";
import { FeatureTree } from "./ui/FeatureTree";
import { ParamEditor } from "./ui/ParamEditor";
import { VariablesPanel } from "./ui/VariablesPanel";
import {
  Viewport,
  type DatumId,
  type FeatureMesh,
  type ViewName,
  type ViewportApi,
} from "./viewport/Viewport";
import "./App.css";

const VIEW_BUTTONS: { name: ViewName; label: string }[] = [
  { name: "top", label: "Top" },
  { name: "front", label: "Front" },
  { name: "right", label: "Right" },
  { name: "back", label: "Back" },
  { name: "left", label: "Left" },
  { name: "bottom", label: "Bottom" },
  { name: "iso", label: "Iso" },
];

const DATUM_LABELS: Record<DatumId, string> = {
  origin: "Origin",
  "plane-top": "Top plane",
  "plane-front": "Front plane",
  "plane-right": "Right plane",
};

function initialDocument(): Document {
  // Seed with one box so there is something on screen on first load.
  return addFeature(createDocument(), "box").doc;
}

export default function App() {
  const kernelRef = useRef<KernelClient | null>(null);
  const [ready, setReady] = useState(false);

  const {
    state: doc,
    set: setDoc,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useHistory<Document>(initialDocument);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDatum, setSelectedDatum] = useState<DatumId | null>(null);
  const viewApiRef = useRef<ViewportApi | null>(null);
  const [meshes, setMeshes] = useState<FeatureMesh[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  // Own the worker's lifecycle here so each mount cycle (incl. StrictMode's
  // mount/unmount/remount) gets a fresh, live kernel rather than a disposed one.
  useEffect(() => {
    const kernel = new KernelClient();
    kernelRef.current = kernel;
    setReady(true);
    return () => {
      kernel.dispose();
      kernelRef.current = null;
      setReady(false);
    };
  }, []);

  // Undo/redo keyboard shortcuts. Skip while typing so native text-field undo
  // keeps working inside inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedDatum(null);
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // Resolution (variables + params -> numbers) is synchronous and pure; memoize
  // it so the UI can read evaluated values without re-running the kernel.
  const resolved = useMemo(() => resolveDocument(doc), [doc]);

  // Regenerate whenever the resolved document changes — the kernel runs off-thread.
  useEffect(() => {
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    setBusy(true);

    kernel
      .regenerate(resolved.features)
      .then((results) => {
        if (cancelled) return;
        const nextMeshes: FeatureMesh[] = [];
        const regenErrors: Record<string, string> = { ...resolved.errors };
        for (const r of results) {
          if (r.ok) nextMeshes.push({ id: r.id, mesh: r.mesh });
          else regenErrors[r.id] = r.error;
        }
        setMeshes(nextMeshes);
        setErrors(regenErrors);
        setFatal(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("regeneration failed:", err);
        setFatal(String(err?.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resolved, ready]);

  const selected = useMemo(
    () => doc.features.find((f) => f.id === selectedId) ?? null,
    [doc, selectedId],
  );

  const errorCount =
    Object.keys(errors).length + Object.keys(resolved.variableErrors).length;
  const status = fatal
    ? "kernel error"
    : busy
      ? "regenerating…"
      : errorCount > 0
        ? `${errorCount} error${errorCount > 1 ? "s" : ""}`
        : "up to date";
  const statusClass = fatal || errorCount > 0 ? "err" : busy ? "busy" : "idle";

  const handleAdd = (kind: FeatureKind) => {
    const { doc: next, id } = addFeature(doc, kind);
    setDoc(next);
    setSelectedId(id);
  };

  const handleDelete = (id: string) => {
    setDoc(removeFeature(doc, id));
    if (selectedId === id) setSelectedId(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">open-shape</span>
        <span className="phase">Phase&nbsp;1 · timeline</span>
        <div className="topbar-actions">
          <button className="tool-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
            ↶
          </button>
          <button className="tool-btn" onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)">
            ↷
          </button>
        </div>
        <span className={`status ${statusClass}`} title={fatal ?? undefined}>
          {status}
        </span>
      </header>
      <div className="body">
        <aside className="panel">
          <h2>Variables</h2>
          <VariablesPanel
            variables={doc.variables}
            scope={resolved.scope}
            errors={resolved.variableErrors}
            onAdd={() => {
              const { doc: next } = addVariable(doc);
              setDoc(next);
            }}
            onChange={(id, field, value) =>
              setDoc(updateVariable(doc, id, field, value), `var:${id}:${field}`)
            }
            onDelete={(id) => setDoc(removeVariable(doc, id))}
          />
          <h2 className="params-heading">Timeline</h2>
          <FeatureTree
            doc={doc}
            selectedId={selectedId}
            errors={errors}
            onSelect={setSelectedId}
            onAdd={handleAdd}
            onDelete={handleDelete}
            onToggleSuppress={(id) =>
              setDoc(setSuppressed(doc, id, !doc.features.find((f) => f.id === id)?.suppressed))
            }
            onSetRollback={(index) => setDoc(setRollbackIndex(doc, index))}
            onMove={(id, delta) => setDoc(moveFeature(doc, id, delta))}
          />
          <h2 className="params-heading">Parameters</h2>
          <ParamEditor
            feature={selected}
            error={selected ? (errors[selected.id] ?? null) : null}
            onChangeParam={(id, name, value) =>
              setDoc(updateParam(doc, id, name, value), `param:${id}:${name}`)
            }
            onRename={(id, name) => setDoc(renameFeature(doc, id, name), `rename:${id}`)}
          />
        </aside>
        <main className="viewport">
          <Viewport
            meshes={meshes}
            selectedId={selectedId}
            selectedDatum={selectedDatum}
            onSelectDatum={setSelectedDatum}
            apiRef={viewApiRef}
          />
          <div className="view-controls">
            {VIEW_BUTTONS.map((v) => (
              <button key={v.name} onClick={() => viewApiRef.current?.setView(v.name)}>
                {v.label}
              </button>
            ))}
          </div>
          {selectedDatum && (
            <div className="datum-label">{DATUM_LABELS[selectedDatum]} selected</div>
          )}
        </main>
      </div>
    </div>
  );
}
