// Everything mates need in the open assembly: finding connector frames on the
// parts' meshes, solving the tree, the Mate dialog's session (with its live
// preview), and dragging a mated part along what its mate leaves free.
import { useMemo, useRef, useState } from "react";
import type { GhostMesh } from "../viewport/types";
import type { Selection } from "../selection/types";
import { addMate, keepSolved, nextMateName, removeMates, updateMate } from "./assembly";
import {
  anchorsOf,
  connectorRefOf,
  frameMatrix,
  midplaneShape,
  resolveConnector,
  shapeFrame,
  type Anchor,
  type ConnectorRef,
  type ConnectorShape,
} from "./frames";
import { dragAssembly } from "./drag";
import { connectorGlyph } from "./glyph";
import type { MateDialogProps } from "./MateDialog";
import { MATE_TYPES } from "./mateTypes";
import { meshBounds, multiply } from "./placement";
import { invertRigid, MATE_DOFS, solve, type Solution } from "./solve";
import type { AssemblyDoc, Dof, Mat4, Mate, MateConnector, MateType } from "./types";
import type { SourceState } from "./useAssemblySources";

interface Draft {
  type: MateType;
  a?: MateConnector;
  b?: MateConnector;
  values: Partial<Record<Dof, string>>;
  limits: Partial<Record<Dof, { min?: string; max?: string }>>;
  flip: boolean;
  turns: number;
}

interface Session {
  /** The mate being edited, or null for a new one. */
  editingId: string | null;
  draft: Draft;
  /** Which slot the next viewport click fills. */
  armed: 0 | 1 | null;
  message: string | null;
  /** Mates made by clicking on to the next face since the dialog opened. */
  made: number;
}

/** Mate types that hold every rotation, so a quarter turn changes whether
 *  they fit; for the rest only Flip can. */
const TURNS_MATTER: ReadonlySet<MateType> = new Set(["fastened", "slider"]);

const DRAFT_ID = "__draft";

/** A draft's side as its type reads it: a width mate needs both faces, and
 *  any other type drops a second face left over from trying Width. */
const sideOf = (d: Draft, c: MateConnector | undefined): MateConnector | undefined => {
  if (!c) return undefined;
  if (d.type === "width") return c.ref2 ? c : undefined;
  return c.ref2 ? { instanceId: c.instanceId, ref: c.ref, anchor: c.anchor } : c;
};
const draftMate = (d: Draft, id: string, name: string): Mate | null => {
  const a = sideOf(d, d.a);
  const b = sideOf(d, d.b);
  return a && b
    ? {
        id,
        name,
        type: d.type,
        a,
        b,
        ...(Object.keys(d.values).length ? { values: d.values } : {}),
        ...(Object.keys(d.limits).length ? { limits: d.limits } : {}),
        ...(d.flip ? { flip: true } : {}),
        ...(d.turns ? { turns: d.turns } : {}),
      }
    : null;
};

/** A mate that a drag can move along: the instance's driving mate and both
 *  ends' frames. */
export interface DofDrag {
  mate: Mate;
  /** The dragged instance is the mate's `a` side. */
  reversed: boolean;
  /** The free DOFs (none for fastened). */
  dofs: Dof[];
  /** World frame of the mate's `a` connector: the axis a hinge turns about. */
  axisWorld: Mat4;
}

