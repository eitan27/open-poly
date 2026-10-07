// The Revolve dialog's whole state machine, lifted out of App.tsx.
//
// What makes this worth its own file is not the handlers — those were already
// small — but the two effects. One debounces a throwaway kernel regenerate to
// show a translucent ghost of the result; the other live-applies an in-place edit
// to the real document as you type. Both read a handful of the dialog's fields
// and nothing else, which is invisible when they sit among sixty other hook
// blocks and obvious here: the live-edit effect can now list honest dependencies
// instead of carrying an `exhaustive-deps` disable.
//
// The dependency object is wide (thirteen entries) and that is the point of
// writing it down rather than a reason to hide it. Every one of those was already
// an implicit coupling between the revolve dialog and the rest of App.tsx; the
// list is the first honest statement of what this dialog actually needs.
import { useEffect, useState } from "react";
import { addRevolve, resolveDocument, setSuppressed, updateRevolve } from "../document/document";
import type { Document, Feature, RevolveAxis, RevolveProfile } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import type { ShapeMeshPayload } from "../kernel/types";
import type { RevolveMode } from "../ui/RevolveDialog";

/** How long to sit still before spending a kernel regenerate on the ghost, so
 *  typing in the angle field stays responsive. */
const PREVIEW_DEBOUNCE_MS = 120;

export interface RevolveDialogState {
  profile: RevolveProfile | null;
  axis: RevolveAxis | null;
  /** Which slot the next SELECTION click fills. The axis is armed through
   *  picking mode instead, so it is never named here. */
  armed: "profile" | "axis" | null;
  mode: RevolveMode;
  degrees: string;
  symmetric: boolean;
  x: number;
  y: number;
  editId?: string;
}

/** Full revolve is 360°, where symmetric is meaningless — so the two always
 *  resolve together, and every caller that needs one needs the other. Module
 *  scope, and pure, so the effects below can depend on honest values instead of
 *  on a closure recreated every render. */
function resolveAngle(d: Pick<RevolveDialogState, "mode" | "degrees" | "symmetric">) {
  return { angle: d.mode === "full" ? "360" : d.degrees, symmetric: d.mode === "angle" && d.symmetric };
}

export interface RevolveDialogDeps {
  doc: Document;
  setDoc: (next: Document | ((prev: Document) => Document), coalesceKey?: string) => void;
  /** Whether the kernel is up; the ghost cannot be built before it is. */
  ready: boolean;
  kernelRef: React.RefObject<KernelClient | null>;
  /** True while a viewport pick is armed, and what it is for — the axis slot
   *  reads these rather than owning its own flag. */
  picking: boolean;
  pickPurpose: string;
  setPicking: (on: boolean) => void;
  setPickPurpose: (purpose: "sketch" | "revolveAxis") => void;
  beginEdit: (feature: Feature) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  /** Guards the live-edit effect against re-applying an unchanged edit. Must be
   *  referentially stable, or the effect runs on every render. */
  shouldLiveApply: (signature: string) => boolean;
  selectFeature: (id: string | null) => void;
}

/** Where the panel should appear, in canvas pixels. Computed by the caller: "put
 *  it over the profile the user just clicked" needs the camera, which is the app
 *  shell's business, not this dialog's. */
export interface PanelAt {
  x: number;
  y: number;
}

export interface RevolveDialogApi {
  dialog: RevolveDialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<RevolveDialogState | null>>;
  /** The translucent ghost of the would-be result, and why it could not be built. */
  preview: ShapeMeshPayload | null;
  previewError: string | null;
  /** Open for a new revolve, prefilled from a pre-selected profile + axis if the
   *  selection happens to hold a valid pair. */
  open: (prefill: { profile: RevolveProfile; axis: RevolveAxis } | null, at: PanelAt) => void;
  /** Re-open against an existing feature, to edit in place. */
  edit: (feature: Extract<Feature, { type: "revolve" }>, at: PanelAt) => void;
  close: () => void;
  confirm: () => void;
  armProfile: (clear?: boolean) => void;
  armAxis: () => void;
}

