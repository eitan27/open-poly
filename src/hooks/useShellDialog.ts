// The Shell dialog's state machine, lifted out of App.tsx.
//
// Shell is the only dialog whose commit is asynchronous, and that is what makes it
// worth its own file. Pressing Create does not build speculatively and then decide
// — it commits the feature, waits for the REAL regeneration, and keeps the dialog
// open on top of a failure. Three pieces of state exist only to make that legible
// (the busy flag, the mapped kernel error, and a run counter so a regen that lands
// late can tell it is no longer wanted), and they read as noise among App.tsx's
// other eighty `useState`s.
//
// Shape follows useRevolveDialog and usePatternDialog: one explicit dependency
// object, no `exhaustive-deps` disable.
import { useEffect, useRef, useState } from "react";
import { addShell, removeFeature, updateShell } from "../document/document";
import type { Scope } from "../document/expression";
import { NO_SHELL_FACES } from "../document/shellTarget";
import { mapShellKernelError, validateShellThickness } from "../document/shellValidation";
import type { Document, FaceRef, Feature } from "../document/types";
import type { RegenSettle } from "../agent/commands";

export interface ShellDialogState {
  thickness: string;
  editId?: string;
  /** Set once this dialog has put a feature in the timeline that the user has not
   *  confirmed yet — see `confirm`. Cancelling removes it; pressing Create again
   *  updates it rather than adding a second one. */
  createdId?: string;
  targetId: string | null;
  faces: string[];
  faceRefs: FaceRef[];
  arming: "body" | "faces" | null;
}

/** A Shell dialog with its body armed — the state a feature can be built from. */
export type ArmedShellDialog = ShellDialogState & { targetId: string };

/** How long to wait for the kernel before falling back on whatever was last known.
 *  Well past the seconds a loft's cavity takes — the agent's default of 8s would
 *  give up on exactly the geometry this is for. */
const REGEN_TIMEOUT_MS = 120000;

/** The feature spec the dialog currently describes. Shared by the commit and the
 *  live-edit effect so the two cannot drift. */
const specOf = (d: ArmedShellDialog) => ({
  targetId: d.targetId,
  faces: d.faces,
  thickness: d.thickness,
  faceRefs: d.faceRefs,
});

export interface ShellDialogDeps {
  doc: Document;
  setDoc: (next: Document | ((prev: Document) => Document), coalesceKey?: string) => void;
  /** Variable scope the thickness expression resolves against. */
  scope: Scope;
  beginEdit: (feature: Feature) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  /** Must be referentially stable, or the live-edit effect runs every render. */
  shouldLiveApply: (signature: string) => boolean;
  selectFeature: (id: string | null) => void;
  /** Resolves once the kernel finishes the regeneration a `setDoc` triggered. */
  waitForRegen: (timeoutMs: number) => Promise<RegenSettle>;
}

export interface ShellDialogApi {
  dialog: ShellDialogState | null;
  setDialog: React.Dispatch<React.SetStateAction<ShellDialogState | null>>;
  /** The dialog once it has a body — the state a feature can be built from. */
  armed: ArmedShellDialog | null;
  /** An unsatisfiable thickness, as the kernel explained it. */
  error: string | null;
  /** True while Create is waiting on the kernel. */
  busy: boolean;
  /** `body` prefills the target when one is already selected. */
  open: (body: string | null) => void;
  edit: (feature: Extract<Feature, { type: "shell" }>) => void;
  close: () => void;
  confirm: () => Promise<void>;
}