export function useMates({
  assembly,
  setAssembly,
  sources,
  genId,
}: {
  assembly: AssemblyDoc | null;
  setAssembly: (a: AssemblyDoc, coalesceKey?: string) => void;
  sources: ReadonlyMap<string, SourceState>;
  genId: () => string;
}) {
  const [session, setSession] = useState<Session | null>(null);

  // Connector shapes, kept while the part's mesh is the same object.
  const shapeCache = useRef(new Map<string, { mesh: unknown; shape: ConnectorShape | null }>());
  const partMesh = (a: AssemblyDoc, instanceId: string) => {
    const inst = a.instances.find((i) => i.id === instanceId);
    const src = inst ? sources.get(inst.source.docId) : undefined;
    return src?.status === "ready" ? src.parts.find((p) => p.partId === inst!.source.partId)?.mesh : undefined;
  };
  const refShape = (a: AssemblyDoc, instanceId: string, ref: ConnectorRef): ConnectorShape | null | undefined => {
    const mesh = partMesh(a, instanceId);
    if (!mesh) return undefined;
    const key = `${instanceId}|${ref.kind}|${ref.name}`;
    const hit = shapeCache.current.get(key);
    if (hit && hit.mesh === mesh) return hit.shape;
    const shape = resolveConnector(mesh, ref)?.shape ?? null;
    shapeCache.current.set(key, { mesh, shape });
    return shape;
  };
  /** What a connector is: its face or edge, or for a width mate's pair of
   *  faces the plane midway between them (null if they've stopped being
   *  parallel). */
  const shapeOf = (a: AssemblyDoc, c: MateConnector): ConnectorShape | null | undefined => {
    const p = refShape(a, c.instanceId, c.ref);
    if (!c.ref2 || !p) return p;
    const q = refShape(a, c.instanceId, c.ref2);
    return q && midplaneShape(p, q);
  };
  const frameFor =
    (a: AssemblyDoc) =>
    (c: MateConnector): Mat4 | string => {
      const shape = shapeOf(a, c);
      const name = a.instances.find((i) => i.id === c.instanceId)?.name ?? "a removed instance";
      if (shape === undefined) return `${name}'s part isn't available.`;
      if (shape === null)
        return c.ref2
          ? `The two faces it was mated to on ${name} are gone or no longer parallel.`
          : `Can't find the ${c.ref.kind} it was mated to on ${name}.`;
      return frameMatrix(shapeFrame(shape, c.anchor));
    };

  // What the viewport shows: the assembly, with the mate being made applied.
  const display = useMemo(() => {
    if (!assembly || !session) return assembly;
    const existing = session.editingId ? assembly.mates.find((m) => m.id === session.editingId) : undefined;
    const m = draftMate(session.draft, existing?.id ?? DRAFT_ID, existing?.name ?? "");
    if (!m) return assembly;
    return existing ? updateMate(assembly, m) : addMate(assembly, m);
  }, [assembly, session]);

  const solution = useMemo<Solution | null>(
    () => (display ? solve(display, frameFor(display)) : null),
    // frameFor reads `sources`, which is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [display, sources],
  );

  /** Store `next`, with every instance kept where the solver puts it. */
  const commit = (next: AssemblyDoc) => setAssembly(keepSolved(next, solve(next, frameFor(next))));

  const blank = (type: MateType = "fastened"): Draft => ({ type, values: {}, limits: {}, flip: false, turns: 0 });
  // The type a new mate starts as: the one last chosen (M reopens it).
  const lastType = useRef<MateType>("fastened");
  const fresh = (type: MateType, made = 0): Session => ({
    editingId: null,
    draft: blank(type),
    armed: 0,
    message: null,
    made,
  });
  /** A new mate dialog. `preselected` faces/edges (picked before it opened)
   *  fill its slots in order, grouped by part, so two faces picked then a
   *  mate type leave it ready to confirm. */
  const openNew = (type: MateType = lastType.current, preselected: Selection[] = []) => {
    lastType.current = type;
    const start = fresh(type);
    let s = start;
    if (assembly && preselected.length) {
      const owner = (p: Selection) => ("featureId" in p ? p.featureId : "");
      // Grouped by part, the part with more picks first: a width mate's three
      // faces fill the first slot from the part that has both, whichever
      // order they were clicked in.
      const count = (id: string) => preselected.filter((p) => owner(p) === id).length;
      const parts = [...new Set(preselected.map(owner))].sort((x, y) => count(y) - count(x));
      const ordered = parts.flatMap((id) => preselected.filter((p) => owner(p) === id));
      // All or nothing: every pick must land in a slot. Two faces of one part,
      // more faces than the mate takes, a face nothing can anchor to, or a
      // width mate given one face a part: start empty instead, as if nothing
      // had been picked, and say why.
      let refused = false;
      for (const p of ordered) {
        if (s.armed === null) {
          refused = true;
          break;
        }
        const before = s.draft;
        s = step(assembly, s, p);
        // A refused pick leaves the draft as it was (its message says why).
        if (s.draft === before) {
          refused = true;
          break;
        }
      }
      const used = [s.draft.a?.ref, s.draft.a?.ref2, s.draft.b?.ref, s.draft.b?.ref2].filter(Boolean).length;
      if (refused || used !== ordered.length)
        s = {
          ...start,
          message: `The ${ordered.length === 1 ? "picked face doesn't" : "picked faces don't"} make a ${MATE_TYPES.find((t) => t.type === type)?.label ?? type} mate, so they were let go. Pick its faces here.`,
        };
    }
    setSession(s);
  };
  const openEdit = (id: string) => {
    const m = assembly?.mates.find((x) => x.id === id);
    if (!m) return;
    setSession({
      editingId: id,
      draft: {
        type: m.type,
        a: m.a,
        b: m.b,
        values: m.values ?? {},
        limits: m.limits ?? {},
        flip: !!m.flip,
        turns: m.turns ?? 0,
      },
      armed: null,
      message: null,
      made: 0,
    });
  };
  const close = () => setSession(null);
  const patch = (fn: (d: Draft) => Draft) => setSession((s) => (s ? { ...s, draft: fn(s.draft), message: null } : s));

  /** `d` turned the way that fits, if the way it is doesn't: a new mate
   *  between parts that other mates already hold (a loop group) is often only
   *  over-constrained because its faces default to touching where they
   *  should be flush. Tries Flip, and for types that hold every rotation the
   *  quarter turns too. Unchanged if nothing fits, or if it already does.
   *  Silent: the mate never existed the other way round, so there's nothing
   *  to point at; the Flip button shows as pressed. */
  const autoOrient = (a: AssemblyDoc, s: Session): Session => {
    const existing = s.editingId ? a.mates.find((m) => m.id === s.editingId) : undefined;
    const id = existing?.id ?? DRAFT_ID;
    const fits = (d: Draft) => {
      const m = draftMate(d, id, existing?.name ?? "");
      if (!m) return true;
      const shown = existing ? updateMate(a, m) : addMate(a, m);
      return !solve(shown, frameFor(shown)).problems.has(id);
    };
    const d = s.draft;
    if (fits(d)) return s;
    const turns = TURNS_MATTER.has(d.type) ? [0, 1, 2, 3] : [d.turns];
    for (const flip of [d.flip, !d.flip])
      for (const t of turns) {
        const v = { ...d, flip, turns: (d.turns + t) % 4 };
        if ((v.flip !== d.flip || v.turns !== d.turns) && fits(v)) return { ...s, draft: v };
      }
    return s;
  };

  /** What a click on `picked` does to the session: fills the armed slot (a
   *  width mate's two faces one at a time), or says why it can't. */
  const step = (a: AssemblyDoc, session: Session, picked: Selection | null): Session => {
    if (session.armed === null) return session;
    if (!picked || (picked.kind !== "face" && picked.kind !== "edge")) return session;
    const mesh = partMesh(a, picked.featureId);
    if (!mesh) return session;
    const c = connectorRefOf(
      mesh,
      picked.kind === "face" ? { kind: "face", faceId: picked.faceId } : { kind: "edge", edgeId: picked.edgeId },
    );
    if (!c) return { ...session, message: "That can't anchor a mate. Pick a flat face, a round wall, or an edge." };
    const slot = session.armed;
    const other = slot === 0 ? session.draft.b : session.draft.a;
    if (other?.instanceId === picked.featureId)
      return { ...session, message: "Pick a face or edge on a different part." };
    const width = session.draft.type === "width";
    let conn: MateConnector = { instanceId: picked.featureId, ref: c.ref, anchor: "center" };
    if (width) {
      if (c.shape.kind !== "plane") return { ...session, message: "A width mate needs two flat faces on each part." };
      // A second flat face on the same part completes the pair; a third
      // replaces the second. A face on another part starts the slot over.
      const cur = slot === 0 ? session.draft.a : session.draft.b;
      const first = cur?.instanceId === picked.featureId ? refShape(a, cur.instanceId, cur.ref) : null;
      if (cur && first?.kind === "plane") {
        if (cur.ref.name === c.ref.name) return { ...session, message: "Pick the face on the other side." };
        if (!midplaneShape(first, c.shape))
          return { ...session, message: "Those two faces aren't parallel and apart. Pick the face on the other side." };
        conn = { ...cur, ref2: c.ref };
      }
    }
    const draft = slot === 0 ? { ...session.draft, a: conn } : { ...session.draft, b: conn };
    const done = (x: MateConnector | undefined) => !!x && (!width || !!x.ref2);
    const nextArmed = !done(conn) ? slot : slot === 0 && !done(draft.b) ? 1 : null;
    const next = { ...session, draft, armed: nextArmed, message: null };
    return nextArmed === null ? autoOrient(a, next) : next;
  };

  /** A new mate that's complete and holds: what a click on another face
   *  commits before starting the next one. */
  const ready = (s: Session) =>
    s.editingId === null && s.armed === null && !!draftMate(s.draft, DRAFT_ID, "") && !solution?.problems.has(DRAFT_ID);

  /** A viewport click while the dialog listens. True if it was used. */
  const pick = (picked: Selection | null): boolean => {
    if (!session || !assembly) return false;
    if (session.armed === null) {
      // A finished new mate: clicking on to the next face makes it, and
      // starts the next mate (same type) from that face.
      if (ready(session) && picked && (picked.kind === "face" || picked.kind === "edge")) {
        const next = make(assembly, session);
        if (next) setSession(step(next, fresh(session.draft.type, session.made + 1), picked));
      }
      return true; // the dialog owns clicks while open
    }
    setSession(step(assembly, session, picked));
    return true;
  };

  /** Commit the session's mate; the assembly it leads to (null if incomplete). */
  const make = (a: AssemblyDoc, s: Session): AssemblyDoc | null => {
    const existing = s.editingId ? a.mates.find((m) => m.id === s.editingId) : undefined;
    const m = draftMate(s.draft, existing?.id ?? genId(), existing?.name ?? nextMateName(a, s.draft.type));
    if (!m) return null;
    // A mate's name follows its type until the user renames it.
    if (existing && existing.type !== m.type && /^\w+ \d+$/.test(existing.name)) m.name = nextMateName(a, m.type);
    const added = existing ? updateMate(a, m) : addMate(a, m);
    const next = keepSolved(added, solve(added, frameFor(added)));
    setAssembly(next);
    return next;
  };

  /** Create (or finish editing), and close. To keep going without it, click
   *  on to the next face (see pick). */
  const confirm = () => {
    if (!assembly || !session) return;
    if (make(assembly, session)) setSession(null);
  };

  const remove = (id: string) => {
    if (!assembly) return;
    commit(removeMates(assembly, [id]));
    if (session?.editingId === id) setSession(null);
  };

  // Markers at the picked connectors, sized to the assembly.
  const glyphs = useMemo<GhostMesh[]>(() => {
    if (!session || !display || !solution) return [];
    let size = 0;
    for (const inst of display.instances) {
      const mesh = partMesh(display, inst.id);
      const b = mesh && meshBounds(mesh);
      if (b) size = Math.max(size, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]));
    }
    const glyphSize = Math.min(40, Math.max(4, size * 0.25));
    const out: GhostMesh[] = [];
    for (const c of [sideOf(session.draft, session.draft.a), sideOf(session.draft, session.draft.b)]) {
      if (!c) continue;
      const f = frameFor(display)(c);
      const place = solution.placements.get(c.instanceId);
      if (typeof f === "string" || !place) continue;
      out.push({ mesh: connectorGlyph(multiply(place, f), glyphSize), variant: "fill" });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, display, solution]);

  /** The picked connectors' faces/edges, shown as the viewport's selection. */
  const picks = useMemo<Selection[] | null>(() => {
    if (!session || !display) return null;
    const out: Selection[] = [];
    for (const c of [session.draft.a, session.draft.b]) {
      const mesh = c && partMesh(display, c.instanceId);
      if (!c || !mesh) continue;
      const refs = session.draft.type === "width" && c.ref2 ? [c.ref, c.ref2] : [c.ref];
      for (const ref of refs) {
        if (ref.kind === "face") {
          const g = mesh.faces.faceGroups?.find((x) => x.name === ref.name);
          if (g) out.push({ kind: "face", featureId: c.instanceId, faceId: g.faceId });
        } else {
          const g = mesh.edges.edgeGroups?.find((x) => x.name === ref.name);
          if (g) out.push({ kind: "edge", featureId: c.instanceId, edgeId: g.edgeId });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, display]);

  const slotView = (i: 0 | 1): MateDialogProps["slots"][number] => {
    const raw = i === 0 ? session?.draft.a : session?.draft.b;
    const width = session?.draft.type === "width";
    // Width reads a half-picked slot as started only if its face is flat (a
    // leftover edge from another type isn't a start).
    const half = width && raw && !raw.ref2 && display && refShape(display, raw.instanceId, raw.ref)?.kind !== "plane";
    const c = session && !half ? (width ? raw : sideOf(session.draft, raw)) : undefined;
    const inst = c && display?.instances.find((x) => x.id === c.instanceId);
    const shape = c && display ? shapeOf(display, c) : null;
    const what = width ? (c?.ref2 ? "2 faces" : "1 of 2 faces") : shape ? SHAPE_WORDS[shape.kind] : (c?.ref.kind ?? "");
    return {
      label: c ? `${inst?.name ?? "?"} · ${what}` : null,
      noun: width && c && !c.ref2 ? `the opposite face of ${inst?.name ?? "the part"}` : undefined,
      armed: session?.armed === i,
      anchors: shape ? anchorsOf(shape) : ["center"],
      anchor: c?.anchor ?? "center",
      onArm: () => setSession((s) => (s ? { ...s, armed: i, message: null } : s)),
      onAnchor: (anchor: Anchor) =>
        patch((d) => {
          const cur = i === 0 ? d.a : d.b;
          if (!cur) return d;
          return i === 0 ? { ...d, a: { ...cur, anchor } } : { ...d, b: { ...cur, anchor } };
        }),
    };
  };

  const problem = session && solution ? solution.problems.get(session.editingId ?? DRAFT_ID) : undefined;
  const dialog: MateDialogProps | null =
    session && assembly
      ? {
          editing: session.editingId !== null,
          type: session.draft.type,
          onType: (type) => {
            lastType.current = type;
            setSession((s) => {
              if (!s) return s;
              const draft = { ...s.draft, type };
              // Switching to Width leaves the slots a face short: listen for it.
              const short = (c: MateConnector | undefined) => type === "width" && !c?.ref2;
              const armed = short(draft.a) ? 0 : short(draft.b) ? 1 : s.armed;
              const next = { ...s, draft, armed, message: null };
              return armed === null && assembly ? autoOrient(assembly, next) : next;
            });
          },
          slots: [slotView(0), slotView(1)],
          flip: session.draft.flip,
          onFlip: () => patch((d) => ({ ...d, flip: !d.flip })),
          onTurn: () => patch((d) => ({ ...d, turns: (d.turns + 1) % 4 })),
          values: session.draft.values,
          onValue: (dof, text) => patch((d) => ({ ...d, values: setOrDrop(d.values, dof, text) })),
          limits: session.draft.limits,
          onLimit: (dof, end, text) =>
            patch((d) => {
              const cur = { ...d.limits[dof], [end]: text.trim() ? text : undefined };
              const limits = { ...d.limits };
              if (cur.min === undefined && cur.max === undefined) delete limits[dof];
              else limits[dof] = cur;
              return { ...d, limits };
            }),
          message: session.message ?? problem ?? null,
          canConfirm: !!(sideOf(session.draft, session.draft.a) && sideOf(session.draft, session.draft.b)) && !problem,
          onConfirm: confirm,
          onCancel: close,
          made: session.made,
        }
      : null;

  /** How a drag may move an instance: along its driving mate, or not at all
   *  (null: it isn't mated, move it freely). */
  const dragFor = (instanceId: string): DofDrag | null => {
    if (!display || !solution) return null;
    const by = solution.drivenBy.get(instanceId);
    const mate = by && display.mates.find((m) => m.id === by.mateId);
    if (!by || !mate) return null;
    const ca = frameFor(display)(mate.a);
    const pa = solution.placements.get(mate.a.instanceId);
    if (typeof ca === "string" || !pa) return null;
    return { mate, reversed: by.reversed, dofs: MATE_DOFS[mate.type], axisWorld: multiply(pa, ca) };
  };

  /** The assembly a drag (a world motion of one instance) leads to: see
   *  drag.ts. */
  const dragResult = (instanceId: string, motion: Mat4): { next: AssemblyDoc | null; error: string | null } =>
    assembly && solution
      ? dragAssembly(assembly, solution, frameFor(assembly), instanceId, motion)
      : { next: null, error: null };

  /** Commit a drag (see dragResult); the error, if it couldn't be. */
  const commitDrag = (instanceId: string, motion: Mat4): string | null => {
    const { next, error } = dragResult(instanceId, motion);
    if (next) commit(next);
    return error;
  };

  /** Mid-drag: how far each instance the drag moves has moved, as a world
   *  motion (new placement · current placement⁻¹) — the dragged instance as its
   *  mate lets it go, and everything mated to it. Instances that stay put are
   *  left out. */
  const dragPoses = (instanceId: string, motion: Mat4): Map<string, Mat4> => {
    const out = new Map<string, Mat4>();
    const { next } = dragResult(instanceId, motion);
    if (!next || !solution) return out;
    for (const [id, p] of solve(next, frameFor(next)).placements) {
      const was = solution.placements.get(id);
      if (was && !sameMatrix(was, p)) out.set(id, multiply(p, invertRigid(was)));
    }
    return out;
  };

  /** Type a value into one of a mate's free DOFs (the Move panel's fields
   *  for a part that mate positions). Empty clears it to 0. */
  const setMateValue = (mateId: string, dof: Dof, text: string) => {
    const m = assembly?.mates.find((x) => x.id === mateId);
    if (!assembly || !m) return;
    commit(updateMate(assembly, { ...m, values: setOrDrop(m.values ?? {}, dof, text) }));
  };

  return {
    setMateValue,
    dragResult,
    solution,
    display,
    sessionOpen: session !== null,
    dialog,
    glyphs,
    picks,
    pick,
    openNew,
    openEdit,
    editingId: session?.editingId ?? null,
    close,
    remove,
    commit,
    dragFor,
    commitDrag,
    dragPoses,
  };
}

const SHAPE_WORDS: Record<ConnectorShape["kind"], string> = {
  plane: "face",
  cylinder: "axis",
  circle: "circle",
  line: "edge",
};

const sameMatrix = (a: Mat4, b: Mat4) => a.every((v, i) => v === b[i]);

function setOrDrop<K extends string>(rec: Partial<Record<K, string>>, k: K, text: string) {
  const next = { ...rec };
  if (text.trim()) next[k] = text;
  else delete next[k];
  return next;
}
