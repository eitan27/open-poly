// The Thread dialog's state machine, after useHoleDialog: a debounced
// throwaway regenerate ghosts a NEW thread (the rod, or the cavity drawn as a
// cut), and an EDIT applies live to the real document.
import { useEffect, useState } from "react";
import { addThread, resolveDocument, updateThread } from "../document/document";
import { DEFAULT_THREAD_SETTINGS, type ThreadSettings } from "../document/threadFeature";
import { holeSketches } from "./useHoleDialog";
import type { Document, Feature, ThreadFeature } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import type { ShapeMeshPayload } from "../kernel/types";

const PREVIEW_DEBOUNCE_MS = 120;

export interface ThreadDialogState {
  sketchId: string | null;
  targetId: string | null;
  settings: ThreadSettings;
  editId?: string;
}

export interface ThreadDialogDeps {
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

export interface ThreadDialogApi {
  dialog: ThreadDialogState | null;
  preview: ShapeMeshPayload | null;
  previewError: string | null;
  /** Open on a sketch (the selected one, else the newest with points) and a
   *  body (the one the sketch sits on, else `fallbackTarget`). */
  open: (sketchId: string | null, fallbackTarget: string | null) => void;
  edit: (feature: ThreadFeature) => void;
  close: () => void;
  confirm: () => void;
  setSketch: (id: string) => void;
  setTarget: (id: string) => void;
  update: (patch: Partial<ThreadSettings>) => void;
  updateParam: (name: keyof ThreadSettings["params"], value: string) => void;
}

/** The sketch every thread needs: any with a point or a circle, like a hole's. */
export { holeSketches as threadSketches };

/** The body a sketch sits on, when it was drawn on a body face. */
function sketchBody(doc: Document, sketchId: string | null): string | null {
  const s = doc.features.find((f) => f.id === sketchId);
  return s?.type === "sketch" && s.plane.kind === "face" ? s.plane.featureId : null;
}

export function useThreadDialog(deps: ThreadDialogDeps): ThreadDialogApi {
  const { doc, setDoc, ready, kernelRef, beginEdit, commitEdit, cancelEdit, shouldLiveApply, selectFeature } = deps;
  const [dialog, setDialog] = useState<ThreadDialogState | null>(null);
  const [preview, setPreview] = useState<ShapeMeshPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const open = (sketchId: string | null, fallbackTarget: string | null) => {
    const sketches = holeSketches(doc);
    const sk = sketchId && sketches.some((s) => s.id === sketchId) ? sketchId : (sketches.at(-1)?.id ?? null);
    setDialog({
      sketchId: sk,
      targetId: sketchBody(doc, sk) ?? fallbackTarget,
      settings: { ...DEFAULT_THREAD_SETTINGS, params: { ...DEFAULT_THREAD_SETTINGS.params } },
    });
  };

  const edit = (feature: ThreadFeature) => {
    beginEdit(feature);
    selectFeature(feature.id);
    setDialog({
      sketchId: feature.sketchId,
      targetId: feature.targetId ?? null,
      settings: {
        side: feature.side,
        profile: feature.profile,
        leftHand: feature.leftHand,
        leadIn: feature.leadIn,
        flip: feature.flip,
        params: { ...DEFAULT_THREAD_SETTINGS.params, ...feature.params },
      },
      editId: feature.id,
    });
  };

  const close = () => {
    setDialog(null);
    cancelEdit();
  };

  const confirm = () => {
    if (!dialog?.sketchId || (dialog.settings.side === "internal" && !dialog.targetId)) return;
    if (dialog.editId) {
      setDoc(updateThread(doc, dialog.editId, dialog.sketchId, dialog.targetId ?? undefined, dialog.settings));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    const { doc: created } = addThread(doc, dialog.sketchId, dialog.targetId ?? undefined, dialog.settings);
    setDoc(created);
    selectFeature(null);
    close();
  };

  const setSketch = (id: string) =>
    setDialog((d) => (d ? { ...d, sketchId: id, targetId: sketchBody(doc, id) ?? d.targetId } : d));
  const setTarget = (id: string) => setDialog((d) => (d ? { ...d, targetId: id } : d));
  const update = (patch: Partial<ThreadSettings>) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  const updateParam = (name: keyof ThreadSettings["params"], value: string) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, params: { ...d.settings.params, [name]: value } } } : d));

  // Ghost of a NEW thread: the rod, or (internal) the cavity alone, drawn as a cut.
  const sketchId = dialog?.sketchId;
  const targetId = dialog?.targetId;
  const settings = dialog?.settings;
  const creating = !!dialog && !dialog.editId;
  useEffect(() => {
    if (!creating || !sketchId || !settings || (settings.side === "internal" && !targetId)) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: previewDoc, id } = addThread(doc, sketchId, targetId ?? undefined, settings);
      const resolved = resolveDocument(previewDoc);
      const err = resolved.errors[id];
      if (err) {
        setPreview(null);
        setPreviewError(err);
        return;
      }
      const features = resolved.features.map((f) =>
        f.id === id && f.type === "thread" ? { ...f, previewTool: true } : f,
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
    if (!editId || !sketchId || !settings) return;
    if (!shouldLiveApply(JSON.stringify({ e: editId, sketchId, targetId, settings }))) return;
    setDoc((prev) => updateThread(prev, editId, sketchId, targetId ?? undefined, settings), `edit:${editId}`);
  }, [editId, sketchId, targetId, settings, setDoc, shouldLiveApply]);

  return { dialog, preview, previewError, open, edit, close, confirm, setSketch, setTarget, update, updateParam };
}
