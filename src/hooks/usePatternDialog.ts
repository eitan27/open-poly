// The Pattern dialog's state machine, lifted out of App.tsx.
//
// The last and most tangled of the dialogs, because its reference slots are
// two-level controls: each of the three (two linear directions, one circular axis)
// can hold either a world axis or a picked sketch line / body face, and switching
// between those has to cancel an in-flight viewport pick. That is the state-driving
// the JSX used to do inline, and the reason this dialog needed its hook before its
// component.
//
// Shape follows useRevolveDialog deliberately: one explicit dependency object, a
// pure fields helper at module scope, and no `exhaustive-deps` disable.
import { useEffect, useState } from "react";
import { addPattern, updatePattern } from "../document/document";
import { patternDialogWarning } from "../document/patternValidation";
import type { Scope } from "../document/expression";
import type { Document, Feature, PatternAxisRef, PatternDirRef, PatternFeature } from "../document/types";

/** Which of the dialog's reference slots a pick is filling. */
export type PatternRefSlot = "dir1" | "dir2" | "axis";
/** Everything the dialog can be waiting for a click on. */
export type PatternArming = "target" | PatternRefSlot | null;

export interface PatternDialogState {
  kind: "linear" | "circular";
  /** Null until a body is armed + clicked (see `arming: "target"`) — the dialog
   *  opens immediately like Revolve, no pre-selection required. */
  targetId: string | null;
  dir1: PatternDirRef;
  count1: string;
  spacing1: string;
  flip1: boolean;
  dir2on: boolean;
  dir2: PatternDirRef | null;
  count2: string;
  spacing2: string;
  flip2: boolean;
  axis: PatternAxisRef | null;
  count: string;
  mode: "full" | "angle";
  angle: string;
  symmetric: boolean;
  arming: PatternArming;
  editId?: string;
}

type PatternFields = Omit<PatternFeature, "id" | "type" | "name" | "suppressed" | "targetId" | "color" | "opacity">;

/** The PatternFeature fields the dialog currently describes. Shared by commit and
 *  live-preview so the two cannot drift, and at module scope so neither has to
 *  depend on a closure recreated every render. */
function patternFieldsOf(d: PatternDialogState): PatternFields {
  return d.kind === "linear"
    ? {
        kind: "linear",
        dir1: d.dir1,
        count1: d.count1,
        spacing1: d.spacing1,
        flip1: d.flip1,
        ...(d.dir2on && d.dir2 ? { dir2: d.dir2, count2: d.count2, spacing2: d.spacing2, flip2: d.flip2 } : {}),
      }
    : {
        kind: "circular",
        axis: d.axis!,
        count: d.count,
        angle: d.mode === "full" ? "360" : d.angle,
        symmetric: d.mode === "angle" && d.symmetric,
      };
}

/** A circular pattern cannot build without its axis; a linear one always can. */
const isIncomplete = (d: PatternDialogState) => !d.targetId || (d.kind === "circular" && !d.axis);

export interface PatternDialogDeps {
  doc: Document;
  setDoc: (next: Document | ((prev: Document) => Document), coalesceKey?: string) => void;
  picking: boolean;
  pickPurpose: string;
  setPicking: (on: boolean) => void;
  setPickPurpose: (purpose: "sketch" | "patternAxis" | "patternDir") => void;
  /** Drop focus from whatever input has it, so an armed pick's first viewport
   *  click is not eaten by a focused field. */
  releaseFocus: () => void;
  beginEdit: (feature: Feature) => void;
  commitEdit: () => void;
  cancelEdit: () => void;
  /** Must be referentially stable, or the live-edit effect runs every render. */
  shouldLiveApply: (signature: string) => boolean;
  selectFeature: (id: string | null) => void;
  /** Variable scope the dialog's expression fields resolve against. */
  scope: Scope;
}

export interface PatternDialogApi {
  dialog: PatternDialogState | null;
  /** Why it cannot build yet, or null. Computed here rather than passed in: it is
   *  a pure function of the dialog state, so deriving it outside and handing it
   *  back would be a cycle. */
  warning: string | null;
  setDialog: React.Dispatch<React.SetStateAction<PatternDialogState | null>>;
  /** Open for a new pattern. `target` prefills the body when one is selected. */
  open: (target: string | null) => void;
  edit: (feature: Extract<Feature, { type: "pattern" }>) => void;
  close: () => void;
  confirm: () => void;
  /** Arm the shared axis-pick stream to fill one of the reference slots. */
  armPick: (slot: PatternRefSlot) => void;
  /** Arm the BODY slot (and clear whatever body it held). */
  armTarget: () => void;
  setKind: (kind: "linear" | "circular") => void;
  /** Put a slot on a world axis: the one given, else the one it already held, else
   *  X — so switching back from a picked reference lands somewhere valid rather
   *  than empty. Cancels that slot's arming. */
  setWorldRef: (slot: PatternRefSlot, current: PatternDirRef | PatternAxisRef | null, axis?: "x" | "y" | "z") => void;
  /** Clear a slot's picked reference and immediately re-arm it. */
  clearRef: (slot: PatternRefSlot) => void;
}

