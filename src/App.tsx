import { useEffect, useMemo, useRef, useState } from "react";
import { KernelClient } from "./kernel/KernelClient";
import {
  addBoolean,
  addDressUp,
  addExtrude,
  addFeature,
  addSketch,
  addSketchConstraints,
  addSketchEntities,
  addVariable,
  createDocument,
  genId,
  moveFeature,
  removeFeature,
  removeSketchEntity,
  removeVariable,
  renameFeature,
  resolveDocument,
  setFeatureColor,
  setFeatureHidden,
  setFeatureOpacity,
  setRollbackIndex,
  setSketchConstraints,
  setSketchEntities,
  setSuppressed,
  updateParam,
  updateVariable,
} from "./document/document";
import { DEFAULT_SOLID_COLOR } from "./document/colors";
import type {
  Document,
  ExtrudeProfile,
  FeatureKind,
  SketchEntity,
  SketchFeature,
  Vec2,
} from "./document/types";
import type { BooleanOp, MeshedEdges, MeshedFaces } from "./kernel/types";
import { solveSketch } from "./sketch/solver";
import { measureSelection } from "./selection/measure";
import { frameOf, planeRefLabel, uvToWorld, type SketchPlaneRef } from "./document/planes";
import { evaluateExpression } from "./document/expression";
import { detectSketchRegions } from "./document/regions";
import { FEATURE_DEFS, FEATURE_KINDS } from "./document/featureDefs";
import { listDocs, saveDoc } from "./storage/db";
import {
  arcFrom3,
  circleFrom3,
  loopSegments,
  rectangleCorners,
  rectangleFromCenter,
  regularPolygon,
} from "./document/sketchTools";
import { useHistory } from "./hooks/useHistory";
import { EyeIcon } from "./ui/icons";
import { BooleanDialog } from "./ui/BooleanDialog";
import { FeatureTree } from "./ui/FeatureTree";
import { ParamEditor } from "./ui/ParamEditor";
import { SolidsList } from "./ui/SolidsList";
import { VariablesPanel } from "./ui/VariablesPanel";
import {
  Viewport,
  sameSelection,
  type DatumId,
  type FeatureMesh,
  type Selection,
  type SketchTool,
  type ViewName,
  type ViewportApi,
} from "./viewport/Viewport";
import "./App.css";

/** Compact number formatting for the dimension input (trims trailing zeros). */
const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : String(r);
};

/** Average position of a tessellated body face — the centroid fallback used to
 *  re-find a face that has no persistent name yet. */
function faceCentroid(
  faces: MeshedFaces,
  faceId: number,
): [number, number, number] | null {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return null;
  const { triangles, vertices } = faces;
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let k = g.start; k < g.start + g.count; k++) {
    const vi = triangles[k] * 3;
    sx += vertices[vi];
    sy += vertices[vi + 1];
    sz += vertices[vi + 2];
    n++;
  }
  return n ? [sx / n, sy / n, sz / n] : null;
}

/** The persistent topological name of a tessellated face (if it has one). */
function faceNameOf(faces: MeshedFaces, faceId: number): string | undefined {
  return faces.faceGroups?.find((fg) => fg.faceId === faceId)?.name;
}

/** The persistent topological name of a tessellated edge (if it has one). */
function edgeNameOf(edges: MeshedEdges, edgeId: number): string | undefined {
  return edges.edgeGroups?.find((eg) => eg.edgeId === edgeId)?.name;
}

/** Midpoint of a tessellated edge (world space) — anchors the dress-up dialog. */
function edgeMidpoint(edges: MeshedEdges, edgeId: number): [number, number, number] | null {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g) return null;
  const { lines } = edges;
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (let v = g.start; v < g.start + g.count; v++) {
    sx += lines[v * 3]; sy += lines[v * 3 + 1]; sz += lines[v * 3 + 2]; n++;
  }
  return n ? [sx / n, sy / n, sz / n] : null;
}

/** Saves a Blob to the user's machine via a throwaway anchor element. */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Strips characters that are awkward in filenames across platforms. */
const safeFilename = (name: string) => name.replace(/[^a-z0-9_\-]+/gi, "_");

