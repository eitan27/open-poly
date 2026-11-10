// The Animate dialog's state and its requestAnimationFrame loop (see
// animate.ts). Frames pose the parts through ViewportApi.poseBodies, as a
// gizmo drag does, so nothing is re-baked and React doesn't re-render per
// frame: only the readout updates, a few times a second. Nothing is written to
// the document; Stop, closing the dialog, or any edit to the assembly puts
// every part back.
import { useEffect, useRef, useState } from "react";
import { evaluateVariables } from "../document/document";
import type { ViewportApi } from "../viewport/types";
import { animatableDofs, animator, defaultSpec, valueAt, type AnimateSpec } from "./animate";
import { multiply } from "./placement";
import { invertRigid, type Solution } from "./solve";
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
  open(mateId: string): void;
  close(): void;
  setSpec(patch: Partial<AnimateSpec>): void;
  /** Switch the DOF, starting it from its own default sweep. */
  setDof(dof: Dof): void;
  play(): void;
  stop(): void;
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
  const raf = useRef<number | null>(null);
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
  useEffect(() => release, [assembly]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const bad = s.problems.get(spec.mateId) ?? [...s.problems.values()][0];
      if (bad && !solution.problems.size) {
        // The sweep went somewhere the mates can't follow: stop there.
        setError(`Stopped at ${value.toFixed(1)}: ${bad}`);
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

  // Editing the sweep while it plays restarts it with the new one.
  useEffect(() => {
    if (raf.current !== null) play();
  }, [spec]); // eslint-disable-line react-hooks/exhaustive-deps

  return { mateId, spec, playing, live, error, open, close, setSpec, setDof, play, stop: release };
}