export function useShellDialog(deps: ShellDialogDeps): ShellDialogApi {
  const { doc, setDoc, scope, beginEdit, commitEdit, cancelEdit, shouldLiveApply, selectFeature, waitForRegen } = deps;

  const [dialog, setDialog] = useState<ShellDialogState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped whenever a run is superseded (a second press, or the dialog closing),
   *  so a regen that lands late can tell it is no longer wanted. */
  const runRef = useRef(0);

  // The dialog is armed once it has a body. It owns that state outright rather
  // than deriving it from the live selection, so clicking around the viewport
  // can't silently re-point a half-filled Shell at something else.
  const armed = dialog?.targetId ? (dialog as ArmedShellDialog) : null;

  const open = (body: string | null) => {
    setError(null);
    setBusy(false);
    setDialog({ thickness: "2", targetId: body, ...NO_SHELL_FACES, arming: body ? null : "body" });
  };

  // Seeds the body, the opened faces and the thickness from the feature, so the
  // dialog shows what the feature actually references rather than making the user
  // re-pick.
  const edit = (feature: Extract<Feature, { type: "shell" }>) => {
    beginEdit(feature);
    selectFeature(feature.id);
    setError(null);
    setDialog({
      thickness: feature.thickness,
      editId: feature.id,
      targetId: feature.targetId,
      faces: feature.faces,
      faceRefs: feature.faceRefs ?? feature.faces.map((name) => ({ name })),
      arming: null,
    });
  };

  const close = () => {
    const pending = dialog?.createdId;
    runRef.current++; // a regen still in flight is no longer wanted
    setDialog(null);
    setError(null);
    setBusy(false);
    cancelEdit();
    // A feature this dialog added but never got to a working state goes with it —
    // cancelling a Shell should not leave a broken one behind.
    if (pending) setDoc((prev) => removeFeature(prev, pending));
  };

  /** Build the shell by COMMITTING it and reading the result off the real
   *  regeneration — no speculative rebuild, no cache.
   *
   *  This used to build the whole document a second time, in a throwaway copy,
   *  purely to ask whether the feature would survive; on a lofted body that is
   *  seconds of OCCT work paid twice, and the dialog sat there looking inert for
   *  the first half of it. The regeneration that follows `setDoc` answers the same
   *  question, so wait for THAT.
   *
   *  A feature that fails is LEFT IN THE TIMELINE, flagged with its error, and the
   *  dialog stays open on top of it. That mirrors how editing an existing shell
   *  already behaves (its live preview commits as you type), it needs no reverting
   *  — so no stray undo entries — and the failure is visible where every other
   *  feature's failure is. Cancelling removes it; pressing Create again updates it
   *  in place, which is what `createdId` is for. */
  const confirm = async () => {
    if (!armed || busy) return;
    // Synchronous gate first: an empty/garbage/≤0 thickness never reaches the
    // kernel. Empty is silently ignored (no error, just a no-op); anything invalid
    // keeps the dialog open with its message.
    if (validateShellThickness(armed.thickness, scope).value === null) {
      setError(null);
      return;
    }
    const { doc: next, id } = armed.editId
      ? { doc: updateShell(doc, armed.editId, specOf(armed)), id: armed.editId }
      : addShell(doc, armed.targetId, armed.faces, armed.thickness, armed.faceRefs);
    const run = ++runRef.current;
    setError(null);
    setBusy(true);
    setDoc(next);
    // Remember what we just put in the timeline, so a retry edits it and a cancel
    // takes it away again.
    setDialog((p) => (p ? { ...p, editId: id, createdId: p.createdId ?? id } : p));
    const settle = await waitForRegen(REGEN_TIMEOUT_MS);
    if (runRef.current !== run) return; // superseded, or the dialog closed
    setBusy(false);
    const err = settle.errors[id];
    if (err) {
      setError(mapShellKernelError(err));
      return;
    }
    selectFeature(id);
    commitEdit();
    runRef.current++;
    setDialog(null);
    setError(null);
  };

  // Live-preview an edit: apply the new thickness/faces to the real feature as they
  // change (skipping empty/invalid thicknesses). Pulled out field by field rather
  // than depending on `dialog` whole, so arming a slot does not re-apply the edit.
  const editId = dialog?.editId;
  const thickness = dialog?.thickness;
  const targetId = dialog?.targetId;
  const faces = dialog?.faces;
  const faceRefs = dialog?.faceRefs;
  useEffect(() => {
    if (!editId || !targetId || !faces || !faceRefs || thickness === undefined) return;
    if (validateShellThickness(thickness, scope).value === null) return;
    const spec = { targetId, faces, thickness, faceRefs };
    if (!shouldLiveApply(JSON.stringify({ e: editId, spec }))) return;
    setDoc((prev) => updateShell(prev, editId, spec), `edit:${editId}`);
  }, [editId, thickness, targetId, faces, faceRefs, scope, setDoc, shouldLiveApply]);

  // Drop a stale build error as soon as the spec changes: whatever the kernel said
  // applies to what was asked for then, not to what is being asked for now. There
  // is no speculative rebuild behind this — the error comes from the real
  // regeneration in `confirm`, which is the only place the geometry is built.
  useEffect(() => {
    setError(null);
  }, [targetId, thickness, faces]);

  return { dialog, setDialog, armed, error, busy, open, edit, close, confirm };
}
