// The Thread dialog's state machine, after useHoleDialog: a debounced
// throwaway regenerate ghosts a NEW thread (its part as it will be, the real
// cut run in the kernel — so a failing one shows before Create, and Create
// reuses it), and an EDIT applies live to the real document.
//
// Two pick slots feed it: the round FACE to cut the thread on (a new dialog
// opens listening for it), and MATCH, a face whose thread to copy — a Thread,
// a tapped Hole, a Screw, or a plain rod or hole's size.
import { useEffect, useState } from "react";
import { addThread, resolveDocument, updateThread } from "../document/document";
import { evaluateExpression } from "../document/expression";
import {
  DEFAULT_THREAD_SETTINGS,
  suggestThread,
  type ThreadMatch,
  type ThreadSettings,
  type ThreadSide,
} from "../document/threadFeature";
import type { Document, Feature, ThreadFaceRef, ThreadFeature } from "../document/types";
import type { RoundWall } from "../geom/roundWall";
import type { KernelClient } from "../kernel/KernelClient";
import type { ShapeMeshPayload } from "../kernel/types";

const PREVIEW_DEBOUNCE_MS = 120;

export type ThreadSlot = "face" | "match";

export interface ThreadDialogState {
  face: ThreadFaceRef | null;
  /** What the face is, as read off its tessellation when it was picked. */
  side: ThreadSide;
  /** The face's diameter, when it was read (not on an edit, whose face the
   *  thread has already been cut into). */
  faceDiameter: number | null;
  /** The slot the next viewport click fills. */
  slot: ThreadSlot | null;
  /** What the settings were last matched to, for the dialog to say. */
  matched: string | null;
  /** The diameter last suggested for the face — while the field still holds
   *  it, a change of profile (or, in a hole, of pitch) suggests again. */
  suggested: string | null;
  settings: ThreadSettings;
  editId?: string;
}

export interface ThreadDialogDeps {
  doc: Document;
  setDoc: (next: Document | ((prev: Document) => Document), coalesceKey?: string) => void;
  ready: boolean;
  kernelRef: React.RefObject<KernelClient | null>;
  scope: Record<string, number>;
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
  /** Open listening for the face — or on `face` when one was preselected. */
  open: (face?: { ref: ThreadFaceRef; wall: RoundWall }) => void;
  edit: (feature: ThreadFeature) => void;
  close: () => void;
  confirm: () => void;
  arm: (slot: ThreadSlot | null) => void;
  /** The face slot filled: a round face, read by its tessellation. */
  setFace: (ref: ThreadFaceRef, wall: RoundWall) => void;
  applyMatch: (match: ThreadMatch) => void;
  clearMatch: () => void;
  update: (patch: Partial<ThreadSettings>) => void;
  updateParam: (name: keyof ThreadSettings["params"], value: string) => void;
}

const freshSettings = (): ThreadSettings => ({
  ...DEFAULT_THREAD_SETTINGS,
  params: { ...DEFAULT_THREAD_SETTINGS.params },
});

