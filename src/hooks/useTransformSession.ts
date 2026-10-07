// The Transform gizmo's session state, lifted out of App.tsx.
//
// The last of the five, and the odd one out: Transform is not a dialog you fill in
// but a SESSION you enter. Its inputs arrive as viewport drags, so it carries two
// things the others do not — a per-frame numeric readout deliberately kept OUT of
// the document (dragging must never regenerate the kernel), and a record of how the
// session began, because Cancel means two different things. A transform the session
// just created is deleted; one it re-opened is reverted to the snapshot it had when
// editing started.
//
// Shape follows the other four: one explicit dependency object, no
// `exhaustive-deps` disable. The panel's screen position is passed in rather than
// computed here, for the same reason as the other hooks: placing it needs the
// camera and the viewport element, which are the shell's business.
import { useState } from "react";
import { addTransform, removeFeature, setTransform } from "../document/document";
import type { Document, TransformFeature } from "../document/types";
import { formatRounded3 } from "../lib/format";
import { featureIdOf, type Selection } from "../selection/types";
import type { TransformMode } from "../viewport/types";

/** The five numbers a gizmo drag emits. */
export interface TransformDragValues {
  tx: number;
  ty: number;
  tz: number;
  angle: number;
  scale: number;
}

/** The fields Cancel restores when reverting an edit (rather than deleting). */
type TransformSnapshot = Pick<TransformFeature, "tx" | "ty" | "tz" | "angle" | "axis" | "scale" | "copy">;

/** How the current edit began, so Cancel knows what to undo. */
type SessionOrigin = { created: true } | { created: false; snapshot: TransformSnapshot };

export interface PanelAt {
  x: number;
  y: number;
}

export interface TransformSessionDeps {
  doc: Document;
  setDoc: (next: Document | ((prev: Document) => Document), coalesceKey?: string) => void;
  picking: boolean;
  pickPurpose: string;
  setPicking: (on: boolean) => void;
  setPickPurpose: (purpose: "sketch" | "transformAxis") => void;
  /** Drop focus from whatever input has it, so an armed pick's first viewport click
   *  is not eaten by a focused field. */
  releaseFocus: () => void;
  selectFeature: (id: string | null) => void;
  setSelection: React.Dispatch<React.SetStateAction<Selection[]>>;
}

export interface TransformSessionApi {
  /** The Transform feature being edited, if any. */
  editId: string | null;
  /** The feature itself — the panel's fields read from this. */
  editing: TransformFeature | undefined;
  mode: TransformMode;
  setMode: (mode: TransformMode) => void;
  panelAt: PanelAt | null;
  setPanelAt: React.Dispatch<React.SetStateAction<PanelAt | null>>;
  /** Live numbers during a drag; null when not dragging. Display only. */
  live: TransformDragValues | null;
  /** Set when Transform was asked for with no unambiguous single-body target, so a
   *  panel waits for the next viewport body click. */
  arming: { mode: TransformMode } | null;
  /** True while the next viewport click fills the rotation axis. */
  axisPicking: boolean;
  /** Is the axis a picked reference (or about to be)? Drives which half of the
   *  panel's axis control shows. */
  pickedAxis: boolean;
  /** Begin a session on a body, creating the feature. `pivot` is the body's centre
   *  and `at` where the panel should sit. */
  begin: (targetId: string, mode: TransformMode, pivot: [number, number, number], at: PanelAt) => void;
  /** Wait for a body click instead of beginning immediately. */
  armBody: (mode: TransformMode) => void;
  /** Change the armed mode without re-clearing the selection. */
  setArmingMode: (mode: TransformMode) => void;
  cancelArming: () => void;
  /** Re-open the gizmo for an existing Transform, snapshotting it so Cancel can
   *  revert this edit rather than delete the feature. */
  edit: (feature: TransformFeature, at: PanelAt) => void;
  armAxis: () => void;
  /** Drop an armed axis pick (choosing a world axis, or closing the panel). */
  cancelAxisPick: () => void;
  /** A drag released: commit the final numbers as the feature's expressions. */
  applyDrag: (values: TransformDragValues) => void;
  /** A drag frame: update the readout only. */
  previewDrag: (values: TransformDragValues) => void;
  /** Close the gizmo, keeping the feature as-is. */
  finish: () => void;
  /** Close it and undo — delete a just-created transform, revert a re-opened one. */
  cancel: () => void;
}

