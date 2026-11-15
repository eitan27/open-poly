// The Screw dialog's state machine, after useGearDialog: it opens with a
// placement already (the newest Hole, else the Top datum) so the ghost shows
// at once; a NEW screw is ghosted by a debounced throwaway regenerate, an EDIT
// applies live.
import { useEffect, useState } from "react";
import { addScrew, resolveDocument, updateScrew } from "../document/document";
import { DEFAULT_SCREW_SETTINGS, type ScrewSettings } from "../document/screw";
import type { SketchPlaneRef } from "../document/planes";
import type { Document, Feature, ScrewFeature } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import type { ShapeMeshPayload } from "../kernel/types";

const PREVIEW_DEBOUNCE_MS = 120;
const TOP: SketchPlaneRef = { kind: "datum", id: "plane-top" };

export interface ScrewDialogState {
  plane: SketchPlaneRef;
  defaultPlane: boolean;
  settings: ScrewSettings;
  editId?: string;
}

export interface ScrewDialogDeps {
  doc: Document;
  setDoc: (next: Document | ((prev: Document) => Document), coalesceKey?: string) => void;
  ready: boolean;
  kernelRef: React.RefObject<KernelClient | null>;
  picking: boolean;
  pickPurpose: string;
  setPicking: (on: boolean) => void;
  setPickPurpose: (purpose: "sketch" | "screwPlane") => void;
  beginEdit: (feature: Feature) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  shouldLiveApply: (signature: string) => boolean;
  selectFeature: (id: string | null) => void;
}

export function useScrewDialog(deps: ScrewDialogDeps) {
  const {
    doc,
    setDoc,
    ready,
    kernelRef,
    picking,
    pickPurpose,
    setPicking,
    setPickPurpose,
    beginEdit,
    commitEdit,
    cancelEdit,
    shouldLiveApply,
    selectFeature,
  } = deps;
  const [dialog, setDialog] = useState<ScrewDialogState | null>(null);
  const [preview, setPreview] = useState<ShapeMeshPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const cancelPlanePick = () => {
    if (picking && pickPurpose === "screwPlane") {
      setPicking(false);
      setPickPurpose("sketch");
    }
  };

  /** `holeId`: a hole to put the screws in (the selected one, else the newest). */
  const open = (holeId: string | null, plane: SketchPlaneRef | null) => {
    const holes = doc.features.filter((f) => f.type === "hole");
    const hole = holeId ?? (plane ? null : (holes.at(-1)?.id ?? null));
    setDialog({
      plane: plane ?? TOP,
      defaultPlane: !plane,
      settings: {
        ...DEFAULT_SCREW_SETTINGS,
        ...(hole ? { holeId: hole } : {}),
        params: { ...DEFAULT_SCREW_SETTINGS.params },
      },
    });
  };

  const edit = (f: ScrewFeature) => {
    beginEdit(f);
    selectFeature(f.id);
    setDialog({
      plane: f.plane,
      defaultPlane: false,
      settings: {
        head: f.head,
        ...(f.thread ? { thread: f.thread } : {}),
        size: f.size,
        flip: f.flip,
        ...(f.holeId ? { holeId: f.holeId } : {}),
        params: { ...DEFAULT_SCREW_SETTINGS.params, ...f.params },
      },
      editId: f.id,
    });
  };

  const close = () => {
    setDialog(null);
    cancelPlanePick();
    cancelEdit();
  };

  const confirm = () => {
    if (!dialog) return;
    if (dialog.editId) {
      setDoc(updateScrew(doc, dialog.editId, dialog.plane, dialog.settings));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    setDoc(addScrew(doc, dialog.plane, dialog.settings).doc);
    selectFeature(null);
    close();
  };

  const armPlane = () => {
    setPickPurpose("screwPlane");
    setPicking(true);
  };
  const pickPlane = (ref: SketchPlaneRef) => {
    setDialog((d) => (d ? { ...d, plane: ref, defaultPlane: false } : d));
    setPicking(false);
    setPickPurpose("sketch");
  };
  const update = (patch: Partial<ScrewSettings>) =>
    setDialog((d) => {
      if (!d) return d;
      const settings = { ...d.settings, ...patch };
      // `holeId: undefined` in a patch means "place on a plane": drop the key.
      if ("holeId" in patch && !patch.holeId) delete settings.holeId;
      return { ...d, settings };
    });
  const updateParam = (name: keyof ScrewSettings["params"], value: string) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, params: { ...d.settings.params, [name]: value } } } : d));

  const plane = dialog?.plane;
  const settings = dialog?.settings;
  const creating = !!dialog && !dialog.editId;
  useEffect(() => {
    if (!creating || !plane || !settings) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: previewDoc, id } = addScrew(doc, plane, settings);
      const resolved = resolveDocument(previewDoc);
      const err = resolved.errors[id];
      if (err) {
        setPreview(null);
        setPreviewError(err);
        return;
      }
      kernel
        .regenerate(resolved.features)
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
  }, [creating, plane, settings, doc, ready, kernelRef]);

  const editId = dialog?.editId;
  useEffect(() => {
    if (!editId || !plane || !settings) return;
    if (!shouldLiveApply(JSON.stringify({ e: editId, plane, settings }))) return;
    setDoc((prev) => updateScrew(prev, editId, plane, settings), `edit:${editId}`);
  }, [editId, plane, settings, setDoc, shouldLiveApply]);

  return { dialog, preview, previewError, open, edit, close, confirm, armPlane, pickPlane, update, updateParam };
}