export function useThreadDialog(deps: ThreadDialogDeps): ThreadDialogApi {
  const { doc, setDoc, ready, kernelRef, scope, beginEdit, commitEdit, cancelEdit, shouldLiveApply, selectFeature } =
    deps;
  const [dialog, setDialog] = useState<ThreadDialogState | null>(null);
  const [preview, setPreview] = useState<ShapeMeshPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /** The face filled, and — unless the size was matched to something — the
   *  thread it's ready for. */
  const withFace = (d: ThreadDialogState, ref: ThreadFaceRef, wall: RoundWall): ThreadDialogState => {
    const side: ThreadSide = wall.internal ? "internal" : "external";
    const fresh = { ...d, face: ref, side, faceDiameter: 2 * wall.radius, slot: null };
    return d.matched ? fresh : suggested(fresh, true);
  };

  /** `d` with the size its face is ready for (see suggestThread) — and the
   *  pitch too when `pitch`, else the size follows the pitch typed. */
  const suggested = (d: ThreadDialogState, pitch: boolean): ThreadDialogState => {
    if (d.faceDiameter === null) return d;
    const wall = { radius: d.faceDiameter / 2, internal: d.side === "internal" };
    const s = suggestThread(wall, d.settings, scope, !pitch);
    const params = { ...d.settings.params, diameter: s.diameter, pitch: s.pitch };
    return { ...d, suggested: s.diameter, settings: { ...d.settings, params } };
  };

  /** Still showing the suggestion, so a change it depends on may redo it. */
  const following = (d: ThreadDialogState) =>
    !d.matched && d.faceDiameter !== null && d.settings.params.diameter === d.suggested;

  const open = (face?: { ref: ThreadFaceRef; wall: RoundWall }) => {
    const blank: ThreadDialogState = {
      face: null,
      side: "external",
      faceDiameter: null,
      slot: "face",
      matched: null,
      suggested: null,
      settings: freshSettings(),
    };
    setDialog(face ? withFace(blank, face.ref, face.wall) : blank);
  };

  const edit = (feature: ThreadFeature) => {
    beginEdit(feature);
    selectFeature(feature.id);
    setDialog({
      face: feature.face,
      side: feature.side,
      faceDiameter: null,
      slot: null,
      matched: null,
      suggested: null,
      settings: {
        profile: feature.profile,
        leftHand: feature.leftHand,
        leadIn: feature.leadIn,
        flip: feature.flip,
        fullLength: feature.fullLength,
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
    if (!dialog?.face) return;
    if (dialog.editId) {
      setDoc(updateThread(doc, dialog.editId, dialog.face, dialog.side, dialog.settings));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    const { doc: created } = addThread(doc, dialog.face, dialog.side, dialog.settings);
    setDoc(created);
    selectFeature(null);
    close();
  };

  const arm = (slot: ThreadSlot | null) => setDialog((d) => (d ? { ...d, slot } : d));
  const setFace = (ref: ThreadFaceRef, wall: RoundWall) => setDialog((d) => (d ? withFace(d, ref, wall) : d));
  const applyMatch = (match: ThreadMatch) =>
    setDialog((d) => {
      if (!d) return d;
      const params = { ...d.settings.params, ...match.patch.params };
      // A finer pitch than this part's clearance allows (an M3's 0.5 takes at
      // most 0.125): the most it does.
      try {
        const max = evaluateExpression(params.pitch, scope) / 4;
        if (evaluateExpression(params.clearance, scope) > max) params.clearance = String(Math.floor(max * 100) / 100);
      } catch {
        /* a field that doesn't evaluate shows its own error */
      }
      return { ...d, slot: null, matched: match.label, settings: { ...d.settings, ...match.patch, params } };
    });
  const clearMatch = () => setDialog((d) => (d ? { ...d, matched: null, slot: "match" } : d));
  const update = (patch: Partial<ThreadSettings>) =>
    setDialog((d) => {
      if (!d) return d;
      const next = { ...d, settings: { ...d.settings, ...patch } };
      return patch.profile && patch.profile !== d.settings.profile && following(d) ? suggested(next, true) : next;
    });
  const updateParam = (name: keyof ThreadSettings["params"], value: string) =>
    setDialog((d) => {
      if (!d) return d;
      const next = { ...d, settings: { ...d.settings, params: { ...d.settings.params, [name]: value } } };
      // In a hole the size follows the pitch: its minor diameter is the bore.
      return name === "pitch" && d.side === "internal" && d.settings.profile !== "iso" && following(d)
        ? suggested(next, false)
        : next;
    });

  // Ghost of a NEW thread: its part with the thread cut.
  const face = dialog?.face;
  const side = dialog?.side;
  const settings = dialog?.settings;
  const creating = !!dialog && !dialog.editId;
  useEffect(() => {
    if (!creating || !face || !side || !settings) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: previewDoc, id } = addThread(doc, face, side, settings);
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
  }, [creating, face, side, settings, doc, ready, kernelRef]);

  // An EDIT applies live to the real document.
  const editId = dialog?.editId;
  useEffect(() => {
    if (!editId || !face || !side || !settings) return;
    if (!shouldLiveApply(JSON.stringify({ e: editId, face, side, settings }))) return;
    setDoc((prev) => updateThread(prev, editId, face, side, settings), `edit:${editId}`);
  }, [editId, face, side, settings, setDoc, shouldLiveApply]);

  return {
    dialog,
    preview,
    previewError,
    open,
    edit,
    close,
    confirm,
    arm,
    setFace,
    applyMatch,
    clearMatch,
    update,
    updateParam,
  };
}