export function useTransformSession(deps: TransformSessionDeps): TransformSessionApi {
  const { doc, setDoc, picking, pickPurpose, setPicking, setPickPurpose, releaseFocus, selectFeature, setSelection } =
    deps;

  const [editId, setEditId] = useState<string | null>(null);
  const [mode, setMode] = useState<TransformMode>("translate");
  const [panelAt, setPanelAt] = useState<PanelAt | null>(null);
  // Live numeric readout during a gizmo drag (display only; cleared on commit).
  // Kept out of the document so dragging never regenerates the kernel.
  const [live, setLive] = useState<TransformDragValues | null>(null);
  const [origin, setOrigin] = useState<SessionOrigin | null>(null);
  const [arming, setArming] = useState<{ mode: TransformMode } | null>(null);

  const editing = doc.features.find((f) => f.id === editId && f.type === "transform") as TransformFeature | undefined;

  const axisPicking = picking && pickPurpose === "transformAxis";
  const pickedAxis = axisPicking || (!!editing && typeof editing.axis !== "string");

  const cancelAxisPick = () => {
    if (pickPurpose !== "transformAxis") return;
    setPicking(false);
    setPickPurpose("sketch");
  };

  /** Arm the rotation-axis pick: the next click on a straight body edge or a sketch
   *  line becomes the line the body swings around. Rides the same axis-pick stream
   *  as Revolve's and Pattern's axis slots. */
  const armAxis = () => {
    setPickPurpose("transformAxis");
    setPicking(true);
    releaseFocus();
  };

  const begin = (targetId: string, nextMode: TransformMode, pivot: [number, number, number], at: PanelAt) => {
    const created = addTransform(doc, targetId, pivot);
    setDoc(created.doc);
    selectFeature(null);
    setMode(nextMode);
    setEditId(created.id);
    setPanelAt(at);
    setOrigin({ created: true });
    setArming(null);
  };

  // Like Pattern's target arming, this does NOT touch `picking`/`pickPurpose` —
  // those drive the separate axis/direction pick stream, and the click router
  // matches on `arming` directly.
  const armBody = (nextMode: TransformMode) => {
    setSelection([]);
    setArming({ mode: nextMode });
  };

  const setArmingMode = (nextMode: TransformMode) => setArming({ mode: nextMode });

  const cancelArming = () => setArming(null);

  const edit = (feature: TransformFeature, at: PanelAt) => {
    selectFeature(feature.id);
    setMode("translate");
    setEditId(feature.id);
    setPanelAt(at);
    setOrigin({
      created: false,
      snapshot: {
        tx: feature.tx,
        ty: feature.ty,
        tz: feature.tz,
        angle: feature.angle,
        axis: feature.axis,
        scale: feature.scale,
        copy: feature.copy,
      },
    });
  };

  /** A gizmo drag commits ONCE, on release: write the final numeric values back as
   *  the feature's expressions (one regenerate for the whole drag). During the drag
   *  the body is moved locally in the viewport, so the kernel never sees the
   *  intermediate frames — the fix for "stuck regenerating" in a many-solid doc. */
  const applyDrag = (v: TransformDragValues) => {
    if (!editId) return;
    if (!isFinitePose(v)) return; // see previewDrag
    setLive(null); // commit supersedes the live readout
    setDoc(
      setTransform(doc, editId, {
        tx: formatRounded3(v.tx),
        ty: formatRounded3(v.ty),
        tz: formatRounded3(v.tz),
        angle: formatRounded3(v.angle),
        scale: formatRounded3(v.scale),
      }),
      `transform:${editId}`,
    );
  };

  /** Per-frame readout while dragging — drives the panel's numbers only, never the
   *  document, so it can't trigger a regenerate. A frame carrying a non-finite
   *  number is dropped rather than shown: `formatRounded3` would render it into the field as
   *  the text "NaN"/"Infinity", and the same value on release would be committed as
   *  an expression that can't be evaluated. Holding the last good readout instead
   *  makes a degenerate frame invisible. (The gizmo guards this at source too — see
   *  proxyDelta — this is the backstop for every field.) */
  const previewDrag = (v: TransformDragValues) => {
    if (isFinitePose(v)) setLive(v);
  };

  /** Everything both exits do. An axis arming outlives the panel otherwise. */
  const endSession = () => {
    cancelAxisPick();
    setEditId(null);
    setOrigin(null);
    setPanelAt(null);
    setLive(null);
  };

  const finish = () => endSession();

  const cancel = () => {
    if (editId) {
      if (origin && !origin.created) {
        setDoc(setTransform(doc, editId, origin.snapshot));
      } else {
        setDoc(removeFeature(doc, editId));
        setSelection((prev) => prev.filter((s) => featureIdOf(s) !== editId));
      }
    }
    endSession();
  };

  return {
    editId,
    editing,
    mode,
    setMode,
    panelAt,
    setPanelAt,
    live,
    arming,
    axisPicking,
    pickedAxis,
    begin,
    armBody,
    setArmingMode,
    cancelArming,
    edit,
    armAxis,
    cancelAxisPick,
    applyDrag,
    previewDrag,
    finish,
    cancel,
  };
}

const isFinitePose = (v: TransformDragValues) => [v.tx, v.ty, v.tz, v.angle, v.scale].every(Number.isFinite);
