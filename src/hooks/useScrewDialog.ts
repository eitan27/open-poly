// The Screw dialog's state machine, after useGearDialog: it opens with a
// placement already (the selected or newest Hole, else the Top plane's origin)
// so the ghost shows at once; its Locations slot then takes viewport picks
// (App's onScrewPlacementPick) the way a Hole's Targets do. A NEW screw is
// ghosted by a debounced throwaway regenerate, an EDIT applies live.
import { useEffect, useRef, useState } from "react";
import { addScrew, resolveDocument, updateScrew } from "../document/document";
import { DEFAULT_SCREW_SETTINGS, screwSize, type ScrewSettings } from "../document/screw";
import type { SketchPlaneRef } from "../document/planes";
import type { Document, Feature, ScrewFeature } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import type { ResolvedFrame, ShapeMeshPayload } from "../kernel/types";
import { SCREW_TEMPLATE_FRAME, screwCopies } from "./ghostMove";

const PREVIEW_DEBOUNCE_MS = 120;
/** The ghost's one screw, built under this id whatever the draft's is. */
const GHOST_ID = "screw-ghost";

export interface ScrewDialogState {
  settings: ScrewSettings;
  /** The Locations slot is listening: viewport picks add (or remove) spots. */
  locating: boolean;
  editId?: string;
}

/** Where the screws go, as the slot edits it. */
export type ScrewLocations = Pick<ScrewSettings, "holeId" | "skipHoles" | "points">;

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
    // Listening from the start, as a new Hole's Targets: the first pick adds
    // to the Hole or plane it opened on. Editing opens with it off, as Hole's.
    setDialog({
      locating: true,
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
      const { holeId: _h, skipHoles: _k, points: _p, ...settings } = d.settings;
      return {
        ...d,
        settings: {
          ...settings,
          ...(loc.holeId ? { holeId: loc.holeId } : {}),
          ...(loc.holeId && loc.skipHoles?.length ? { skipHoles: loc.skipHoles } : {}),
          ...(loc.points?.length ? { points: loc.points } : {}),
        },
      };
    });
  /** A row's ✕: the screw in hole `i` of its Hole (of `count`) — the Hole
   *  itself once none of its holes has one — or picked spot `i`. */
  const removeLocation = (row: { hole: number; count: number } | { point: number }) => {
    const s = dialog?.settings;
    if (!s) return;
    if ("point" in row) return setLocations({ ...s, points: (s.points ?? []).filter((_, i) => i !== row.point) });
    const skip = [...new Set([...(s.skipHoles ?? []), row.hole])].sort((a, b) => a - b);
    setLocations(
      skip.length >= row.count ? { points: s.points } : { holeId: s.holeId, skipHoles: skip, points: s.points },
    );
  };
  const update = (patch: Partial<ScrewSettings>) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));
  const updateParam = (name: keyof ScrewSettings["params"], value: string) =>
    setDialog((d) => (d ? { ...d, settings: { ...d.settings, params: { ...d.settings.params, [name]: value } } } : d));

  const settings = dialog?.settings;
  const creating = !!dialog && !dialog.editId;
  // The ghost: ONE screw of this shape, built where it doesn't depend on the
  // locations (SCREW_TEMPLATE_FRAME), copied to every seat here in JS. A new
  // location — a pick, a removed spot, Flip — just copies it again, at once;
  // only a change of shape (head, size, length, thread) asks the kernel, and
  // the kernel keeps each shape it has built too.
  const templateRef = useRef<{ sig: string; mesh: ShapeMeshPayload } | null>(null);
  /** The shape being built, so a pick while it builds waits for it rather
   *  than dropping it and asking again. */
  const pendingRef = useRef<{ sig: string; mesh: Promise<ShapeMeshPayload> } | null>(null);
  /** Where the ghost's screws are now, in part order. */
  const seatsRef = useRef<ResolvedFrame[]>([]);
  useEffect(() => {
    if (!creating || !settings) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    const { doc: previewDoc, id } = addScrew(doc, settings);
    const resolved = resolveDocument(previewDoc);
    const err = resolved.errors[id];
    const rf = resolved.features.find((f) => f.id === id);
    if (err || rf?.type !== "screw") {
      setPreview(null);
      setPreviewError(err ?? "Preview failed.");
      return;
    }
    const seats = rf.frames ?? [rf.frame];
    seatsRef.current = seats;
    // Under a fixed id: the draft's is new every time, and would make every
    // template look different.
    const template = {
      ...rf,
      id: GHOST_ID,
      frame: SCREW_TEMPLATE_FRAME,
      centers: [[0, 0]] as [number, number][],
      frames: undefined,
    };
    const sig = JSON.stringify(template);
    const have = templateRef.current;
    if (have?.sig === sig) {
      setPreview(screwCopies(have.mesh, seats));
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const show = (mesh: Promise<ShapeMeshPayload>) =>
      mesh.then(
        (m) => {
          if (cancelled) return;
          setPreview(screwCopies(m, seats));
          setPreviewError(null);
        },
        (e) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(String(e?.message ?? e));
        },
      );
    const pending = pendingRef.current;
    if (pending?.sig === sig) {
      show(pending.mesh);
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(() => {
      const mesh = kernel.regenerate(resolved.features.map((f) => (f.id === id ? template : f))).then(({ results }) => {
        const hit = results.find((r) => r.id === GHOST_ID);
        if (!hit?.ok) throw new Error(hit && !hit.ok ? hit.error : "Preview failed.");
        // Kept even if the dialog has moved on: a later pick of the same
        // shape copies it.
        templateRef.current = { sig, mesh: hit.mesh };
        return hit.mesh;
      });
      pendingRef.current = { sig, mesh };
      mesh
        .finally(() => {
          if (pendingRef.current?.mesh === mesh) pendingRef.current = null;
        })
        .catch(() => {});
      show(mesh);
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
    removeLocation,
    /** The ghost's screw `i` alone (a row hovered), once its shape is built. */
    ghostScrewAt: (i: number): ShapeMeshPayload | null => {
      const t = templateRef.current;
      const seat = seatsRef.current[i];
      return t && seat ? screwCopies(t.mesh, [seat]) : null;
    },
    update,
    updateParam,
  };
}
