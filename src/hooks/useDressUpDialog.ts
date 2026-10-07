// The Chamfer/Fillet dialog's state machine, lifted out of App.tsx.
//
// The largest of the five, because it is the only dialog with TWO kernel round
// trips: a debounced one behind every keystroke that both validates the size and
// carries back the ghost deltas, and an authoritative one on commit that runs even
// if the debounced one has not caught up. Keeping them side by side is the point —
// they build the same throwaway document through `applySpec`, so the dialog can
// never commit something its own preview refused.
//
// Shape follows the other hooks: one explicit dependency object, no
// `exhaustive-deps` disable.
import { useEffect, useMemo, useState } from "react";
import { addDressUp, resolveDocument, updateDressUp } from "../document/document";
import { dressUpTargetsFromPicks, mergeDressUpTargets, type DressUpTarget } from "../document/dressUpTarget";
import { mapDressUpKernelError, validateDressUpDialog } from "../document/dressUpValidation";
import type { Scope } from "../document/expression";
import type { Document, DressUpTargetSpec, Feature } from "../document/types";
import type { KernelClient } from "../kernel/KernelClient";
import { DRESSUP_DELTA_IDS, dressUpDeltaBase, type ShapeMeshPayload } from "../kernel/types";
import type { Selection } from "../selection/types";
import type { FeatureMesh } from "../viewport/types";

/** How long to sit still before spending a kernel regenerate, so each keystroke on
 *  a heavy body stays responsive. Longer than the revolve ghost's debounce: a
 *  dress-up regenerate carries the delta bodies too. */
const PREVIEW_DEBOUNCE_MS = 250;

/** Where to put a new dialog when there is no picked geometry to anchor it to. */
const DEFAULT_AT = { x: 240, y: 160 };

export interface DressUpDialogState {
  op: "chamfer" | "fillet";
  size: string;
  /** Chamfer-only: degrees from the reference face. Ignored for a fillet. */
  angle: string;
  /** Chamfer-only: which of the edge's two adjacent faces the reference is. */
  flip: boolean;
  /** The edges/faces this dialog dresses — its OWN accumulated picks, not the
   *  viewport selection, so an empty-space click can't wipe them. */
  picks: Selection[];
  /** True while the next viewport click adds to (or removes from) `picks`. Unlike
   *  a single-value slot, arming PERSISTS across picks: a five-edge fillet is five
   *  clicks, not click-button-click-button. */
  arming: boolean;
  /** What the feature being EDITED already dresses. */
  stored: DressUpTargetSpec[];
  x: number;
  y: number;
  editId?: string;
}

/** The material a dress-up adds and removes, ghosted over the model. */
export interface DressUpPreview {
  removed: ShapeMeshPayload[];
  added: ShapeMeshPayload[];
}

/** Only the fields that describe the geometry. `picks`, `stored`, `x` and `y` are
 *  deliberately absent: they shape the dialog, not the feature, so an effect that
 *  depends on these cannot be woken by a panel drag. */
type DressUpFields = Pick<DressUpDialogState, "op" | "size" | "angle" | "flip"> & { editId?: string };

/** The document-level spec the dialog's current inputs describe. */
function specOf(ts: DressUpTarget[], d: DressUpFields) {
  return {
    op: d.op,
    targets: ts.map((t) => ({
      targetId: t.targetId,
      edges: t.edges,
      edgeRefs: t.edgeRefs,
      faces: t.faces,
      faceRefs: t.faceRefs,
    })),
    size: d.size,
    // Angle/flip ride along for chamfers only — a fillet has no bevel to tilt.
    ...(d.op === "chamfer" ? { angle: d.angle, flip: d.flip } : {}),
  };
}

/** Add the dress-up, or (editing) update it in place. However many bodies it
 *  dresses, it is ONE feature: the dialog that made it reopens with all of them,
 *  and undo takes the whole thing back. Shared by the commit and the preview, so
 *  the dialog can never commit something its own preview refused. Module scope, and
 *  pure, so the effects below depend on values rather than on closures. */
function applyDressUpSpec(base: Document, ts: DressUpTarget[], d: DressUpFields) {
  const spec = specOf(ts, d);
  return d.editId
    ? { doc: updateDressUp(base, d.editId, spec), id: d.editId }
    : addDressUp(
        base,
        d.op,
        spec.targets,
        d.size,
        d.op === "chamfer" ? d.angle : undefined,
        d.op === "chamfer" && d.flip,
      );
}

