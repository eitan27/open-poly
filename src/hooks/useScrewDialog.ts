// The Screw dialog's state machine, after useGearDialog: it opens with a
// placement already (the selected or newest Hole, else the Top plane's origin)
// so the ghost shows at once; its Locations slot then takes viewport picks
// (App's onScrewPlacementPick) the way a Hole's Targets do. A NEW screw is
// ghosted by a debounced throwaway regenerate, an EDIT applies live.
import { useEffect, useState } from "react";
import { addScrew, resolveDocument, updateScrew } from "../document/document";
import { DEFAULT_SCREW_SETTINGS, screwSize, type ScrewSettings } from "../document/screw";
import type { SketchPlaneRef } from "../document/planes";
import type { Document, Feature, HolePointRef, ScrewFeature } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import type { ShapeMeshPayload } from "../kernel/types";

const PREVIEW_DEBOUNCE_MS = 120;

export interface ScrewDialogState {
  settings: ScrewSettings;
  /** The Locations slot is listening: viewport picks add (or remove) spots. */
  locating: boolean;
  editId?: string;
}

/** Where the screws go, as the slot edits it. */
export type ScrewLocations = Pick<ScrewSettings, "holeId" | "points">;

export interface ScrewDialogDeps {
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

export function useScrewDialog(deps: ScrewDialogDeps) {
  const { doc, setDoc, ready, kernelRef, beginEdit, commitEdit, cancelEdit, shouldLiveApply, selectFeature } = deps;
  const [dialog, setDialog] = useState<ScrewDialogState | null>(null);
  const [preview, setPreview] = useState<ShapeMeshPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /** `holeId`: a hole to put the screws in (the selected one, else the
   *  newest); `plane`: a selected plane, to put one on its origin. */
  const open = (holeId: string | null, plane: SketchPlaneRef | null) => {
    const holes = doc.features.filter((f) => f.type === "hole");
    const hole = holeId ?? (plane ? null : (holes.at(-1)?.id ?? null));
    setDialog({
      locating: false,
      settings: {
        ...DEFAULT_SCREW_SETTINGS,
        ...(hole ? { holeId: hole } : {}),
        ...(plane ? { points: [{ uv: [0, 0], plane }] } : {}),
        params: { ...DEFAULT_SCREW_SETTINGS.params },
      },
    });
  };

  const edit = (f: ScrewFeature) => {
    beginEdit(f);
    selectFeature(f.id);
    setDialog({
      locating: false,
      settings: {
        head: f.head,
        ...(f.thread ? { thread: f.thread } : {}),
        size: screwSize(doc, f),
        flip: f.flip,
        ...(f.holeId ? { holeId: f.holeId } : {}),
        ...(f.points?.length ? { points: f.points } : {}),
        params: { ...DEFAULT_SCREW_SETTINGS.params, ...f.params },
      },
      editId: f.id,
    });
  };

  const close = () => {
    setDialog(null);
    cancelEdit();
  };

  const confirm = () => {
    if (!dialog) return;
    if (dialog.editId) {
      setDoc(updateScrew(doc, dialog.editId, dialog.settings));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    setDoc(addScrew(doc, dialog.settings).doc);
    selectFeature(null);
    close();
  };

  /** The slot's button: start (or stop) listening for locations. */
  const armLocations = (on: boolean) => setDialog((d) => (d ? { ...d, locating: on } : d));
  /** The slot's ✕: back to the default (Top's origin), listening. */
  const clearLocations = () =>
    setDialog((d) => {
      if (!d) return d;
      const { holeId: _h, points: _p, ...settings } = d.settings;
      return { ...d, settings, locating: true };
    });
  /** A pick's result: the hole and spots the screws now go in. */
  const setLocations = (loc: ScrewLocations) =>
    setDialog((d) => {
      if (!d) return d;
      const { holeId: _h, points: _p, ...settings } = d.settings;
      return {
        ...d,
        settings: {
          ...settings,
          ...(loc.holeId ? { holeId: loc.holeId } : {}),
          ...(loc.points?.length ? { points: loc.points as HolePointRef[] } : {}),
        },
      };
    });
  const update = (patch: Partial<ScrewSettings>) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  const updateParam = (name: keyof ScrewSettings["params"], value: string) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, params: { ...d.settings.params, [name]: value } } } : d));

  const settings = dialog?.settings;
  const creating = !!dialog && !dialog.editId;
  useEffect(() => {
    if (!creating || !settings) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: previewDoc, id } = addScrew(doc, settings);
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
  }, [creating, settings, doc, ready, kernelRef]);

  const editId = dialog?.editId;
  useEffect(() => {
    if (!editId || !settings) return;
    if (!shouldLiveApply(JSON.stringify({ e: editId, settings }))) return;
    setDoc((prev) => updateScrew(prev, editId, settings), `edit:${editId}`);
  }, [editId, settings, setDoc, shouldLiveApply]);

  return {
    dialog,
    preview,
    previewError,
    open,
    edit,
    close,
    confirm,
    armLocations,
    clearLocations,
    setLocations,
    update,
    updateParam,
  };
}
