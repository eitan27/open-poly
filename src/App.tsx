import { useEffect, useMemo, useRef, useState } from "react";
import { KernelClient } from "./kernel/KernelClient";
import {
  addFeature,
  createDocument,
  removeFeature,
  renameFeature,
  resolveDocument,
  setRollbackIndex,
  setSuppressed,
  updateParam,
} from "./document/document";
import type { Document, FeatureKind } from "./document/types";
import { FeatureTree } from "./ui/FeatureTree";
import { ParamEditor } from "./ui/ParamEditor";
import { Viewport, type FeatureMesh } from "./viewport/Viewport";
import "./App.css";

function initialDocument(): Document {
  // Seed with one box so there is something on screen on first load.
  return addFeature(createDocument(), "box").doc;
}

export default function App() {
  const kernelRef = useRef<KernelClient | null>(null);
  const [ready, setReady] = useState(false);

  const [doc, setDoc] = useState<Document>(initialDocument);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  // Regenerate whenever the document changes — the kernel runs off-thread.
  useEffect(() => {
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    setBusy(true);

    const resolved = resolveDocument(doc);
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
  }, [doc, ready]);

  const selected = useMemo(
    () => doc.features.find((f) => f.id === selectedId) ?? null,
    [doc, selectedId],
  );

  const errorCount = Object.keys(errors).length;
  const status = fatal
    ? "kernel error"
    : busy
      ? "regenerating…"
      : errorCount > 0
        ? `${errorCount} feature error${errorCount > 1 ? "s" : ""}`
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
        <span className={`status ${statusClass}`} title={fatal ?? undefined}>
          {status}
        </span>
      </header>
      <div className="body">
        <aside className="panel">
          <h2>Timeline</h2>
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
          />
          <h2 className="params-heading">Parameters</h2>
          <ParamEditor
            feature={selected}
            error={selected ? (errors[selected.id] ?? null) : null}
            onChangeParam={(id, name, value) => setDoc(updateParam(doc, id, name, value))}
            onRename={(id, name) => setDoc(renameFeature(doc, id, name))}
          />
        </aside>
        <main className="viewport">
          <Viewport meshes={meshes} selectedId={selectedId} />
        </main>
      </div>
    </div>
  );
}