const DATUM_ROWS: { id: DatumId; kind: string; label: string }[] = [
  { id: "origin", kind: "Point", label: "Origin" },
  { id: "plane-top", kind: "Plane", label: "Top" },
  { id: "plane-front", kind: "Plane", label: "Front" },
  { id: "plane-right", kind: "Plane", label: "Right" },
];

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
    reset: resetDoc,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useHistory<Document>(initialDocument);
  // Persistence: the IndexedDB record id for the working document, and whether
  // the initial load has completed (autosave waits for it so the placeholder
  // doesn't clobber a saved doc).
  const docIdRef = useRef<string | null>(null);
  if (docIdRef.current === null) docIdRef.current = genId();
  const [persistLoaded, setPersistLoaded] = useState(false);
  const [selection, setSelection] = useState<Selection[]>([]);
  const featureIdOf = (s: Selection): string =>
    s.kind === "feature" ? s.id : "featureId" in s ? s.featureId : s.sketchId;
  const selectedFeatureIds = useMemo(() => new Set(selection.map(featureIdOf)), [selection]);
  // Which rendered bodies a whole-feature selection should highlight. A body
  // keeps the id of the feature that *created* it; in-place modifiers (Add/Remove
  // extrude, chamfer/fillet) preserve the target's id, so selecting the modifier
  // feature should highlight that target body (not look for a body with the
  // modifier's own id, which doesn't exist).
  const highlightBodyIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of selection) {
      if (s.kind !== "feature") continue;
      const f = doc.features.find((x) => x.id === s.id);
      if (f?.type === "extrude" && (f.mode === "add" || f.mode === "remove") && f.targetId) ids.add(f.targetId);
      else if (f?.type === "dressup") ids.add(f.targetId);
      else ids.add(s.id);
    }
    return ids;
  }, [selection, doc]);
  const primaryFeatureId = selection.length ? featureIdOf(selection[selection.length - 1]) : null;
  const selectFeature = (id: string | null) =>
    setSelection(id === null ? [] : [{ kind: "feature", id }]);
  // Regular clicks accumulate into the set; clicking a selected element removes
  // it; clicking empty space clears.
  const handlePick = (picked: Selection | null) => {
    // Dimension mode armed: the next picked line becomes the dimension target.
    if (dimPending) {
      const sk = doc.features.find((f) => f.id === editingSketchId);
      const e =
        picked?.kind === "sketchEntity" && picked.sketchId === editingSketchId && sk?.type === "sketch"
          ? sk.entities.find((x) => x.id === picked.entityId)
          : undefined;
      if (e?.type === "line") {
        setSelection([picked!]);
        openDimensionFor(e);
      } else {
        setDimPending(false); // clicked empty / non-line → cancel
      }
      return;
    }
    if (!picked) {
      setSelection([]);
      return;
    }
    setSelection((prev) => {
      const i = prev.findIndex((s) => sameSelection(s, picked));
      if (i >= 0) return prev.filter((_, j) => j !== i);
      return [...prev, picked];
    });
  };
  const [picking, setPicking] = useState(false);
  const [editingSketchId, setEditingSketchId] = useState<string | null>(null);
  const [sketchTool, setSketchToolState] = useState<SketchTool>("line");
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [polygonSides, setPolygonSides] = useState(6);
  const [fullyConstrained, setFullyConstrained] = useState(false);
  // Length-dimension entry: the line being dimensioned, the in-progress text,
  // and the on-screen position (px, canvas-relative) to anchor the input box.
  const [dimInput, setDimInput] = useState<
    { entityId: string; value: string; x: number; y: number } | null
  >(null);
  // Armed dimension mode: D was pressed with nothing selected; the next picked
  // line becomes the dimension target.
  const [dimPending, setDimPending] = useState(false);
  // The extrude dialog (anchored at the profile) while choosing parameters.
  const [extrudeDialog, setExtrudeDialog] = useState<
    { mode: "new" | "add" | "remove"; distance: string; flip: boolean; targetId: string | null; x: number; y: number } | null
  >(null);
  const [dressUpDialog, setDressUpDialog] = useState<
    { op: "chamfer" | "fillet"; size: string; x: number; y: number } | null
  >(null);
  // The "New Body" dropdown (box/cylinder/sphere) in the viewport toolbar.
  const [newSolidOpen, setNewSolidOpen] = useState(false);
  const newSolidRef = useRef<HTMLDivElement>(null);
  const startDimensionRef = useRef<() => void>(() => {});
  const dimPendingRef = useRef(dimPending);
  dimPendingRef.current = dimPending;
  const dimInputRef = useRef(dimInput);
  dimInputRef.current = dimInput;
  const [datumVisibility, setDatumVisibility] = useState<Record<DatumId, boolean>>({
    origin: true,
    "plane-top": true,
    "plane-front": true,
    "plane-right": true,
  });
  const viewApiRef = useRef<ViewportApi | null>(null);

  const setSketchTool = (t: SketchTool) => {
    setSketchToolState(t);
    setDraft([]); // starting a new tool abandons any in-progress points
  };
  // Geometry from the last kernel regen, keyed by feature id. Color/opacity
  // live on the feature and are overlaid in `meshes` below so tweaking them
  // doesn't require re-running the (expensive) kernel regen.
  const [rawMeshes, setRawMeshes] = useState<{ id: string; mesh: FeatureMesh["mesh"] }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [booleanDialog, setBooleanDialog] = useState<{ op: BooleanOp; operandIds: string[] } | null>(
    null,
  );

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

  // Restore the working document from IndexedDB on first load (most recent), or
  // keep the seed and adopt its id. Autosave only starts once this completes so
  // the placeholder can't overwrite a saved document.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const docs = await listDocs();
        if (cancelled) return;
        if (docs.length > 0) {
          docIdRef.current = docs[0].id;
          resetDoc(docs[0].doc);
        }
      } catch (err) {
        console.warn("could not load saved document:", err);
      } finally {
        if (!cancelled) setPersistLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resetDoc]);

  // Autosave the working document to IndexedDB (debounced) after each change.
  useEffect(() => {
    if (!persistLoaded) return;
    const t = setTimeout(() => {
      saveDoc({ id: docIdRef.current!, name: "Untitled", doc, updatedAt: Date.now() }).catch((err) =>
        console.warn("autosave failed:", err),
      );
    }, 600);
    return () => clearTimeout(t);
  }, [doc, persistLoaded]);

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
        if (dimInputRef.current) setDimInput(null);
        else if (dimPendingRef.current) setDimPending(false);
        else if (picking) setPicking(false);
        else if (draft.length > 0) setDraft([]); // cancel the in-progress shape
        else if (editingSketchId) finishSketch();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.key === "Delete" || e.key === "Backspace") && selection.length > 0) {
        e.preventDefault();
        handleDeleteSelection();
        return;
      }
      if (e.key === "Enter" && draft.length > 0) {
        setDraft([]);
        return;
      }
      // D dimensions the selected line (the standard dimension shortcut).
      // preventDefault so the keystroke can't leak into the input that opening
      // the dialog autofocuses synchronously.
      if (editingSketchId && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        startDimensionRef.current();
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
  }, [undo, redo, picking, draft, editingSketchId, selection, doc]);

  // Close the "New Body" dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!newSolidOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!newSolidRef.current?.contains(e.target as Node)) setNewSolidOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [newSolidOpen]);

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
        const nextMeshes: { id: string; mesh: FeatureMesh["mesh"] }[] = [];
        const regenErrors: Record<string, string> = { ...resolved.errors };
        for (const r of results) {
          if (r.ok) nextMeshes.push({ id: r.id, mesh: r.mesh });
          else regenErrors[r.id] = r.error;
        }
        setRawMeshes(nextMeshes);
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

  // Overlay each body's current color/opacity from the document onto its
  // cached geometry — so changing appearance is instant, not a regen round-trip.
  const meshes = useMemo<FeatureMesh[]>(
    () =>
      rawMeshes.flatMap((m) => {
        const feature = doc.features.find((f) => f.id === m.id);
        // Primitives, "new" extrusions, and booleans own a color/opacity/hidden;
        // a body modified in place (add/remove/dressup) keeps the id — and those
        // appearance props — of its source.
        const owns =
          feature?.type === "primitive" || feature?.type === "extrude" || feature?.type === "boolean";
        if (owns && feature.hidden) return []; // hidden part — don't render or pick
        const color = owns ? feature.color : DEFAULT_SOLID_COLOR;
        const opacity = owns ? feature.opacity : 1;
        return [{ id: m.id, mesh: m.mesh, color, opacity }];
      }),
    [rawMeshes, doc],
  );

  // Feature ids that produced an actual rendered body — what the Solids list
  // shows and what a Boolean can combine (primitives, "new" extrusions,
  // booleans, and add/dressup-targets that kept their id).
  const bodyIds = useMemo(() => new Set(rawMeshes.map((m) => m.id)), [rawMeshes]);

  // Bodies available as Boolean operands: features with a rendered body.
  const booleanCandidates = useMemo(
    () =>
      doc.features
        .filter((f) => bodyIds.has(f.id))
        .map((f) => ({ id: f.id, name: f.name })),
    [doc, bodyIds],
  );

  const selected = useMemo(
    () => doc.features.find((f) => f.id === primaryFeatureId) ?? null,
    [doc, primaryFeatureId],
  );

  const editingSketch = useMemo(() => {
    const f = doc.features.find((x) => x.id === editingSketchId);
    return f && f.type === "sketch" ? f : null;
  }, [doc, editingSketchId]);

  // The single line currently selected inside the active sketch (the target a
  // length dimension would apply to). Null unless exactly one such line is held.
  const dimLine = useMemo(() => {
    if (!editingSketch) return null;
    const lines = selection.filter(
      (s): s is Extract<Selection, { kind: "sketchEntity" }> =>
        s.kind === "sketchEntity" && s.sketchId === editingSketch.id,
    );
    if (lines.length !== 1) return null;
    const e = editingSketch.entities.find((x) => x.id === lines[0].entityId);
    if (e?.type !== "line") return null;
    return { entityId: e.id, length: Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) };
  }, [editingSketch, selection]);

  const measure = useMemo(
    () => measureSelection(selection, doc, meshes),
    [selection, doc, meshes],
  );

  // A single selected profile an Extrude could consume: a sketch region or a
  // planar face of an existing body (with its centroid baked in for re-finding).
  const extrudeProfile = useMemo((): ExtrudeProfile | null => {
    if (selection.length !== 1) return null;
    const s = selection[0];
    if (s.kind === "sketchFace") return { kind: "sketchRegion", sketchId: s.sketchId, regionId: s.regionId };
    if (s.kind === "face") {
      const m = meshes.find((x) => x.id === s.featureId);
      const center = m ? faceCentroid(m.mesh.faces, s.faceId) : null;
      if (!center) return null;
      const faceName = m ? faceNameOf(m.mesh.faces, s.faceId) : undefined;
      return { kind: "bodyFace", featureId: s.featureId, faceId: s.faceId, faceName, center };
    }
    return null;
  }, [selection, meshes]);

  // World-space anchor for the extrude dialog: a body face's centroid, or a
  // sketch region's centroid mapped to 3D.
  const profileAnchorWorld = (): [number, number, number] | null => {
    const p = extrudeProfile;
    if (!p) return null;
    if (p.kind === "bodyFace") return p.center;
    const sk = doc.features.find((f) => f.id === p.sketchId);
    if (sk?.type !== "sketch") return null;
    const region = detectSketchRegions(sk.entities).find((r) => r.id === p.regionId);
    if (!region || region.outline.length === 0) return null;
    let u = 0, v = 0;
    for (const pt of region.outline) { u += pt[0]; v += pt[1]; }
    const n = region.outline.length;
    return uvToWorld(frameOf(sk.plane), u / n, v / n);
  };

  const openExtrudeDialog = () => {
    if (!extrudeProfile) return;
    const world = profileAnchorWorld();
    const s = (world && viewApiRef.current?.worldToScreen(world)) || { x: 240, y: 140 };
    // Default add/remove target: the face's own body, else the first body.
    const defaultTarget =
      extrudeProfile.kind === "bodyFace" ? extrudeProfile.featureId : booleanCandidates[0]?.id ?? null;
    setExtrudeDialog({ mode: "new", distance: "10", flip: false, targetId: defaultTarget, x: s.x, y: s.y });
  };

  const createExtrude = () => {
    if (!extrudeProfile || !extrudeDialog) return;
    // Add/Remove require a target body to affect.
    if (extrudeDialog.mode !== "new" && !extrudeDialog.targetId) return;
    const { doc: next, id } = addExtrude(doc, extrudeProfile, {
      distance: extrudeDialog.distance,
      flip: extrudeDialog.flip,
      mode: extrudeDialog.mode,
      targetId: extrudeDialog.mode === "new" ? undefined : extrudeDialog.targetId ?? undefined,
    });
    setDoc(next);
    selectFeature(id);
    setExtrudeDialog(null);
  };

  // One or more selected body edges, all on the same body — what a chamfer or
  // fillet would dress. Resolves each edge to its persistent name.
  const dressUpTarget = useMemo(() => {
    const edges = selection.filter((s): s is Extract<Selection, { kind: "edge" }> => s.kind === "edge");
    if (edges.length === 0 || edges.length !== selection.length) return null;
    const targetId = edges[0].featureId;
    if (!edges.every((e) => e.featureId === targetId)) return null;
    const m = meshes.find((x) => x.id === targetId);
    if (!m) return null;
    const names: string[] = [];
    for (const e of edges) {
      const nm = edgeNameOf(m.mesh.edges, e.edgeId);
      if (!nm) return null; // unnamed edge — can't reference it stably
      names.push(nm);
    }
    const anchor = edgeMidpoint(m.mesh.edges, edges[0].edgeId);
    return { targetId, edges: names, anchor };
  }, [selection, meshes]);

  const openDressUp = (op: "chamfer" | "fillet") => {
    if (!dressUpTarget) return;
    const s = (dressUpTarget.anchor && viewApiRef.current?.worldToScreen(dressUpTarget.anchor)) || { x: 240, y: 160 };
    setDressUpDialog({ op, size: "2", x: s.x, y: s.y });
  };

  const createDressUp = () => {
    if (!dressUpTarget || !dressUpDialog) return;
    const { doc: next, id } = addDressUp(
      doc, dressUpDialog.op, dressUpTarget.targetId, dressUpTarget.edges, dressUpDialog.size,
    );
    setDoc(next);
    selectFeature(id);
    setDressUpDialog(null);
  };

  // All visible sketches (so finished sketches stay rendered), each with its frame.
  const renderSketches = useMemo(
    () =>
      doc.features
        .slice(0, doc.rollbackIndex)
        .filter((f): f is SketchFeature => f.type === "sketch" && !f.suppressed)
        .map((f) => ({
          id: f.id,
          frame: frameOf(f.plane),
          entities: f.entities,
          regions: detectSketchRegions(f.entities),
        })),
    [doc],
  );

  const startSketchOn = (ref: SketchPlaneRef) => {
    const { doc: next, id } = addSketch(doc, ref);
    setDoc(next);
    selectFeature(id);
    setPicking(false);
    setEditingSketchId(id);
    setSketchTool("select");
    setFullyConstrained(false);
    viewApiRef.current?.lookAtFrame(frameOf(ref));
  };

  const editSketch = (id: string) => {
    const f = doc.features.find((x) => x.id === id);
    if (f?.type !== "sketch") return;
    setEditingSketchId(id);
    selectFeature(id);
    setSketchTool("select");
    setFullyConstrained(false);
    viewApiRef.current?.lookAtFrame(frameOf(f.plane));
  };

  const finishSketch = () => {
    // An empty sketch (no entities drawn) is treated as a cancel — drop it.
    const sk = doc.features.find((f) => f.id === editingSketchId);
    if (sk?.type === "sketch" && sk.entities.length === 0) {
      setDoc(removeFeature(doc, sk.id));
    }
    setEditingSketchId(null);
    setDraft([]);
    setSelection([]); // so the next click (e.g. a face to extrude) starts fresh
  };

  // A snapped click on the sketch plane (already in uv coords). Drives the
  // multi-click construction tools. `hv` records a horizontal/vertical inference
  // (line tool) so it can be captured as a constraint.
  const handleSketchClick = (uv: Vec2, hv?: "horizontal" | "vertical") => {
    if (!editingSketchId || sketchTool === "select") return;
    const sketchId = editingSketchId;
    const commit = (entities: SketchEntity[]) => {
      setDoc(addSketchEntities(doc, sketchId, entities));
      setFullyConstrained(false); // geometry changed; constraint state unknown
    };
    const lineEntity = (a: Vec2, b: Vec2): SketchEntity => ({ type: "line", id: genId(), a, b });
    const loopLines = (pts: Vec2[]) => loopSegments(pts).map(([a, b]) => lineEntity(a, b));

    switch (sketchTool) {
      case "line":
        if (draft.length === 0) setDraft([uv]);
        else {
          const line = lineEntity(draft[0], uv);
          let next = addSketchEntities(doc, sketchId, [line]);
          if (hv) {
            next = addSketchConstraints(next, sketchId, [{ id: genId(), type: hv, entity: line.id }]);
          }
          setDoc(next);
          setFullyConstrained(false);
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

  // Solve the given doc's sketch with planegcs, apply the moved geometry, and
  // refresh the fully-constrained indicator. Returns the updated doc.
  const solveSketchIn = async (docArg: Document, sketchId: string): Promise<Document> => {
    const sk = docArg.features.find((f) => f.id === sketchId);
    if (sk?.type !== "sketch") return docArg;
    try {
      const res = await solveSketch(sk.entities, sk.constraints);
      setFullyConstrained(res.dof === 0 && !res.hasConflicts);
      return setSketchEntities(docArg, sketchId, res.entities);
    } catch (err) {
      console.error("constraint solve failed:", err);
      return docArg;
    }
  };

  const handleSolve = async () => {
    if (!editingSketch) return;
    setDoc(await solveSketchIn(doc, editingSketch.id));
  };

  // Open the length-dimension input anchored next to the given line, pre-filled
  // with its present length.
  const openDimensionFor = (line: Extract<SketchEntity, { type: "line" }>) => {
    if (!editingSketch) return;
    const frame = frameOf(editingSketch.plane);
    const world = uvToWorld(frame, (line.a[0] + line.b[0]) / 2, (line.a[1] + line.b[1]) / 2);
    const s = viewApiRef.current?.worldToScreen(world) ?? { x: 240, y: 120 };
    const length = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
    setDimPending(false);
    setSelection([{ kind: "sketchEntity", sketchId: editingSketch.id, entityId: line.id }]);
    setDimInput({ entityId: line.id, value: fmt(length), x: s.x, y: s.y });
  };

  // D (or the ↔ button): dimension the selected line if there is one, otherwise
  // arm "pick a line to dimension" mode (forcing the Select tool so clicks pick).
  const startDimension = () => {
    if (!editingSketch) return;
    if (dimLine) {
      const e = editingSketch.entities.find((x) => x.id === dimLine.entityId);
      if (e?.type === "line") openDimensionFor(e);
      return;
    }
    setSketchTool("select");
    setDimPending(true);
  };
  startDimensionRef.current = startDimension;

  // Apply the entered length as a `distance` constraint and immediately re-solve
  // so the whole sketch updates. Replaces any prior length on the same line.
  const applyDimension = async () => {
    if (!dimInput || !editingSketch) return;
    const sketchId = editingSketch.id;
    // Evaluate against the variable scope so a number, expression, or variable
    // name all work. (Note: this resolves to a number now; a live expression
    // link that re-evaluates on variable change is a deferred Phase-2 gap.)
    let value = NaN;
    try {
      value = evaluateExpression(dimInput.value, resolved.scope);
    } catch {
      value = NaN;
    }
    setDimInput(null);
    if (!Number.isFinite(value) || value <= 0) return;
    const kept = editingSketch.constraints.filter(
      (c) => !(c.type === "distance" && c.entity === dimInput.entityId),
    );
    let next = setSketchConstraints(doc, sketchId, [
      ...kept,
      { id: genId(), type: "distance", entity: dimInput.entityId, value },
    ]);
    next = await solveSketchIn(next, sketchId);
    setDoc(next);
    setSelection([]);
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
    selectFeature(id);
  };

  // Opens the Boolean dialog, auto-populating operands from whatever solids
  // are already selected (deduped, in selection order).
  const openBooleanDialog = () => {
    const candidateIds = new Set(booleanCandidates.map((c) => c.id));
    const operandIds = [...new Set(selection.map(featureIdOf))].filter((id) =>
      candidateIds.has(id),
    );
    setBooleanDialog({ op: "union", operandIds });
  };

  const toggleBooleanOperand = (id: string) => {
    setBooleanDialog((d) => {
      if (!d) return d;
      const has = d.operandIds.includes(id);
      return {
        ...d,
        operandIds: has ? d.operandIds.filter((x) => x !== id) : [...d.operandIds, id],
      };
    });
  };

  const confirmBoolean = () => {
    if (!booleanDialog || booleanDialog.operandIds.length < 2) return;
    const { doc: next, id } = addBoolean(doc, booleanDialog.op, booleanDialog.operandIds);
    setDoc(next);
    selectFeature(id);
    setBooleanDialog(null);
  };

  const handleDelete = (id: string) => {
    setDoc(removeFeature(doc, id));
    setSelection((prev) => prev.filter((s) => featureIdOf(s) !== id));
    if (editingSketchId === id) setEditingSketchId(null);
  };

  const handleSolidColor = (id: string, color: number) => {
    setDoc(setFeatureColor(doc, id, color), `color:${id}`);
    setSelection([]); // deselect so the new color isn't masked by the highlight
  };

  const handleSolidOpacity = (id: string, opacity: number) =>
    setDoc(setFeatureOpacity(doc, id, opacity), `opacity:${id}`);

  const handleSolidHidden = (id: string, hidden: boolean) =>
    setDoc(setFeatureHidden(doc, id, hidden));

  const exportSolid = (id: string, format: "step" | "stl") => {
    const kernel = kernelRef.current;
    // `id` is a result-body id (a rendered mesh). The worker replays the feature
    // list and exports that body from the running model.
    if (!kernel || !rawMeshes.some((m) => m.id === id)) {
      setFatal("Can't export: this solid has no resolved geometry right now.");
      return;
    }
    const name = doc.features.find((f) => f.id === id)?.name ?? id;
    kernel
      .exportBody(resolved.features, id, format)
      .then((blob) => downloadBlob(blob, `${safeFilename(name)}.${format}`))
      .catch((err) => setFatal(String(err?.message ?? err)));
  };

  const handleExportStep = (id: string) => exportSolid(id, "step");
  const handleExportStl = (id: string) => exportSolid(id, "stl");

  // Delete key from the viewport: whole bodies/sketches (feature, face, edge,
  // vertex picks) are removed entirely; sketchEntity picks remove just that
  // line/curve. Bare sketchPoint/sketchFace picks have no deletion target.
  const handleDeleteSelection = () => {
    const featureIds = new Set<string>();
    const entityRefs: { sketchId: string; entityId: string }[] = [];
    for (const s of selection) {
      if (s.kind === "feature" || s.kind === "face" || s.kind === "edge" || s.kind === "vertex") {
        featureIds.add(featureIdOf(s));
      } else if (s.kind === "sketchEntity") {
        entityRefs.push({ sketchId: s.sketchId, entityId: s.entityId });
      }
    }
    let next = doc;
    for (const { sketchId, entityId } of entityRefs) {
      if (featureIds.has(sketchId)) continue; // whole sketch is already going away
      next = removeSketchEntity(next, sketchId, entityId);
    }
    for (const id of featureIds) {
      next = removeFeature(next, id);
    }
    if (next === doc) return;
    setDoc(next);
    setSelection([]);
    if (editingSketchId && featureIds.has(editingSketchId)) setEditingSketchId(null);
    if (entityRefs.length > 0) setFullyConstrained(false);
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">Open Poly</span>
        <span className="phase">Phase&nbsp;3 · modeling</span>
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
          <h2>Datums</h2>
          <div className="tree-list">
            {DATUM_ROWS.map((d) => {
              const visible = datumVisibility[d.id];
              return (
                <div className={"tree-row" + (visible ? "" : " dim")} key={d.id}>
                  <span className="row-kind">{d.kind}</span>
                  <span className="row-name">{d.label}</span>
                  <button
                    className="row-icon"
                    title={visible ? "Hide" : "Show"}
                    style={{ opacity: visible ? 1 : 0.35 }}
                    onClick={() => setDatumVisibility((v) => ({ ...v, [d.id]: !v[d.id] }))}
                  >
                    <EyeIcon />
                  </button>
                </div>
              );
            })}
          </div>
          <h2 className="params-heading">Variables</h2>
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
            selectedIds={selectedFeatureIds}
            errors={errors}
            onSelect={selectFeature}
            onDelete={handleDelete}
            onToggleSuppress={(id) =>
              setDoc(setSuppressed(doc, id, !doc.features.find((f) => f.id === id)?.suppressed))
            }
            onSetRollback={(index) => setDoc(setRollbackIndex(doc, index))}
            onMove={(id, delta) => setDoc(moveFeature(doc, id, delta))}
          />
          <h2 className="params-heading">Parts</h2>
          <SolidsList
            doc={doc}
            bodyIds={bodyIds}
            selectedIds={selectedFeatureIds}
            onSelect={selectFeature}
            onRename={(id, name) => setDoc(renameFeature(doc, id, name), `rename:${id}`)}
            onDelete={handleDelete}
            onColorChange={handleSolidColor}
            onOpacityChange={handleSolidOpacity}
            onToggleHidden={handleSolidHidden}
            onExportStep={handleExportStep}
            onExportStl={handleExportStl}
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
            selection={selection}
            highlightBodyIds={highlightBodyIds}
            onSelect={handlePick}
            datumVisibility={datumVisibility}
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
            sketchFullyConstrained={fullyConstrained}
            draft={draft}
            polygonSides={polygonSides}
            onSketchClick={handleSketchClick}
            apiRef={viewApiRef}
          />
          <div className="model-toolbar">
            <button
              title="Start a sketch (pick a plane or face)"
              disabled={!!editingSketch || picking}
              onClick={() => setPicking(true)}
            >
              ✎ Sketch
            </button>
            <div className="mt-dropdown" ref={newSolidRef}>
              <button
                title="Create a new solid body"
                disabled={!!editingSketch}
                onClick={() => setNewSolidOpen((o) => !o)}
              >
                ◧ New Body ▾
              </button>
              {newSolidOpen && (
                <div className="mt-menu">
                  {FEATURE_KINDS.map((kind) => (
                    <button
                      key={kind}
                      onClick={() => { handleAdd(kind); setNewSolidOpen(false); }}
                    >
                      {FEATURE_DEFS[kind].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              title="Extrude the selected sketch region or face"
              disabled={!extrudeProfile || !!editingSketch || picking || !!extrudeDialog}
              onClick={openExtrudeDialog}
            >
              ⬆ Extrude
            </button>
            <button
              title="Chamfer the selected edge(s)"
              disabled={!dressUpTarget || !!editingSketch || picking}
              onClick={() => openDressUp("chamfer")}
            >
              ◣ Chamfer
            </button>
            <button
              title="Fillet (round) the selected edge(s)"
              disabled={!dressUpTarget || !!editingSketch || picking}
              onClick={() => openDressUp("fillet")}
            >
              ◖ Fillet
            </button>
            <button
              title="Boolean (union / subtract / intersect)"
              disabled={bodyIds.size < 2 || !!editingSketch || picking}
              onClick={openBooleanDialog}
            >
              ⊕ Boolean
            </button>
          </div>
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
              <button
                title="Dimension a line (D) — pick one if none selected"
                className={dimPending ? "active" : ""}
                onClick={startDimension}
              >
                ↔
              </button>
              <button title="Solve constraints" onClick={handleSolve}>
                ⛓
              </button>
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
              {editingSketch.constraints.length > 0 && (
                <span
                  className="constraint-count"
                  title={`${editingSketch.constraints.length} constraints${fullyConstrained ? " · fully constrained" : ""}`}
                >
                  {fullyConstrained ? "✓" : editingSketch.constraints.length}
                </span>
              )}
            </div>
          )}
          {dimPending && (
            <div className="dim-hint">Pick a line to dimension · Esc to cancel</div>
          )}
          {dimInput && (
            <div
              className="dim-input"
              style={{ left: dimInput.x, top: dimInput.y }}
            >
              <label>Length</label>
              <input
                autoFocus
                value={dimInput.value}
                onChange={(e) => setDimInput((d) => (d ? { ...d, value: e.target.value } : d))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyDimension();
                  else if (e.key === "Escape") setDimInput(null);
                }}
              />
              <button onClick={applyDimension}>Set</button>
              <button className="ghost" onClick={() => setDimInput(null)}>
                ✕
              </button>
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
          {extrudeDialog && (
            <div className="extrude-dialog" style={{ left: extrudeDialog.x, top: extrudeDialog.y }}>
              <div className="ed-title">Extrude</div>
              <div className="ed-modes">
                {(["new", "add", "remove"] as const).map((m) => (
                  <button
                    key={m}
                    className={extrudeDialog.mode === m ? "active" : ""}
                    onClick={() => setExtrudeDialog((d) => (d ? { ...d, mode: m } : d))}
                  >
                    {m === "new" ? "New" : m === "add" ? "Add" : "Remove"}
                  </button>
                ))}
              </div>
              {extrudeDialog.mode !== "new" && (
                <label className="ed-field">
                  <span>Target</span>
                  <select
                    value={extrudeDialog.targetId ?? ""}
                    onChange={(e) => setExtrudeDialog((d) => (d ? { ...d, targetId: e.target.value || null } : d))}
                  >
                    <option value="" disabled>Select a part…</option>
                    {booleanCandidates.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="ed-field">
                <span>Distance</span>
                <input
                  autoFocus
                  value={extrudeDialog.distance}
                  onChange={(e) => setExtrudeDialog((d) => (d ? { ...d, distance: e.target.value } : d))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createExtrude();
                    else if (e.key === "Escape") setExtrudeDialog(null);
                  }}
                />
              </label>
              <label className="ed-field ed-flip">
                <span>Flip direction</span>
                <input
                  type="checkbox"
                  checked={extrudeDialog.flip}
                  onChange={(e) => setExtrudeDialog((d) => (d ? { ...d, flip: e.target.checked } : d))}
                />
              </label>
              <div className="ed-actions">
                <button
                  className="ed-primary"
                  disabled={extrudeDialog.mode !== "new" && !extrudeDialog.targetId}
                  onClick={createExtrude}
                >
                  Create
                </button>
                <button onClick={() => setExtrudeDialog(null)}>Cancel</button>
              </div>
            </div>
          )}
          {dressUpDialog && (
            <div className="extrude-dialog" style={{ left: dressUpDialog.x, top: dressUpDialog.y }}>
              <div className="ed-title">{dressUpDialog.op === "chamfer" ? "Chamfer" : "Fillet"}</div>
              <label className="ed-field">
                <span>{dressUpDialog.op === "chamfer" ? "Distance" : "Radius"}</span>
                <input
                  autoFocus
                  value={dressUpDialog.size}
                  onChange={(e) => setDressUpDialog((d) => (d ? { ...d, size: e.target.value } : d))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createDressUp();
                    else if (e.key === "Escape") setDressUpDialog(null);
                  }}
                />
              </label>
              <div className="ed-actions">
                <button className="ed-primary" onClick={createDressUp}>Create</button>
                <button onClick={() => setDressUpDialog(null)}>Cancel</button>
              </div>
            </div>
          )}
          {measure && (
            <div className="selection-info">
              <div className="si-title">{measure.title}</div>
              {measure.rows.map((r) => (
                <div className="si-row" key={r.label}>
                  <span className="si-label">{r.label}</span>
                  <span className="si-value">{r.value}</span>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
      {booleanDialog && (
        <BooleanDialog
          op={booleanDialog.op}
          operandIds={booleanDialog.operandIds}
          candidates={booleanCandidates}
          onOpChange={(op) => setBooleanDialog((d) => (d ? { ...d, op } : d))}
          onToggleOperand={toggleBooleanOperand}
          onConfirm={confirmBoolean}
          onCancel={() => setBooleanDialog(null)}
        />
      )}
    </div>
  );
}
