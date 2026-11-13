// The open assembly's workspace state and behaviour: its parts' meshes (live
// from their documents, placed where the mates put them), the mates, what's
// selected and pre-picked, the Move panel and its gizmo, inserting, the
// assembly's variables, and animating a mate. App holds the one Viewport, panel
// and toolbar both kinds of document share, and reads what to show in them from
// here while an assembly is open (docs/ASSEMBLY-PLAN.md).
import { useEffect, useMemo, useRef, useState } from "react";
import { evaluateVariables, validateVariableNames } from "../document/document";
import { evaluateExpression } from "../document/expression";
import { featureIdOf, sameSelection, type Selection } from "../selection/types";
import { transformMatrix } from "../viewport/sceneMath";
import type { FeatureMesh, TransformDelta, TransformEdit, ViewportApi } from "../viewport/types";
import { insertInstances, keepSolved, referencedDocIds, removeInstances } from "./assembly";
import { dofLabel } from "./mateTypes";
import type { MoveField, MoveMode, WorldAxis } from "./MoveDialog";
import { addMoves, moveReadout, NO_MOVE, type MoveReadout } from "./moveReadout";
import { boundsCenter, IDENTITY, meshBounds, placeMesh } from "./placement";
import { relationDriving } from "./relations";
import { formatValue, isRotation, solve } from "./solve";
import type { AssemblyDoc, Dof, Mate, MateType } from "./types";
import { useAssemblySources, type BuildDocument, type SourcePart } from "./useAssemblySources";
import { exportAssemblyFile, exportPieces, type AssemblyExportKind } from "./exportAssembly";
import { duplicateInstances, insertLayout } from "./copies";
import { saveBlob } from "../lib/download";
import { useMateAnimation } from "./useMateAnimation";
import { useMates } from "./useMates";
import { useRelations } from "./useRelations";

const sameMatrix = (a: number[], b: number[]) => a === b || a.every((v, i) => v === b[i]);

