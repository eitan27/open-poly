// The Gear dialog's state machine, lifted out of App.tsx like useRevolveDialog.
//
// A gear needs only a plane, and the dialog opens WITH one — the pre-selected
// plane/face if there is one, else the Top datum — so the ghost is on screen
// the moment the tool is clicked and every field edit after that is visible.
// The Location slot shows that default as a choice; its ✕ starts listening,
// and the next click in the viewport — a plane (centred on its origin), a
// face, or a point to centre on, picked as a Hole's targets are (see App's
// onGearPlacementPick) — moves it there.
//
// Two effects, as in Revolve: a debounced throwaway regenerate for the ghost of
// a NEW gear, and a live apply of an EDIT to the real document (so the edited
// gear itself changes in place, no ghost on top of it).
import { useEffect, useState } from "react";
import { addGear, genId, resolveDocument, updateGear } from "../document/document";
import { DEFAULT_GEAR_SETTINGS, type GearSettings } from "../document/gear";
import type { SketchPlaneRef } from "../document/planes";
import type { Document, Feature, GearFeature, HolePointRef } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import type { ShapeMeshPayload } from "../kernel/types";

const PREVIEW_DEBOUNCE_MS = 120;

export interface GearDialogState {
  plane: SketchPlaneRef;
  /** True when the plane is the Top-datum default rather than a choice — the
   *  slot says so, so the default doesn't pass for a pick. */
  defaultPlane: boolean;
  settings: GearSettings;
  advanced: boolean;
  /** The Location slot is listening: the next viewport pick places the gear. */
  locating: boolean;
  editId?: string;
  /** A new gear's id, fixed for the dialog's life: the ghost and the gear
   *  Create adds share it, so Create reuses the ghost's build. */
  draftId: string;
}

export interface GearDialogDeps {
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

export interface GearDialogApi {
  dialog: GearDialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<GearDialogState | null>>;
  preview: ShapeMeshPayload | null;
  previewError: string | null;
  open: (plane: SketchPlaneRef | null) => void;
  edit: (feature: GearFeature) => void;
  close: () => void;
  confirm: () => void;
  /** Listen for a location (the slot's button, or its ✕). */
  armLocation: () => void;
  /** A location picked in the viewport: the plane the gear goes on, and the
   *  point to centre it on there (none: the plane's origin). */
  setLocation: (plane: SketchPlaneRef, center?: HolePointRef) => void;
  update: (patch: Partial<GearSettings>) => void;
  updateParam: (name: keyof GearSettings["params"], value: string) => void;
}

const TOP: SketchPlaneRef = { kind: "datum", id: "plane-top" };

export function useGearDialog(deps: GearDialogDeps): GearDialogApi {
  const { doc, setDoc, ready, kernelRef, beginEdit, commitEdit, cancelEdit, shouldLiveApply, selectFeature } = deps;

  const [dialog, setDialog] = useState<GearDialogState | null>(null);
  const [preview, setPreview] = useState<ShapeMeshPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const open = (plane: SketchPlaneRef | null) => {
    setDialog({
      plane: plane ?? TOP,
      defaultPlane: !plane,
      settings: { ...DEFAULT_GEAR_SETTINGS, params: { ...DEFAULT_GEAR_SETTINGS.params } },
      advanced: false,
      locating: false,
      draftId: genId(),
    });
  };

  const edit = (feature: GearFeature) => {
    beginEdit(feature);
    selectFeature(feature.id);
    setDialog({
      plane: feature.plane,
      defaultPlane: false,
      settings: {
        gearType: feature.gearType,
        sizeBy: feature.sizeBy,
        meshWith: feature.meshWith,
        placeBeside: feature.placeBeside,
        center: feature.center,
        bore: feature.bore,
        extent: feature.extent,
        flip: feature.flip,
        // Defaults first: a gear made before a param existed lacks it.
        params: { ...DEFAULT_GEAR_SETTINGS.params, ...feature.params },
      },
      advanced: false,
      locating: false,
      editId: feature.id,
      draftId: feature.id,
    });
  };

  const close = () => {
    setDialog(null);
    cancelEdit();
  };

  const confirm = () => {
    if (!dialog) return;
    if (dialog.editId) {
      setDoc(updateGear(doc, dialog.editId, dialog.plane, dialog.settings));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    const { doc: created } = addGear(doc, dialog.plane, dialog.settings, dialog.draftId);
    setDoc(created);
    selectFeature(null);
    close();
  };

  const armLocation = () => setDialog((d) => (d ? { ...d, locating: true } : d));

  // A picked location replaces any older Center X / Y offset (no longer in
  // the dialog), so the gear lands where it was put.
  const setLocation = (plane: SketchPlaneRef, center?: HolePointRef) =>
    setDialog((d) =>
      d
        ? {
            ...d,
            plane,
            defaultPlane: false,
            locating: false,
            settings: { ...d.settings, center, params: { ...d.settings.params, centerX: "0", centerY: "0" } },
          }
        : d,
    );

  const update = (patch: Partial<GearSettings>) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  const updateParam = (name: keyof GearSettings["params"], value: string) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, params: { ...d.settings.params, [name]: value } } } : d));

  // Ghost of a NEW gear: build a throwaway doc with it, regenerate, show the
  // gear's body translucent. Its own feature id never collides with a real
  // body, so every existing body keeps its colour.
  const plane = dialog?.plane;
  const settings = dialog?.settings;
  const creating = !!dialog && !dialog.editId;
  const draftId = dialog?.draftId;
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
      const { doc: previewDoc, id } = addGear(doc, plane, settings, draftId);
      const resolved = resolveDocument(previewDoc);
      const err = resolved.errors[id];
      if (err) {
        setPreview(null);
        setPreviewError(err);
        return;
      }
      // The settings make a gear again: drop the last one's error now, not
      // once the kernel is done (which, in a heavy part, is a while).
      setPreviewError(null);
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
  }, [creating, draftId, plane, settings, doc, ready, kernelRef]);

  // An EDIT applies live to the real document; the feature's own error (if
  // any) shows in the dialog via the document's resolve, not a ghost.
  const editId = dialog?.editId;
  useEffect(() => {
    if (!editId || !plane || !settings) return;
    if (!shouldLiveApply(JSON.stringify({ e: editId, plane, settings }))) return;
    setDoc((prev) => updateGear(prev, editId, plane, settings), `edit:${editId}`);
  }, [editId, plane, settings, setDoc, shouldLiveApply]);

  return {
    dialog,
    setDialog,
    preview,
    previewError,
    open,
    edit,
    close,
    confirm,
    armLocation,
    setLocation,
    update,
    updateParam,
  };
}
