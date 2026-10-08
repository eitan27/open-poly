import { useRef, useState } from "react";

/** One in-progress sketch-tool session: Offset, Mirror, Project, Pattern or Text.
 *
 *  These five all work the same way and all needed the same three pieces, which is
 *  why they are one hook. A session accumulates on the canvas (an armed axis, a set
 *  of picked sources, a typed string), previews live, and ends on Enter or Esc —
 *  so each one needs:
 *
 *  - **`value`**, the session or null when none is in progress. Null is the
 *    "no session" state for all five; none of them has a meaningful empty object.
 *  - **`ref`**, the same value readable from a stale closure. The global keydown
 *    handler is registered once and would otherwise see whatever session existed
 *    when it was registered, so it reads through here instead.
 *  - **`commitRef`**, a slot the commit function is written into once it exists.
 *    Commit needs the current document and the current session, so it is defined
 *    far below the key handler that calls it; the ref is what lets the handler call
 *    the latest version rather than close over an old one.
 *
 *  Destructure with the names the call site already uses — `const { value: foo,
 *  set: setFoo, ref: fooRef } = useSketchSession<T>()` — so the session reads the
 *  same everywhere and only its declaration is one line instead of three. */
export interface SketchSession<T> {
  value: T | null;
  set: React.Dispatch<React.SetStateAction<T | null>>;
  /** Always mirrors `value`; never write to this directly. */
  ref: React.MutableRefObject<T | null>;
  commitRef: React.MutableRefObject<() => void>;
}

export function useSketchSession<T>(): SketchSession<T> {
  const [value, set] = useState<T | null>(null);
  const ref = useRef<T | null>(value);
  // Mirrored during render, on purpose: the point is that `ref.current` is never
  // one render behind, so a handler reading it mid-gesture sees what the user sees.
  // An effect would update it a tick late, which is exactly the bug this avoids.
  ref.current = value;
  const commitRef = useRef<() => void>(() => {});
  return { value, set, ref, commitRef };
}