export interface DressUpDialogDeps {
  doc: Document;
  setDoc: (next: Document | ((prev: Document) => Document), coalesceKey?: string) => void;
  scope: Scope;
  /** Rendered bodies — picks resolve to persistent edge/face names against these. */
  meshes: FeatureMesh[];
  ready: boolean;
  kernelRef: React.RefObject<KernelClient | null>;
  beginEdit: (feature: Feature) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  /** Must be referentially stable, or the live-edit effect runs every render. */
  shouldLiveApply: (signature: string) => boolean;
  selectFeature: (id: string | null) => void;
}

export interface DressUpDialogApi {
  dialog: DressUpDialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<DressUpDialogState | null>>;
  /** What the dialog dresses: its picks grouped into ONE TARGET PER BODY, else
   *  (editing) the feature's own referenced edges. */
  targets: DressUpTarget[];
  /** A size the kernel cannot build, in the dialog's own words. */
  error: string | null;
  preview: DressUpPreview | null;
  /** `picks` prefills the list; `at` is where to place the panel. */
  open: (op: "chamfer" | "fillet", picks: Selection[], at?: { x: number; y: number }) => void;
  edit: (feature: Extract<Feature, { type: "dressup" }>) => void;
  close: () => void;
  confirm: () => Promise<void>;
}

