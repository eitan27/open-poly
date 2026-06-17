import { useEffect, useMemo, useRef, useState } from "react";
import { KernelClient } from "./kernel/KernelClient";
import {
  addFeature,
  addSketch,
  addSketchEntities,
  addVariable,
  createDocument,
  genId,
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
import type {
  Document,
  FeatureKind,
  SketchEntity,
  SketchFeature,
  Vec2,
} from "./document/types";
import { frameOf, planeRefLabel, type SketchPlaneRef } from "./document/planes";
import {
  arcFrom3,
  circleFrom3,
  loopSegments,
  rectangleCorners,
  rectangleFromCenter,
  regularPolygon,
} from "./document/sketchTools";
import { useHistory } from "./hooks/useHistory";
import { FeatureTree } from "./ui/FeatureTree";
import { ParamEditor } from "./ui/ParamEditor";
import { VariablesPanel } from "./ui/VariablesPanel";
import {
  Viewport,
  type FeatureMesh,
  type SketchTool,
  type ViewName,
  type ViewportApi,
} from "./viewport/Viewport";
import "./App.css";

const SKETCH_TOOLS: { tool: SketchTool; label: string; title: string }[] = [
  { tool: "select", label: "↖", title: "Select (V)" },
  { tool: "line", label: "╱", title: "Line (L)" },
  { tool: "rect-corner", label: "▭", title: "Rectangle: 2 corners (R)" },
  { tool: "rect-center", label: "⊞", title: "Rectangle: center + corner" },
  { tool: "circle-center", label: "○", title: "Circle: center + radius (C)" },
  { tool: "circle-3p", label: "◔", title: "Circle: 3 points" },
  { tool: "polygon", label: "⬢", title: "Regular polygon (P)" },
  { tool: "arc-3p", label: "⌒", title: "Arc: 3 points (A)" },
];

const VIEW_BUTTONS: { name: ViewName; label: string }[] = [
  { name: "top", label: "Top" },
  { name: "front", label: "Front" },
  { name: "right", label: "Right" },
  { name: "back", label: "Back" },
  { name: "left", label: "Left" },
  { name: "bottom", label: "Bottom" },
  { name: "iso", label: "Iso" },
];

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
  const [picking, setPicking] = useState(false);
  const [editingSketchId, setEditingSketchId] = useState<string | null>(null);
  const [sketchTool, setSketchToolState] = useState<SketchTool>("line");
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [polygonSides, setPolygonSides] = useState(6);
  const viewApiRef = useRef<ViewportApi | null>(null);

  const setSketchTool = (t: SketchTool) => {
    setSketchToolState(t);
    setDraft([]); // starting a new tool abandons any in-progress points
  };
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
    const SKETCH_KEYS: Record<string, SketchTool> = {
      v: "select",
      l: "line",
      r: "rect-corner",
      c: "circle-center",
      p: "polygon",
      a: "arc-3p",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (picking) setPicking(false);
        else if (draft.length > 0) setDraft([]); // cancel the in-progress shape
        else if (editingSketchId) finishSketch();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Enter" && draft.length > 0) {
        setDraft([]);
        return;
      }
      if (editingSketchId && !e.metaKey && !e.ctrlKey && SKETCH_KEYS[e.key.toLowerCase()]) {
        setSketchTool(SKETCH_KEYS[e.key.toLowerCase()]);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo, picking, draft, editingSketchId]);

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

  const editingSketch = useMemo(() => {
    const f = doc.features.find((x) => x.id === editingSketchId);
    return f && f.type === "sketch" ? f : null;
  }, [doc, editingSketchId]);

  // All visible sketches (so finished sketches stay rendered), each with its frame.
  const renderSketches = useMemo(
    () =>
      doc.features
        .slice(0, doc.rollbackIndex)
        .filter((f): f is SketchFeature => f.type === "sketch" && !f.suppressed)
        .map((f) => ({ id: f.id, frame: frameOf(f.plane), entities: f.entities })),
    [doc],
  );

  const startSketchOn = (ref: SketchPlaneRef) => {
    const { doc: next, id } = addSketch(doc, ref);
    setDoc(next);
    setSelectedId(id);
    setPicking(false);
    setEditingSketchId(id);
    setSketchTool("line");
    viewApiRef.current?.lookAtFrame(frameOf(ref));
  };

  const editSketch = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "sketch") return;
    setEditingSketchId(id);
    setSelectedId(id);
    setSketchTool("line");
    viewApiRef.current?.lookAtFrame(frameOf(f.plane));
  };

  const finishSketch = () => {
    setEditingSketchId(null);
    setDraft([]);
  };

  // A snapped click on the sketch plane (already in uv coords). Drives the
  // multi-click construction tools.
  const handleSketchClick = (uv: Vec2) => {
    if (!editingSketchId || sketchTool === "select") return;
    const sketchId = editingSketchId;
    const commit = (entities: SketchEntity[]) => {
      setDoc(addSketchEntities(doc, sketchId, entities));
    };
    const lineEntity = (a: Vec2, b: Vec2): SketchEntity => ({ type: "line", id: genId(), a, b });
    const loopLines = (pts: Vec2[]) => loopSegments(pts).map(([a, b]) => lineEntity(a, b));

    switch (sketchTool) {
      case "line":
        if (draft.length === 0) setDraft([uv]);
        else {
          commit([lineEntity(draft[0], uv)]);
          setDraft([uv]); // chain
        }
        break;
      case "rect-corner":
        if (draft.length === 0) setDraft([uv]);
        else {
          commit(loopLines(rectangleCorners(draft[0], uv)));
          setDraft([]);
        }
        break;
      case "rect-center":
        if (draft.length === 0) setDraft([uv]);
        else {
          commit(loopLines(rectangleFromCenter(draft[0], uv)));
          setDraft([]);
        }
        break;
      case "circle-center":
        if (draft.length === 0) setDraft([uv]);
        else {
          const r = Math.hypot(uv[0] - draft[0][0], uv[1] - draft[0][1]);
          commit([{ type: "circle", id: genId(), c: draft[0], r }]);
          setDraft([]);
        }
        break;
      case "circle-3p":
        if (draft.length < 2) setDraft([...draft, uv]);
        else {
          const c = circleFrom3(draft[0], draft[1], uv);
          if (c) commit([{ type: "circle", id: genId(), c: c.center, r: c.r }]);
          setDraft([]);
        }
        break;
      case "polygon":
        if (draft.length === 0) setDraft([uv]);
        else {
          commit(loopLines(regularPolygon(draft[0], uv, polygonSides)));
          setDraft([]);
        }
        break;
      case "arc-3p":
        if (draft.length < 2) setDraft([...draft, uv]);
        else {
          const a = arcFrom3(draft[0], uv, draft[1]); // start, mid(uv), end
          if (a) commit([{ type: "arc", id: genId(), c: a.center, r: a.r, start: a.start, end: a.end }]);
          setDraft([]);
        }
        break;
    }
  };

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
    if (editingSketchId === id) setEditingSketchId(null);
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
            onStartSketch={() => setPicking(true)}
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
            editingSketchId={editingSketchId}
            onChangeParam={(id, name, value) =>
              setDoc(updateParam(doc, id, name, value), `param:${id}:${name}`)
            }
            onRename={(id, name) => setDoc(renameFeature(doc, id, name), `rename:${id}`)}
            onEditSketch={editSketch}
            onFinishSketch={finishSketch}
          />
        </aside>
        <main className="viewport">
          <Viewport
            meshes={meshes}
            selectedId={selectedId}
            picking={picking}
            onPick={startSketchOn}
            activeSketch={
              editingSketch
                ? { datumId: editingSketch.plane.kind === "datum" ? editingSketch.plane.id : null }
                : null
            }
            sketchTool={sketchTool}
            sketches={renderSketches}
            activeSketchId={editingSketchId}
            draft={draft}
            polygonSides={polygonSides}
            onSketchClick={handleSketchClick}
            apiRef={viewApiRef}
          />
          {editingSketch && (
            <div className="sketch-toolbar">
              {SKETCH_TOOLS.map((t) => (
                <button
                  key={t.tool}
                  className={sketchTool === t.tool ? "active" : ""}
                  title={t.title}
                  onClick={() => setSketchTool(t.tool)}
                >
                  {t.label}
                </button>
              ))}
              {sketchTool === "polygon" && (
                <label className="poly-sides" title="Polygon sides">
                  <span>n</span>
                  <input
                    type="number"
                    min={3}
                    max={24}
                    value={polygonSides}
                    onChange={(e) =>
                      setPolygonSides(Math.max(3, Math.min(24, Number(e.target.value) || 3)))
                    }
                  />
                </label>
              )}
            </div>
          )}
          <div className="view-controls">
            {VIEW_BUTTONS.map((v) => (
              <button key={v.name} onClick={() => viewApiRef.current?.setView(v.name)}>
                {v.label}
              </button>
            ))}
          </div>
          {editingSketch ? (
            <div className="sketch-banner">
              <span>
                Editing <strong>{editingSketch.name}</strong> ·{" "}
                {planeRefLabel(editingSketch.plane)}
              </span>
              <button onClick={finishSketch}>Finish sketch ⏎</button>
            </div>
          ) : (
            picking && (
              <div className="sketch-banner pick">
                <span>Select a plane or planar face for the sketch</span>
                <button onClick={() => setPicking(false)}>Cancel (Esc)</button>
              </div>
            )
          )}
        </main>
      </div>
    </div>
  );
}