export function useAssemblyWorkspace({
  assembly,
  setAssembly,
  activeId,
  genId,
  buildDocument,
  onPainted,
  viewApi,
}: {
  /** The open assembly, or null when the open document is a part. */
  assembly: AssemblyDoc | null;
  setAssembly: (a: AssemblyDoc, coalesceKey?: string) => void;
  /** The open document's id: a switch resets the selection. */
  activeId: string | null;
  genId: () => string;
  /** Builds a part document never built on this device (null until the kernel is ready). */
  buildDocument: BuildDocument | null;
  /** Every source has loaded (or failed to): the assembly has painted, for its thumbnail. */
  onPainted: () => void;
  /** The viewport, which an animation poses parts through. */
  viewApi: { current: ViewportApi | null };
}) {
  const isAssembly = assembly !== null;
  // Called from an effect keyed on the sources, not on the callback.
  const onPaintedRef = useRef(onPainted);
  onPaintedRef.current = onPainted;
  const asmDocIds = useMemo(() => (assembly ? referencedDocIds(assembly) : []), [assembly]);
  const { sources: asmSources, settled: asmSourcesSettled } = useAssemblySources({
    assemblyId: isAssembly ? activeId : null,
    docIds: asmDocIds,
    build: buildDocument,
  });
  const mates = useMates({ assembly, setAssembly, sources: asmSources, genId });
  const asmPlacements = mates.solution?.placements;
  const animation = useMateAnimation({
    assembly,
    solution: mates.solution,
    frameFor: mates.frameFor,
    viewApi,
  });
  const relations = useRelations({
    assembly,
    commit: mates.commit,
    frameFor: mates.frameFor,
    genId,
    sources: asmSources,
  });
  /** Open the Relation dialog (on `id`, or a new one), closing what would
   *  compete with it. */
  const openRelation = (id?: string) => {
    mates.close();
    animation.close();
    setAsmSelected([]);
    setAsmFaces([]);
    if (id) relations.openEdit(id);
    else relations.openNew();
  };
  // While the Animate dialog is open, the view is its: nothing is picked or
  // moved, so no frame is drawn over a part the gizmo is on.
  const animating = animation.mateId !== null;
  /** Open the Animate dialog on a mate, closing what would compete with it. */
  const openAnimation = (mateId: string) => {
    mates.close();
    relations.close();
    setAsmSelected([]);
    setAsmFaces([]);
    animation.open(mateId);
  };
  const [asmSelected, setAsmSelected] = useState<string[]>([]);
  const asmSelectedSet = useMemo(() => new Set(asmSelected), [asmSelected]);
  // An assembly's variables (the part document's panel, reused). Collapsed
  // when an assembly opens: assemblies use them less than parts do.
  const [asmVariablesOpen, setAsmVariablesOpen] = useState(false);
  useEffect(() => setAsmVariablesOpen(false), [activeId]);
  const asmVariables = useMemo(() => {
    const variables = assembly?.variables ?? [];
    return { ...evaluateVariables(variables), nameErrors: validateVariableNames(variables) };
  }, [assembly?.variables]);
  // Faces and edges clicked with no Mate dialog open: they pre-fill the next
  // one, so picking two faces and then a mate type leaves it ready to confirm.
  const [asmFaces, setAsmFaces] = useState<Selection[]>([]);
  useEffect(() => {
    setAsmSelected([]);
    setAsmFaces([]);
  }, [activeId]);
  const [insertOpen, setInsertOpen] = useState(false);
  const [moveMode, setMoveMode] = useState<MoveMode>("translate");
  const [rotateAxis, setRotateAxis] = useState<WorldAxis>("z");
  // Each instance's part mesh with its placement baked in (see placement.ts),
  // kept while neither the part's mesh nor the placement changes, so editing
  // one instance doesn't re-bake the rest.
  const placedCache = useRef(new Map<string, { mesh: unknown; transform: number[]; placed: FeatureMesh["mesh"] }>());
  const assemblyMeshes = useMemo<FeatureMesh[]>(() => {
    if (!assembly) return [];
    const next = new Map<string, { mesh: unknown; transform: number[]; placed: FeatureMesh["mesh"] }>();
    const out: FeatureMesh[] = [];
    for (const inst of assembly.instances) {
      const src = asmSources.get(inst.source.docId);
      const part = src?.status === "ready" ? src.parts.find((x) => x.partId === inst.source.partId) : undefined;
      if (!part) continue;
      // Where the mates put it (or its own placement, when nothing does).
      const transform = asmPlacements?.get(inst.id) ?? inst.transform;
      const hit = placedCache.current.get(inst.id);
      const placed =
        hit && hit.mesh === part.mesh && sameMatrix(hit.transform, transform)
          ? hit.placed
          : placeMesh(part.mesh, transform);
      next.set(inst.id, { mesh: part.mesh, transform, placed });
      if (inst.hidden) continue;
      out.push({ id: inst.id, mesh: placed, color: inst.color ?? part.color, opacity: part.opacity });
    }
    placedCache.current = next;
    return out;
  }, [assembly, asmSources, asmPlacements]);
  useEffect(() => {
    if (isAssembly && asmSourcesSettled) onPaintedRef.current();
  }, [isAssembly, asmSourcesSettled, assemblyMeshes]);

  const insertParts = (docId: string, picks: { part: SourcePart; count: number }[]) => {
    if (!assembly) return;
    // Land the insert just past everything already placed, never inside
    // another part: the document's parts together as modelled, or, with any
    // wanted more than once, a grid of each (copies.ts). The new ones end up
    // selected, so it's clear what was added.
    const layout = insertLayout(
      assemblyMeshes.map((m) => meshBounds(m.mesh)),
      picks.map(({ part, count }) => ({ partId: part.partId, name: part.name, mesh: part.mesh, count })),
    );
    const r = insertInstances(asmNow() ?? assembly, docId, layout, genId);
    setAssembly(r.assembly);
    setAsmSelected(r.ids);
  };
  /** The Duplicate prompt: which instances, while it's open. */
  const [duplicating, setDuplicating] = useState<string[] | null>(null);
  /** Open the Duplicate prompt on `id` — or, when it's one of several
   *  selected, on all of them. */
  const askDuplicate = (id: string) =>
    setDuplicating(asmSelected.includes(id) && asmSelected.length > 1 ? asmSelected : [id]);
  /** `count` copies of each instance in `ids`, in a grid beside it, selected. */
  const duplicate = (ids: string[], count: number) => {
    const now = asmNow();
    if (!now) return;
    const meshOf = (id: string) => {
      const inst = now.instances.find((i) => i.id === id);
      const src = inst ? asmSources.get(inst.source.docId) : undefined;
      return src?.status === "ready" ? src.parts.find((p) => p.partId === inst!.source.partId)?.mesh : undefined;
    };
    const r = duplicateInstances(
      now,
      ids,
      count,
      (id) => now.instances.find((i) => i.id === id)!.transform,
      meshOf,
      genId,
    );
    if (!r.ids.length) return;
    setAssembly(r.assembly);
    setAsmSelected(r.ids);
  };
  // Edits that change what the mates hold start from where everything is now
  // (see keepSolved), so a part a removed mate held stays put.
  const asmNow = () => (assembly && mates.solution ? keepSolved(assembly, mates.solution) : assembly);
  /** Save the assembly as `kind` (exportAssembly.ts), named after `title`.
   *  Why it couldn't be, if it couldn't. */
  const exportAssembly = (kind: AssemblyExportKind, title: string): string | null => {
    if (!assembly) return null;
    const pieces = exportPieces(assembly, asmSources, mates.solution?.placements);
    if (!pieces.length) return "Nothing to export: no visible part has loaded.";
    const f = exportAssemblyFile(kind, pieces, title);
    saveBlob(
      new Blob([f.bytes as Uint8Array<ArrayBuffer>], { type: f.type }),
      `${title}${kind === "stl-parts" ? " parts" : ""}.${f.extension}`,
    );
    return null;
  };
  const removeSelectedInstances = () => {
    const now = asmNow();
    if (!now || asmSelected.length === 0) return;
    setAssembly(removeInstances(now, asmSelected));
    setAsmSelected([]);
  };
  const canMate = (assembly?.instances.length ?? 0) >= 2;
  /** A new mate (of `type`, else the last type used) — or, with the dialog
   *  already open, switch it to `type`, keeping its picks. */
  const openMateDialog = (type?: MateType) => {
    if (mates.dialog) {
      if (type) mates.dialog.onType(type);
      return;
    }
    if (!canMate || insertOpen) return;
    animation.close();
    relations.close();
    setAsmSelected([]);
    mates.openNew(type, asmFaces);
    setAsmFaces([]);
  };
  const handleAssemblyPick = (picked: Selection | null) => {
    if (animating) return;
    if (mates.pick(picked)) return;
    const id = picked ? featureIdOf(picked) : null;
    const isInstance = !!id && !!assembly?.instances.some((i) => i.id === id);
    // The part clicked last is the one the gizmo moves; its faces and edges
    // gather (a second click on one drops it), as in a part document.
    setAsmSelected(isInstance ? [id] : []);
    if (!picked || !isInstance || (picked.kind !== "face" && picked.kind !== "edge" && picked.kind !== "vertex"))
      setAsmFaces([]);
    else
      setAsmFaces((prev) => {
        const i = prev.findIndex((s) => sameSelection(s, picked));
        return i >= 0 ? prev.filter((_, j) => j !== i) : [...prev, picked];
      });
  };
  // The gizmo sits on the one selected instance, at the centre of its bounds;
  // a grounded one gets none. Every drag commits as a motion applied after the
  // instance's placement, so the edit always starts from zero.
  const asmMoveTarget =
    assembly && asmSelected.length === 1 ? assembly.instances.find((i) => i.id === asmSelected[0]) : undefined;
  // The Move panel: one part selected, not mid-mate, and not two or more faces
  // gathered (those are being picked for a mate, so nothing would move).
  const asmMoveOpen = !!asmMoveTarget && !mates.sessionOpen && asmFaces.length < 2;
  // Where everything was when the Move panel opened on this part: Esc puts it
  // back, as Esc cancels a part's Transform.
  const asmMoveStart = useRef<{ id: string; assembly: AssemblyDoc } | null>(null);
  useEffect(() => {
    asmMoveStart.current = asmMoveOpen && asmMoveTarget && assembly ? { id: asmMoveTarget.id, assembly } : null;
    // Only a new session (another part, or the panel reopening) takes a snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asmMoveOpen, asmMoveTarget?.id]);
  const clearAssemblySelection = () => {
    setAsmSelected([]);
    setAsmFaces([]);
  };
  /** Esc in the Move panel: undo what this session moved (placements and the
   *  mate values drags wrote), leaving any other edit alone. */
  const cancelInstanceMove = () => {
    const start = asmMoveStart.current;
    if (!start || !assembly || start.assembly === assembly) return;
    const was = new Map(start.assembly.instances.map((i) => [i.id, i.transform]));
    const wasMate = new Map(start.assembly.mates.map((m) => [m.id, m.values]));
    setAssembly({
      ...assembly,
      instances: assembly.instances.map((i) => (was.has(i.id) ? { ...i, transform: was.get(i.id)! } : i)),
      mates: assembly.mates.map((m) => {
        if (!wasMate.has(m.id)) return m;
        const values = wasMate.get(m.id);
        const { values: _drop, ...rest } = m;
        return values ? { ...rest, values } : rest;
      }),
    });
  };
  const asmMoveMesh = asmMoveTarget ? assemblyMeshes.find((m) => m.id === asmMoveTarget.id) : undefined;
  // A mated instance moves only along what its mate leaves free: a hinge turns
  // about its own axis, a slider's drag is projected onto its axis.
  const asmDrag = asmMoveTarget && !asmMoveTarget.grounded ? mates.dragFor(asmMoveTarget.id) : null;
  const asmDragRotates = !asmDrag || asmDrag.dofs.some((d) => d[0] === "r");
  const asmDragTranslates = !asmDrag || asmDrag.dofs.some((d) => d[0] === "t");
  const asmMode: MoveMode = !asmDragTranslates ? "rotate" : !asmDragRotates ? "translate" : moveMode;
  const [asmDragMessage, setAsmDragMessage] = useState<string | null>(null);
  useEffect(() => setAsmDragMessage(null), [asmMoveTarget?.id]);
  // Bumped on every drag commit, so the gizmo resets onto the instance even
  // when the drag changed nothing (pushing a planar part off its plane).
  const [asmDragSeq, setAsmDragSeq] = useState(0);
  const asmTransformEdit = useMemo<TransformEdit | null>(() => {
    if (!asmMoveTarget || asmMoveTarget.grounded || !asmMoveMesh || mates.sessionOpen) return null;
    // Two or more faces gathered: they're being picked for a mate, not moved,
    // and the gizmo's arrows would cover the next face to pick.
    if (asmFaces.length >= 2) return null;
    if (asmDrag && asmDrag.dofs.length === 0) return null; // fastened
    const b = meshBounds(asmMoveMesh.mesh);
    if (!b) return null;
    const worldDir = (): [number, number, number] =>
      rotateAxis === "x" ? [1, 0, 0] : rotateAxis === "y" ? [0, 1, 0] : [0, 0, 1];
    let pivot = boundsCenter(b);
    let axis = { origin: pivot, dir: worldDir() };
    if (asmDrag && asmMode === "rotate") {
      // About the mate's own axis (a ball: any world axis through its centre).
      const f = asmDrag.axisWorld;
      pivot = [f[12], f[13], f[14]];
      axis = { origin: pivot, dir: asmDrag.mate.type === "ball" ? worldDir() : [f[8], f[9], f[10]] };
    }
    return {
      featureId: asmMoveTarget.id,
      bodyId: asmMoveTarget.id,
      pivot,
      tx: 0,
      ty: 0,
      tz: 0,
      angle: 0,
      axis,
      scale: 1,
    };
    // asmDrag is rebuilt every render; what it depends on is listed instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asmMoveTarget, asmMoveMesh, rotateAxis, asmMode, mates.solution, mates.sessionOpen, asmDragSeq, asmFaces.length]);
  // The Move panel's numbers. `asmMoved` is how far the selected part has
  // moved since it was selected (or its mode or axis changed); `asmLive` is
  // the drag in progress, read from where the solver puts the part, and for a
  // part one mate positions, that mate's values mid-drag.
  const [asmMoved, setAsmMoved] = useState<MoveReadout>(NO_MOVE);
  const [asmLive, setAsmLive] = useState<{
    move: MoveReadout;
    mateValues?: Mate["values"];
    /** The mate's solved values mid-drag, for the DOFs a relation drives. */
    solved?: Partial<Record<Dof, number>>;
  } | null>(null);
  useEffect(() => {
    setAsmMoved(NO_MOVE);
    setAsmLive(null);
  }, [asmMoveTarget?.id, asmMode, rotateAxis]);
  const gizmoMotion = (te: TransformEdit, d: Pick<TransformDelta, "tx" | "ty" | "tz" | "angle">) =>
    Array.from(transformMatrix(te.pivot, d.tx, d.ty, d.tz, d.angle, te.axis, 1).elements);
  /** How far `motion` actually moves the gizmo's part, after its mates. */
  const actualMove = (te: TransformEdit, motion: number[]): MoveReadout =>
    moveReadout(mates.dragPoses(te.featureId, motion).get(te.featureId) ?? IDENTITY, te.pivot, te.axis.dir);
  /** Apply a world motion to the gizmo's part, as a drag would, counting it. */
  const applyInstanceMotion = (motion: number[]) => {
    const te = asmTransformEdit;
    if (!te || !assembly) return;
    const moved = actualMove(te, motion);
    setAsmMoved((m) => addMoves(m, moved));
    setAsmLive(null);
    setAsmDragMessage(
      mates.commitDrag(te.featureId, motion, () => {
        // Cancelled at the confirmation: the view shows the released drag
        // until told otherwise, and the readout counted it.
        viewApi.current?.releaseDragPins();
        setAsmMoved((m) => addMoves(m, { tx: -moved.tx, ty: -moved.ty, tz: -moved.tz, angle: -moved.angle }));
        setAsmDragSeq((n) => n + 1);
      }),
    );
    setAsmDragSeq((n) => n + 1);
  };
  const commitInstanceMove = (d: TransformDelta) => {
    const te = asmTransformEdit;
    if (!te || !assembly || (d.tx === 0 && d.ty === 0 && d.tz === 0 && d.angle === 0)) return;
    applyInstanceMotion(gizmoMotion(te, d));
  };
  const previewInstanceMove = (d: TransformDelta) => {
    const te = asmTransformEdit;
    if (!te) return;
    const motion = gizmoMotion(te, d);
    const mateId = asmDrag?.mate.id;
    const next = mateId ? mates.dragResult(te.featureId, motion).next : null;
    const related = !!next && !!mateId && (assembly?.relations ?? []).some((r) => r.driven.mateId === mateId);
    setAsmLive({
      move: actualMove(te, motion),
      mateValues: next?.mates.find((m) => m.id === mateId)?.values,
      solved: related ? solve(next, mates.frameFor(next)).values.get(mateId!) : undefined,
    });
  };
  // Mid-drag, the viewport poses every instance the drag moves — the dragged
  // one only as its mate lets it go, and whatever is mated to it along with it.
  const asmDragPoses = (d: TransformDelta) => {
    const te = asmTransformEdit;
    if (!te) return null;
    return mates.dragPoses(te.featureId, gizmoMotion(te, d));
  };
  const asmMoveFields: MoveField[] = (() => {
    const te = asmTransformEdit;
    if (!te || !asmMoveTarget) return [];
    // A part one mate positions: that mate's own values.
    if (asmDrag) {
      const values = asmLive?.mateValues ?? asmDrag.mate.values ?? {};
      const solved = asmLive?.solved ?? mates.solution?.values.get(asmDrag.mate.id) ?? {};
      return asmDrag.dofs.map((dof) => ({
        key: dof,
        label: dofLabel(asmDrag.mate.type, dof),
        // A DOF a relation drives: where it is, not its own value (a phase).
        value:
          assembly && relationDriving(assembly, asmDrag.mate.id, dof)
            ? formatValue(solved[dof] ?? 0, isRotation(dof))
            : values[dof]?.trim() || "0",
        onCommit: (text: string) => setAsmDragMessage(mates.setMateValue(asmDrag.mate.id, dof, text)),
      }));
    }
    // Anything else: how far it has moved, live while dragging.
    const shown = asmLive ? addMoves(asmMoved, asmLive.move) : asmMoved;
    const keys = asmMode === "rotate" ? (["angle"] as const) : (["tx", "ty", "tz"] as const);
    return keys.map((k) => ({
      key: k,
      label: k === "angle" ? "Angle (°)" : `Move ${k[1].toUpperCase()} (mm)`,
      value: formatValue(shown[k], k === "angle"),
      onCommit: (text: string) => {
        let v: number;
        try {
          v = evaluateExpression(text, asmVariables.scope);
        } catch (e) {
          setAsmDragMessage(`Not a number: ${(e as Error).message}`);
          return;
        }
        const by = v - asmMoved[k];
        if (!Number.isFinite(by) || by === 0) return;
        applyInstanceMotion(gizmoMotion(te, k === "angle" ? { ...NO_MOVE, angle: by } : { ...NO_MOVE, [k]: by }));
      },
    }));
  })();
  return {
    asmDrag,
    asmDragMessage,
    asmDragPoses,
    asmDragRotates,
    asmDragTranslates,
    asmFaces,
    asmMode,
    asmMoveFields,
    asmMoveOpen,
    asmMoveTarget,
    asmNow,
    asmSelected,
    asmSelectedSet,
    asmSources,
    asmSourcesSettled,
    asmTransformEdit,
    asmVariables,
    asmVariablesOpen,
    exportAssembly,
    duplicating,
    askDuplicate,
    closeDuplicate: () => setDuplicating(null),
    duplicate,
    animation,
    openAnimation,
    relations,
    openRelation,
    assemblyMeshes,
    canMate,
    cancelInstanceMove,
    clearAssemblySelection,
    commitInstanceMove,
    handleAssemblyPick,
    insertOpen,
    insertParts,
    mates,
    openMateDialog,
    previewInstanceMove,
    removeSelectedInstances,
    rotateAxis,
    setAsmSelected,
    setAsmVariablesOpen,
    setInsertOpen,
    setMoveMode,
    setRotateAxis,
    setAsmFaces,
  };
}
