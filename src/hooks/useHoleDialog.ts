// The Hole dialog's state machine, after useGearDialog: a debounced throwaway
// regenerate ghosts a NEW hole (only the drill tools, drawn as a cut), and an
// EDIT applies live to the real document.
import { useEffect, useState } from "react";
import { addHole, resolveDocument, updateHole } from "../document/document";
import {
  DEFAULT_HOLE_SETTINGS,
  defaultHolePoints,
  holeCenters,
  sameHolePoint,
  type HoleSettings,
} from "../document/hole";
import type { Document, Feature, HoleFeature, HolePointRef, SketchFeature } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import type { ShapeMeshPayload } from "../kernel/types";

const PREVIEW_DEBOUNCE_MS = 120;

export interface HoleDialogState {
  sketchId: string | null;
  targetId: string | null;
  settings: HoleSettings;
  editId?: string;
  /** The Location slot is listening: the next sketch point, circle, arc or
   *  line clicked adds (or removes) a hole there. */
  picking: boolean;
}

export interface HoleDialogDeps {
  doc: Document;
  setDoc: (next: Document | ((prev: Document) => Document), coalesceKey?: string) => void;
  ready: boolean;
  kernelRef: React.RefObject<KernelClient | null>;
  beginEdit: (feature: Feature) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  shouldLiveApply: (signature: string) => boolean;
  selectFeature: (id: string | null) => void;
}

export interface HoleDialogApi {
  dialog: HoleDialogState | null;
  preview: ShapeMeshPayload | null;
  previewError: string | null;
  /** Open on a sketch (the selected one, else the newest with points) and a
   *  body (the one the sketch sits on, else `fallbackTarget`). */
  open: (sketchId: string | null, fallbackTarget: string | null) => void;
  edit: (feature: HoleFeature) => void;
  close: () => void;
  confirm: () => void;
  setSketch: (id: string) => void;
  /** A snap point clicked while picking: toggles it, or — in another sketch —
   *  starts over in that one (a hole's points share one sketch's plane). */
  pickPoint: (sketchId: string, ref: HolePointRef) => void;
  clearPoints: () => void;
  setPicking: (on: boolean) => void;
  setTarget: (id: string) => void;
  update: (patch: Partial<HoleSettings>) => void;
  updateParam: (name: keyof HoleSettings["params"], value: string) => void;
}

/** Sketches a hole can use: any with a point or a circle. */
export function holeSketches(doc: Document): SketchFeature[] {
  return doc.features.filter((f): f is SketchFeature => f.type === "sketch" && holeCenters(f).length > 0);
}

/** The body a sketch sits on, when it was drawn on a body face. */
function sketchBody(doc: Document, sketchId: string | null): string | null {
  const s = doc.features.find((f) => f.id === sketchId);
  return s?.type === "sketch" && s.plane.kind === "face" ? s.plane.featureId : null;
}