export function useDressUpDialog(deps: DressUpDialogDeps): DressUpDialogApi {
  const {
    doc,
    setDoc,
    scope,
    meshes,
    ready,
    kernelRef,
    beginEdit,
    commitEdit,
    cancelEdit,
    shouldLiveApply,
    selectFeature,
  } = deps;

  const [dialog, setDialog] = useState<DressUpDialogState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DressUpPreview | null>(null);

  // Picks spanning three bodies commit as three targets of ONE feature — see
  // dressUpTargetsFromPicks.
  const targets = useMemo((): DressUpTarget[] => {
    if (!dialog) return [];
    const stored: DressUpTarget[] = dialog.stored.map((t) => ({
      targetId: t.targetId,
      edges: t.edges,
      edgeRefs: t.edgeRefs ?? [],
      faces: t.faces ?? [],
      faceRefs: t.faceRefs ?? [],
      anchor: null,
    }));
    return mergeDressUpTargets([...stored, ...dressUpTargetsFromPicks(dialog.picks, meshes)]);
  }, [dialog, meshes]);

  // Whatever edges/faces are already selected prefill the list (and place the
  // dialog beside them); with nothing selected it opens armed for the first click.
  const open = (op: "chamfer" | "fillet", picks: Selection[], at = DEFAULT_AT) => {
    setError(null);
    setDialog({
      op,
      size: "2",
      angle: "45",
      flip: false,
      picks,
      stored: [],
      arming: dressUpTargetsFromPicks(picks, meshes).length === 0,
      x: at.x,
      y: at.y,
    });
  };

  // Seeds op + size + angle from the feature; its edges stay referenced (re-pick
  // by clicking edges on the body). A feature with no stored angle is a symmetric
  // 45° chamfer.
  const edit = (feature: Extract<Feature, { type: "dressup" }>) => {
    beginEdit(feature);
    selectFeature(feature.id);
    setError(null);
    setDialog({
      op: feature.op,
      size: feature.size,
      angle: feature.angle ?? "45",
      flip: feature.flip ?? false,
      // Editing starts from what the feature already dresses; picking adds to it
      // (a pick on a body it already dresses joins that body's list).
      picks: [],
      stored: feature.targets,
      arming: false,
      ...DEFAULT_AT,
      editId: feature.id,
    });
  };

  const close = () => {
    setDialog(null);
    setError(null);
    cancelEdit();
  };

  const confirm = async () => {
    if (!dialog || targets.length === 0) return;
    // Synchronous gate first: an empty/garbage/≤0 size (or an out-of-range chamfer
    // angle) never reaches the kernel. Empty is silently ignored (no error, just a
    // no-op); anything invalid keeps the dialog open with its message.
    if (validateDressUpDialog(dialog, scope).value === null) {
      setError(null);
      return;
    }
    const { doc: next, id } = applyDressUpSpec(doc, targets, dialog);
    // Authoritative pre-commit check against the kernel: an unsatisfiable size
    // (radius too big, degenerate edge) keeps the dialog open with the error rather
    // than committing a broken feature. Runs even if the live-validation effect
    // hasn't caught up (e.g. Enter pressed immediately after typing). With a
    // fan-out this is all-or-nothing: one body that can't take the size fails the
    // whole commit, so the timeline never ends up half dressed.
    const kernel = kernelRef.current;
    if (ready && kernel) {
      const resolvedNext = resolveDocument(next);
      let err: string | null = resolvedNext.errors[id] ?? null;
      if (!err) {
        try {
          const { results } = await kernel.regenerate(resolvedNext.features);
          const hit = results.find((r) => r.id === id && !r.ok);
          if (hit && !hit.ok) err = hit.error;
        } catch (e) {
          err = String((e as Error)?.message ?? e);
        }
      }
      if (err) {
        setError(mapDressUpKernelError(err, dialog.op));
        return;
      }
    }
    setDoc(next);
    selectFeature(null);
    commitEdit();
    setDialog(null);
    setError(null);
  };

  // Live-preview an EDIT: apply the new size/angle/edges to the real feature as
  // they change. The geometry fields are pulled out one by one so the effect's
  // dependencies can be complete and honest — depending on `dialog` whole would
  // re-apply the edit (and add an undo entry) when the panel is merely dragged.
  const editId = dialog?.editId;
  const op = dialog?.op;
  const size = dialog?.size;
  const angle = dialog?.angle;
  const flip = dialog?.flip;
  useEffect(() => {
    if (!editId || op === undefined || size === undefined || angle === undefined) return;
    if (targets.length === 0) return;
    const fields: DressUpFields = { op, size, angle, flip: !!flip, editId };
    if (validateDressUpDialog(fields, scope).value === null) return;
    const spec = specOf(targets, fields);
    if (!shouldLiveApply(JSON.stringify({ e: editId, spec }))) return;
    setDoc((prev) => updateDressUp(prev, editId, spec), `edit:${editId}`);
  }, [editId, op, size, angle, flip, targets, scope, setDoc, shouldLiveApply]);

  // Live geometry validation AND ghost preview. The sync part of validation (empty
  // / unparseable / ≤ 0) is done in render off the raw size — instant, and never
  // touches the kernel. This effect covers only the case that NEEDS the kernel: a
  // valid positive size that OCCT still can't build (e.g. a fillet radius too large
  // for the edges).
  //
  // The same regen carries `previewDelta`, so the kernel hands back the material
  // the dress-up removes and the material it adds as extra bodies — the ghosts.
  // Validation and preview therefore always agree, and a preview never costs a
  // second round trip.
  useEffect(() => {
    if (!dialog || targets.length === 0) {
      setError(null);
      setPreview(null);
      return;
    }
    if (validateDressUpDialog(dialog, scope).value === null) {
      // Empty/invalid/≤0 — surfaced synchronously in the dialog; clear any stale
      // geometry error and don't build. The stale ghost goes too: showing the last
      // good size's wedge while the field reads something else is a lie.
      setError(null);
      setPreview(null);
      return;
    }
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { doc: next, id } = applyDressUpSpec(doc, targets, dialog);
      const resolvedNext = resolveDocument(next);
      const resolveErr = resolvedNext.errors[id];
      if (resolveErr) {
        if (!cancelled) {
          setError(mapDressUpKernelError(resolveErr, dialog.op));
          setPreview(null);
        }
        return;
      }
      // Every fanned-out feature ghosts, so a multi-body dress-up previews on all
      // of its bodies at once rather than just the first.
      const features = resolvedNext.features.map((rf) =>
        rf.type === "dressup" && rf.id === id ? { ...rf, previewDelta: true } : rf,
      );
      kernel
        .regenerate(features)
        .then(({ results }) => {
          if (cancelled) return;
          const hit = results.find((r) => r.id === id && !r.ok);
          const err = hit && !hit.ok ? mapDressUpKernelError(hit.error, dialog.op) : null;
          setError(err);
          if (err) {
            setPreview(null);
            return;
          }
          const delta = (deltaId: string) => {
            const r = results.find((x) => x.id === deltaId);
            return r?.ok ? r.mesh : undefined;
          };
          // One delta pair per dressed body (see dressUpDeltaBase).
          const bases = targets.map((_, ti) => dressUpDeltaBase(id, ti));
          const removed = bases.map((b) => delta(DRESSUP_DELTA_IDS.removed(b))).filter((m) => !!m);
          const added = bases.map((b) => delta(DRESSUP_DELTA_IDS.added(b))).filter((m) => !!m);
          setPreview(removed.length || added.length ? { removed, added } : null);
        })
        .catch((err) => {
          if (!cancelled) {
            setError(mapDressUpKernelError(String(err?.message ?? err), dialog.op));
            setPreview(null);
          }
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dialog, targets, doc, ready, scope, kernelRef]);

  return { dialog, setDialog, targets, error, preview, open, edit, close, confirm };
}
