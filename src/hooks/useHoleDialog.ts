// The Hole dialog's state machine, after useGearDialog: a debounced throwaway
// regenerate ghosts a NEW hole (only the drill tools, drawn as a cut), and an
// EDIT applies live to the real document.
//
// Where the holes go is picked in the viewport (see App's onPlacementPick):
// the first pick fixes the plane they start on — the face clicked, or a
// sketch's plane — and every pick toggles a point. Which parts they cut is
// every part they reach, unless parts are picked.
import { useEffect, useState } from "react";
import { addHole, resolveDocument, updateHole } from "../document/document";
import {
  DEFAULT_HOLE_SETTINGS,
  defaultHolePoints,
  holeCenters,
  sameHolePoint,
  type HoleSettings,
} from "../document/hole";
import type { SketchPlaneRef } from "../document/planes";
import type { Document, Feature, HoleFeature, HolePointRef, SketchFeature } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import type { ShapeMeshPayload } from "../kernel/types";

const PREVIEW_DEBOUNCE_MS = 120;

export type HoleSlot = "points" | "parts";

export interface HoleDialogState {
  settings: HoleSettings;
  /** An older hole's own sketch, kept so its sketch-relative points still
   *  resolve. Null for a new hole. */
  sketchId: string | null;
  /** An older hole's one target body, kept until parts are picked. */
  targetId: string | null;
  editId?: string;
  /** Which slot the next viewport click fills. */
  armed: HoleSlot | null;
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
  /** Open listening for points — on the selected sketch's points already, when
   *  a sketch with points is selected. */
  open: (sketchId: string | null) => void;
  edit: (feature: HoleFeature) => void;
  close: () => void;
  confirm: () => void;
  /** A point picked in the viewport. The first fixes the plane; a point
   *  already there is removed. */
  pickPoint: (plane: SketchPlaneRef, ref: HolePointRef) => void;
  /** Drop every point and the plane, and listen for a fresh first pick. */
  clearPoints: () => void;
  setArmed: (slot: HoleSlot | null) => void;
  /** A part clicked while the Parts slot listens: toggled in the scope. */
  togglePart: (id: string) => void;
  /** Back to every part the holes reach. */
  allParts: () => void;
  update: (patch: Partial<HoleSettings>) => void;
  updateParam: (name: keyof HoleSettings["params"], value: string) => void;
}

/** Sketches a hole can use: any with a point or a circle. */
export function holeSketches(doc: Document): SketchFeature[] {
  return doc.features.filter((f): f is SketchFeature => f.type === "sketch" && holeCenters(f).length > 0);
}

export function useHoleDialog(deps: HoleDialogDeps): HoleDialogApi {
  const { doc, setDoc, ready, kernelRef, beginEdit, commitEdit, cancelEdit, shouldLiveApply, selectFeature } = deps;
  const [dialog, setDialog] = useState<HoleDialogState | null>(null);
  const [preview, setPreview] = useState<ShapeMeshPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const open = (sketchId: string | null) => {
    const sketch = holeSketches(doc).find((s) => s.id === sketchId);
    setDialog({
      settings: {
        ...DEFAULT_HOLE_SETTINGS,
        // A selected sketch with points: start on them (the quick path).
        ...(sketch
          ? {
              plane: sketch.plane,
              points: defaultHolePoints(sketch).map((r) => ({ ...r, sketchId: sketch.id })),
            }
          : { points: [] }),
        params: { ...DEFAULT_HOLE_SETTINGS.params },
      },
      sketchId: null,
      targetId: null,
      armed: "points",
    });
  };

  const edit = (feature: HoleFeature) => {
    const sketch = doc.features.find((f): f is SketchFeature => f.id === feature.sketchId && f.type === "sketch");
    beginEdit(feature);
    selectFeature(feature.id);
    setDialog({
      settings: {
        holeType: feature.holeType,
        ...(feature.thread ? { thread: feature.thread } : {}),
        size: feature.size,
        fit: feature.fit,
        extent: feature.extent,
        flip: feature.flip,
        plane: feature.plane ?? sketch?.plane,
        points: feature.points ?? (sketch ? defaultHolePoints(sketch) : []),
        scope: feature.scope,
        params: { ...DEFAULT_HOLE_SETTINGS.params, ...feature.params },
      },
      sketchId: feature.sketchId ?? null,
      targetId: feature.targetId ?? null,
      editId: feature.id,
      armed: null,
    });
  };

  const close = () => {
    setDialog(null);
    cancelEdit();
  };

  const confirm = () => {
    if (!dialog?.settings.points?.length) return;
    const sk = dialog.sketchId ?? undefined;
    const target = dialog.targetId ?? undefined;
    if (dialog.editId) {
      setDoc(updateHole(doc, dialog.editId, sk, target, dialog.settings));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    const { doc: created } = addHole(doc, sk, target, dialog.settings);
    setDoc(created);
    selectFeature(null);
    close();
  };

  const pickPoint = (plane: SketchPlaneRef, ref: HolePointRef) =>
    setDialog((d) => {
      if (!d) return d;
      const pts = d.settings.points ?? [];
      const next = pts.some((p) => sameHolePoint(p, ref)) ? pts.filter((p) => !sameHolePoint(p, ref)) : [...pts, ref];
      return { ...d, settings: { ...d.settings, plane: d.settings.plane ?? plane, points: next } };
    });
  const clearPoints = () =>
    setDialog((d) =>
      d ? { ...d, armed: "points", sketchId: null, settings: { ...d.settings, plane: undefined, points: [] } } : d,
    );
  const setArmed = (slot: HoleSlot | null) => setDialog((d) => (d ? { ...d, armed: slot } : d));
  const togglePart = (id: string) =>
    setDialog((d) => {
      if (!d) return d;
      const cur = d.settings.scope ?? [];
      const scope = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      return { ...d, targetId: null, settings: { ...d.settings, scope: scope.length ? scope : undefined } };
    });
  const allParts = () =>
    setDialog((d) => (d ? { ...d, targetId: null, armed: null, settings: { ...d.settings, scope: undefined } } : d));
  const update = (patch: Partial<HoleSettings>) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  const updateParam = (name: keyof HoleSettings["params"], value: string) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, params: { ...d.settings.params, [name]: value } } } : d));

  // Ghost of a NEW hole: the drill tools only (previewTool), drawn as a cut.
  const sketchId = dialog?.sketchId ?? undefined;
  const targetId = dialog?.targetId ?? undefined;
  const settings = dialog?.settings;
  const creating = !!dialog && !dialog.editId;
  useEffect(() => {
    if (!creating || !settings?.points?.length) {
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
    if (!editId || !settings) return;
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
    pickPoint,
    clearPoints,
    setArmed,
    togglePart,
    allParts,
    update,
    updateParam,
  };
}