export function useHoleDialog(deps: HoleDialogDeps): HoleDialogApi {
  const { doc, setDoc, ready, kernelRef, beginEdit, commitEdit, cancelEdit, shouldLiveApply, selectFeature } = deps;
  const [dialog, setDialog] = useState<HoleDialogState | null>(null);
  const [preview, setPreview] = useState<ShapeMeshPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const open = (sketchId: string | null, fallbackTarget: string | null) => {
    const sketches = holeSketches(doc);
    const sk = sketchId && sketches.some((s) => s.id === sketchId) ? sketchId : (sketches.at(-1)?.id ?? null);
    const sketch = sketches.find((s) => s.id === sk);
    setDialog({
      sketchId: sk,
      targetId: sketchBody(doc, sk) ?? fallbackTarget,
      // Start on every point and circle centre of the sketch — the quick
      // path — with the slot listening, so a click narrows or extends it.
      settings: {
        ...DEFAULT_HOLE_SETTINGS,
        points: sketch ? defaultHolePoints(sketch) : [],
        params: { ...DEFAULT_HOLE_SETTINGS.params },
      },
      picking: true,
    });
  };

  const edit = (feature: HoleFeature) => {
    const sketch = doc.features.find((f): f is SketchFeature => f.id === feature.sketchId && f.type === "sketch");
    beginEdit(feature);
    selectFeature(feature.id);
    setDialog({
      sketchId: feature.sketchId,
      targetId: feature.targetId ?? null,
      settings: {
        holeType: feature.holeType,
        ...(feature.thread ? { thread: feature.thread } : {}),
        size: feature.size,
        fit: feature.fit,
        extent: feature.extent,
        flip: feature.flip,
        points: feature.points ?? (sketch ? defaultHolePoints(sketch) : []),
        params: { ...DEFAULT_HOLE_SETTINGS.params, ...feature.params },
      },
      editId: feature.id,
      picking: false,
    });
  };

  const close = () => {
    setDialog(null);
    cancelEdit();
  };

  const confirm = () => {
    if (!dialog?.sketchId || !dialog.targetId || !dialog.settings.points?.length) return;
    if (dialog.editId) {
      setDoc(updateHole(doc, dialog.editId, dialog.sketchId, dialog.targetId, dialog.settings));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    const { doc: created } = addHole(doc, dialog.sketchId, dialog.targetId, dialog.settings);
    setDoc(created);
    selectFeature(null);
    close();
  };

  const setSketch = (id: string) =>
    setDialog((d) => {
      if (!d) return d;
      const sk = doc.features.find((f): f is SketchFeature => f.id === id && f.type === "sketch");
      return {
        ...d,
        sketchId: id,
        targetId: sketchBody(doc, id) ?? d.targetId,
        settings: { ...d.settings, points: sk ? defaultHolePoints(sk) : [] },
      };
    });
  const pickPoint = (sketchId: string, ref: HolePointRef) =>
    setDialog((d) => {
      if (!d) return d;
      if (d.sketchId !== sketchId)
        return {
          ...d,
          sketchId,
          targetId: sketchBody(doc, sketchId) ?? d.targetId,
          settings: { ...d.settings, points: [ref] },
        };
      const pts = d.settings.points ?? [];
      const next = pts.some((p) => sameHolePoint(p, ref)) ? pts.filter((p) => !sameHolePoint(p, ref)) : [...pts, ref];
      return { ...d, settings: { ...d.settings, points: next } };
    });
  const clearPoints = () =>
    setDialog((d) => (d ? { ...d, picking: true, settings: { ...d.settings, points: [] } } : d));
  const setPicking = (on: boolean) => setDialog((d) => (d ? { ...d, picking: on } : d));
  const setTarget = (id: string) => setDialog((d) => (d ? { ...d, targetId: id } : d));
  const update = (patch: Partial<HoleSettings>) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  const updateParam = (name: keyof HoleSettings["params"], value: string) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, params: { ...d.settings.params, [name]: value } } } : d));

  // Ghost of a NEW hole: the drill tools only (previewTool), drawn as a cut.
  const sketchId = dialog?.sketchId;
  const targetId = dialog?.targetId;
  const settings = dialog?.settings;
  const creating = !!dialog && !dialog.editId;
  useEffect(() => {
    if (!creating || !sketchId || !targetId || !settings) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: previewDoc, id } = addHole(doc, sketchId, targetId, settings);
      const resolved = resolveDocument(previewDoc);
      const err = resolved.errors[id];
      if (err) {
        setPreview(null);
        setPreviewError(err);
        return;
      }
      const features = resolved.features.map((f) =>
        f.id === id && f.type === "hole" ? { ...f, previewTool: true } : f,
      );
      kernel
        .regenerate(features)
        .then(({ results }) => {
          if (cancelled) return;
          const hit = results.find((r) => r.id === id);
          if (hit?.ok) {
            setPreview(hit.mesh);
            setPreviewError(null);
          } else {
            setPreview(null);
            setPreviewError(hit && !hit.ok ? hit.error : "Preview failed.");
          }
        })
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(String(e?.message ?? e));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [creating, sketchId, targetId, settings, doc, ready, kernelRef]);

  // An EDIT applies live to the real document.
  const editId = dialog?.editId;
  useEffect(() => {
    if (!editId || !sketchId || !targetId || !settings) return;
    if (!shouldLiveApply(JSON.stringify({ e: editId, sketchId, targetId, settings }))) return;
    setDoc((prev) => updateHole(prev, editId, sketchId, targetId, settings), `edit:${editId}`);
  }, [editId, sketchId, targetId, settings, setDoc, shouldLiveApply]);

  return {
    dialog,
    preview,
    previewError,
    open,
    edit,
    close,
    confirm,
    setSketch,
    pickPoint,
    clearPoints,
    setPicking,
    setTarget,
    update,
    updateParam,
  };
}
