// The Animate dialog's state and its requestAnimationFrame loop (see
// animate.ts). Frames pose the parts through ViewportApi.poseBodies, as a
// gizmo drag does, so nothing is re-baked and React doesn't re-render per
// frame: only the readout updates, a few times a second. Nothing is written to
// the document; Stop, closing the dialog, or any edit to the assembly puts
// every part back.
import { useEffect, useRef, useState } from "react";
import { evaluateVariables } from "../document/document";
import type { ViewportApi } from "../viewport/types";
import {
  animatableDofs,
  animator,
  checkSweep,
  defaultSpec,
  valueAt,
  type AnimateSpec,
  type SweepCheck,
} from "./animate";
import { EXPORT_FPS, exportAnimation, exportFrameValues, extensionOf, type ExportFormat } from "./exportAnimation";
import { saveBlob } from "../lib/download";
import { multiply } from "./placement";
import { formatValue, invertRigid, isRotation, type Solution } from "./solve";
import type { AssemblyDoc, Dof, Mat4, MateConnector } from "./types";

/** How often the dialog's live value is refreshed while playing. */
const READOUT_MS = 100;

export interface MateAnimation {
  /** The mate the dialog is open on, or null. */
  mateId: string | null;
  spec: AnimateSpec | null;
  playing: boolean;
  /** The DOF's value in the frame on screen, while an animation is shown. */
  live: number | null;
  error: string | null;
  /** The sweep tried ahead of playing: locked, jamming, or fine. Null while
   *  it's being worked out. */
  check: SweepCheck | null;
  /** What the check found, in words, and what it rules out. */
  blocked: { text: string; play: boolean; exportable: boolean } | null;
  open(mateId: string): void;
  close(): void;
  setSpec(patch: Partial<AnimateSpec>): void;
  /** Switch the DOF, starting it from its own default sweep. */
  setDof(dof: Dof): void;
  play(): void;
  stop(): void;
  /** An export under way: its format and how far it's got. */
  exporting: { format: ExportFormat; done: number; total: number } | null;
  /** Render one cycle of the animation to a file and download it. */
  exportAs(format: ExportFormat): void;
  cancelExport(): void;
}