export function useRevolveDialog(deps: RevolveDialogDeps): RevolveDialogApi {
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

  const [dialog, setDialog] = useState<RevolveDialogState | null>(null);
  const [preview, setPreview] = useState<ShapeMeshPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /** Drop an in-flight axis pick. Both closing the dialog and arming the profile
   *  need this: the two slots read different click streams (profile through the
   *  selection raycaster, axis through picking mode), so without it both stay
   *  live and the next click still lands on the axis. */
  const cancelAxisPick = () => {
    if (picking && pickPurpose === "revolveAxis") {
      setPicking(false);
      setPickPurpose("sketch");
    }
  };

  const armProfile = (clear = false) => {
    cancelAxisPick();
    setDialog((d) => (d ? { ...d, ...(clear ? { profile: null } : {}), armed: "profile" } : d));
  };

  /** Arm the AXIS slot. Shared by the dialog's own button and by the auto-advance
   *  that follows a profile pick, so a two-slot tool costs two viewport clicks
   *  rather than click-button-click-button-click. */
  const armAxis = () => {
    setDialog((d) => (d ? { ...d, armed: null } : d));
    setPickPurpose("revolveAxis");
    setPicking(true);
  };

  const open = (prefill: { profile: RevolveProfile; axis: RevolveAxis } | null, at: PanelAt) => {
    setDialog({
      profile: prefill?.profile ?? null,
      axis: prefill?.axis ?? null,
      armed: prefill ? null : "profile",
      mode: "full",
      degrees: "90",
      symmetric: false,
      x: at.x,
      y: at.y,
    });
  };

  const edit = (feature: Extract<Feature, { type: "revolve" }>, at: PanelAt) => {
    beginEdit(feature);
    selectFeature(feature.id);
    const full = feature.angle === "360";
    setDialog({
      profile: feature.profile,
      axis: feature.axis,
      armed: null,
      mode: full ? "full" : "angle",
      degrees: full ? "90" : feature.angle,
      symmetric: feature.symmetric,
      x: at.x,
      y: at.y,
      editId: feature.id,
    });
  };

  const close = () => {
    setDialog(null);
    cancelAxisPick();
    cancelEdit();
  };

  const confirm = () => {
    if (!dialog?.profile || !dialog.axis) return;
    const { angle, symmetric } = resolveAngle(dialog);
    const prof = dialog.profile;
    // Hide the originating sketch once it's been consumed (like extrude does). A
    // body-face profile has no sketch to hide — the face stays part of its body.
    const hideSource = (d: Document) => (prof.kind === "sketchRegion" ? setSuppressed(d, prof.sketchId, true) : d);
    if (dialog.editId) {
      setDoc(hideSource(updateRevolve(doc, dialog.editId, prof, dialog.axis, angle, symmetric)));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    const { doc: created } = addRevolve(doc, prof, dialog.axis, angle, symmetric);
    setDoc(hideSource(created));
    selectFeature(null);
    close();
  };

  // Live ghost preview: once a profile + axis are armed, build a throwaway doc
  // with that revolve (mirrors `confirm`, minus the setDoc / hide-sketch),
  // regenerate just the new body, and show it translucent. Debounced so dragging
  // the angle field stays responsive.
  useEffect(() => {
    // Editing shows the committed revolve live, so a create-only ghost on top of
    // it would double the body.
    if (!dialog || dialog.editId || !dialog.profile || !dialog.axis) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    const { profile, axis } = dialog;
    const { angle, symmetric } = resolveAngle(dialog);
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: previewDoc, id } = addRevolve(doc, profile, axis, angle, symmetric);
      const previewResolved = resolveDocument(previewDoc);
      const resolveErr = previewResolved.errors[id];
      if (resolveErr) {
        setPreview(null);
        setPreviewError(resolveErr);
        return;
      }
      kernel
        .regenerate(previewResolved.features)
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
        .catch((err) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(String(err?.message ?? err));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dialog, doc, ready, kernelRef]);

  // Live-preview a revolve EDIT by applying it to the real document as the fields
  // change. Pulled out field by field rather than depending on `dialog` whole:
  // the dialog also carries `x`/`y` and `armed`, and re-applying the edit when
  // the panel is dragged or a slot is armed is both wasted work and a spurious
  // undo entry. That is what the `exhaustive-deps` disable here used to hide.
  const editId = dialog?.editId;
  const editProfile = dialog?.profile;
  const editAxis = dialog?.axis;
  const editMode = dialog?.mode;
  const editDegrees = dialog?.degrees;
  const editSymmetric = dialog?.symmetric;
  useEffect(() => {
    if (!editId || !editProfile || !editAxis || !editMode) return;
    const { angle, symmetric } = resolveAngle({
      mode: editMode,
      degrees: editDegrees ?? "90",
      symmetric: !!editSymmetric,
    });
    if (!shouldLiveApply(JSON.stringify({ e: editId, p: editProfile, a: editAxis, angle, symmetric }))) return;
    setDoc((prev) => updateRevolve(prev, editId, editProfile, editAxis, angle, symmetric), `edit:${editId}`);
  }, [editId, editProfile, editAxis, editMode, editDegrees, editSymmetric, setDoc, shouldLiveApply]);

  return {
    dialog,
    setDialog,
    preview,
    previewError,
    open,
    edit,
    close,
    confirm,
    armProfile,
    armAxis,
  };
}