export function usePatternDialog(deps: PatternDialogDeps): PatternDialogApi {
  const {
    doc,
    setDoc,
    picking,
    pickPurpose,
    setPicking,
    setPickPurpose,
    releaseFocus,
    beginEdit,
    commitEdit,
    cancelEdit,
    shouldLiveApply,
    selectFeature,
    scope,
  } = deps;

  const [dialog, setDialog] = useState<PatternDialogState | null>(null);
  const warning = patternDialogWarning(dialog, scope);

  /** Drop an in-flight direction/axis pick, whichever of the two streams it is on. */
  const cancelRefPick = () => {
    if (pickPurpose === "patternAxis" || pickPurpose === "patternDir") {
      setPicking(false);
      setPickPurpose("sketch");
    }
  };

  const armPick = (slot: PatternRefSlot) => {
    setDialog((d) => (d ? { ...d, arming: slot } : d));
    setPickPurpose(slot === "axis" ? "patternAxis" : "patternDir");
    setPicking(true);
    releaseFocus();
  };

  const armTarget = () => setDialog((d) => (d ? { ...d, targetId: null, arming: "target" } : d));

  const setWorldRef = (
    slot: PatternRefSlot,
    current: PatternDirRef | PatternAxisRef | null,
    axis?: "x" | "y" | "z",
  ) => {
    if (picking && dialog?.arming === slot) {
      setPicking(false);
      setPickPurpose("sketch");
    }
    const world = axis ?? (current && "world" in current ? current.world : "x");
    setDialog((d) => (d ? { ...d, [slot]: { world }, arming: null } : d));
  };

  const clearRef = (slot: PatternRefSlot) => {
    setDialog((d) => (d ? { ...d, [slot]: null } : d));
    armPick(slot);
  };

  /** Switch between linear and circular. The two kinds want different refs, so any
   *  in-flight direction/axis pick is dropped — but the BODY arming outlives the
   *  switch (the body means the same thing to both, so the slot's dashed pulse
   *  shouldn't go out just for changing tab), and a circular pattern that already
   *  HAS its body arms the axis it now needs, the way the plane dialog arms the
   *  pick its method needs. */
  const setKind = (kind: "linear" | "circular") => {
    if (picking) cancelRefPick();
    if (kind === "circular" && dialog?.targetId && !dialog.axis) {
      setDialog((d) => (d ? { ...d, kind } : d));
      armPick("axis");
      return;
    }
    setDialog((d) => (d ? { ...d, kind, arming: d.arming === "target" ? "target" : null } : d));
  };

  const open = (target: string | null) => {
    setDialog({
      kind: "linear",
      targetId: target,
      dir1: { world: "x" },
      count1: "3",
      spacing1: "25",
      flip1: false,
      dir2on: false,
      dir2: null,
      count2: "2",
      spacing2: "25",
      flip2: false,
      axis: null,
      count: "6",
      mode: "full",
      angle: "90",
      symmetric: false,
      arming: target ? null : "target",
    });
  };

  // Seeds every field from the feature; refs (dir/axis) re-pick through the same
  // axis stream.
  const edit = (feature: Extract<Feature, { type: "pattern" }>) => {
    beginEdit(feature);
    selectFeature(feature.id);
    const full = (feature.angle ?? "360") === "360";
    setDialog({
      kind: feature.kind,
      targetId: feature.targetId,
      dir1: feature.dir1 ?? { world: "x" },
      count1: feature.count1 ?? "3",
      spacing1: feature.spacing1 ?? "25",
      flip1: feature.flip1 ?? false,
      dir2on: !!feature.dir2,
      dir2: feature.dir2 ?? null,
      count2: feature.count2 ?? "2",
      spacing2: feature.spacing2 ?? "25",
      flip2: feature.flip2 ?? false,
      axis: feature.axis ?? null,
      count: feature.count ?? "6",
      mode: full ? "full" : "angle",
      angle: full ? "90" : (feature.angle ?? "90"),
      symmetric: feature.symmetric ?? false,
      arming: null,
      editId: feature.id,
    });
  };

  const close = () => {
    setDialog(null);
    cancelRefPick();
    cancelEdit();
  };

  const confirm = () => {
    if (!dialog || warning || isIncomplete(dialog)) return;
    const fields = patternFieldsOf(dialog);
    if (dialog.editId) {
      setDoc(updatePattern(doc, dialog.editId, dialog.targetId!, fields));
      selectFeature(dialog.editId);
      commitEdit();
      close();
      return;
    }
    const { doc: next } = addPattern(doc, dialog.targetId!, fields);
    setDoc(next);
    close();
    selectFeature(null);
  };

  // Live-preview a pattern edit, skipping while the dialog is in a state that
  // cannot build. Depends on `dialog` whole, as it always did: unlike Revolve this
  // one has no x/y to be dragged, so every field it carries is a field the preview
  // cares about, and `shouldLiveApply` absorbs a run whose values are unchanged.
  useEffect(() => {
    if (!dialog?.editId || warning || isIncomplete(dialog)) return;
    const fields = patternFieldsOf(dialog);
    if (!shouldLiveApply(JSON.stringify({ e: dialog.editId, t: dialog.targetId, fields }))) return;
    setDoc((prev) => updatePattern(prev, dialog.editId!, dialog.targetId!, fields), `edit:${dialog.editId}`);
  }, [dialog, warning, setDoc, shouldLiveApply]);

  return {
    dialog,
    warning,
    setDialog,
    open,
    edit,
    close,
    confirm,
    armPick,
    armTarget,
    setKind,
    setWorldRef,
    clearRef,
  };
}