export function useMateAnimation({
  assembly,
  solution,
  frameFor,
  viewApi,
}: {
  assembly: AssemblyDoc | null;
  solution: Solution | null;
  frameFor: (a: AssemblyDoc) => (c: MateConnector) => Mat4 | string;
  viewApi: { current: ViewportApi | null };
}): MateAnimation {
  const [mateId, setMateId] = useState<string | null>(null);
  const [spec, setSpecState] = useState<AnimateSpec | null>(null);
  const [playing, setPlaying] = useState(false);
  const [live, setLive] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<SweepCheck | null>(null);
  const raf = useRef<number | null>(null);
  const [exporting, setExporting] = useState<MateAnimation["exporting"]>(null);
  const exportAbort = useRef<AbortController | null>(null);
  // Whether parts are posed away from their meshes (playing, or a finished
  // "once" holding its last frame).
  const posed = useRef(false);

  const release = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (posed.current) viewApi.current?.poseBodies(null);
    posed.current = false;
    setPlaying(false);
    setLive(null);
  };

  // Any edit to the assembly (or switching document) ends the animation: its
  // frames were solved from the assembly as it was.
  useEffect(
    () => () => {
      release();
      exportAbort.current?.abort();
    },
    [assembly], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const specFor = (id: string, dof?: Dof): AnimateSpec | null => {
    const mate = assembly?.mates.find((m) => m.id === id);
    if (!assembly || !mate) return null;
    const dofs = animatableDofs(assembly, mate);
    const d = dof && dofs.includes(dof) ? dof : dofs[0];
    if (!d) return null;
    const current = solution?.values.get(id)?.[d] ?? 0;
    return defaultSpec(mate, d, current, evaluateVariables(assembly.variables).scope);
  };

  const open = (id: string) => {
    release();
    setError(null);
    setMateId(id);
    setSpecState(specFor(id));
  };
  const close = () => {
    exportAbort.current?.abort();
    release();
    setMateId(null);
    setSpecState(null);
    setError(null);
  };
  const setSpec = (patch: Partial<AnimateSpec>) => setSpecState((s) => (s ? { ...s, ...patch } : s));
  const setDof = (dof: Dof) => {
    if (!mateId) return;
    release();
    setSpecState(specFor(mateId, dof));
  };

  const play = () => {
    release();
    if (!assembly || !solution || !spec) return;
    // The viewport's meshes are baked where this solution put them; each frame
    // poses a part by its motion from there.
    const baked = solution.placements;
    const run = animator(assembly, frameFor(assembly), spec);
    const t0 = performance.now();
    let shown = -Infinity;
    setError(null);
    setPlaying(true);
    const frame = (now: number) => {
      const { value, done } = valueAt(spec, (now - t0) / 1000);
      const s = run.at(value);
      const bad = [...s.problems.keys()].filter((id) => !solution.problems.has(id));
      if (bad.length) {
        // The sweep went somewhere the mates can't follow: stop there.
        const other = bad.find((id) => id !== spec.mateId);
        setError(
          `Stopped at ${formatSweepValue(value, spec.dof)}: ${other ? mateName(other) : "the mates"} can't follow.`,
        );
        raf.current = null;
        setPlaying(false);
        return;
      }
      const poses = new Map<string, Mat4>();
      for (const [id, p] of s.placements) {
        const was = baked.get(id);
        if (was) poses.set(id, multiply(p, invertRigid(was)));
      }
      viewApi.current?.poseBodies(poses);
      posed.current = true;
      if (done || now - shown >= READOUT_MS) {
        shown = now;
        setLive(value);
      }
      if (done) {
        raf.current = null;
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  };

  const exportAs = async (format: ExportFormat) => {
    release();
    const vp = viewApi.current;
    if (!assembly || !solution || !spec || !vp || exportAbort.current) return;
    const baked = solution.placements;
    const run = animator(assembly, frameFor(assembly), spec);
    const values = exportFrameValues(spec, EXPORT_FPS[format]);
    const abort = new AbortController();
    exportAbort.current = abort;
    setError(null);
    setExporting({ format, done: 0, total: values.length });
    try {
      const blob = await exportAnimation({
        format,
        values,
        aspect: vp.frameAspect(),
        once: spec.mode === "once",
        signal: abort.signal,
        draw: (value, ctx) => {
          const s = run.at(value);
          const bad = [...s.problems.keys()].find((id) => !solution.problems.has(id));
          // A frame the mates can't hold would show parts pulled apart: stop.
          if (bad) throw new Error(`the motion jams at ${formatSweepValue(value, spec.dof)} (${mateName(bad)}).`);
          const poses = new Map<string, Mat4>();
          for (const [id, p] of s.placements) {
            const was = baked.get(id);
            if (was) poses.set(id, multiply(p, invertRigid(was)));
          }
          vp.poseBodies(poses);
          posed.current = true;
          vp.drawFrame(ctx);
        },
        onProgress: (done, total) => setExporting({ format, done, total }),
      });
      const mate = assembly.mates.find((m) => m.id === spec.mateId);
      saveBlob(blob, `${mate?.name ?? "Animation"} ${spec.dof}.${extensionOf(blob.type)}`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(`Export failed: ${(e as Error).message}`);
    } finally {
      if (exportAbort.current === abort) exportAbort.current = null;
      setExporting(null);
      vp.poseBodies(null);
      posed.current = false;
    }
  };
  const cancelExport = () => exportAbort.current?.abort();

  // Try the sweep whenever it, or the assembly, changes: off the event that
  // changed it, so typing in From/To stays responsive.
  useEffect(() => {
    setCheck(null);
    if (!assembly || !solution || !spec) return;
    const current = solution.values.get(spec.mateId)?.[spec.dof] ?? 0;
    const t = setTimeout(() => setCheck(checkSweep(assembly, frameFor(assembly), spec, current)), 0);
    return () => clearTimeout(t);
  }, [assembly, solution, spec?.mateId, spec?.dof, spec?.from, spec?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const mateName = (id: string) => assembly?.mates.find((m) => m.id === id)?.name ?? "a mate";

  const names = (ids: string[]) =>
    ids.length === 1
      ? mateName(ids[0])
      : `${ids.slice(0, -1).map(mateName).join(", ")} or ${mateName(ids[ids.length - 1])}`;
  const blocked: MateAnimation["blocked"] =
    check?.kind === "locked"
      ? {
          text: check.blockers.length
            ? `Can't animate: ${names(check.blockers)} ${check.blockers.length === 1 ? "holds" : "hold"} this part still. Suppress or delete ${check.blockers.length === 1 ? "it" : "one"}, then try again.`
            : "Can't animate: other mates hold this part still. Suppress one of them, then try again.",
          play: false,
          exportable: false,
        }
      : check?.kind === "jams" && spec
        ? {
            text: `Jams at ${formatSweepValue(check.at, spec.dof)}${check.blocker ? ` (${mateName(check.blocker)} can't follow)` : ""}. Set From and To short of it to export.`,
            play: true,
            exportable: false,
          }
        : null;

  // Editing the sweep while it plays restarts it with the new one.
  useEffect(() => {
    if (raf.current !== null) play();
  }, [spec]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    mateId,
    spec,
    playing,
    live,
    error,
    check,
    blocked,
    open,
    close,
    setSpec,
    setDof,
    play,
    stop: release,
    exporting,
    exportAs: (f) => void exportAs(f),
    cancelExport,
  };
}

/** A sweep value with its unit: 132° or 12.5 mm. */
export const formatSweepValue = (v: number, dof: Dof) =>
  isRotation(dof) ? `${formatValue(v, true)}°` : `${formatValue(v, false)} mm`;
