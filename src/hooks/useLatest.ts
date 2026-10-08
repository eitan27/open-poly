import { useRef } from "react";

/** A ref that always holds the current `value`.
 *
 *  For the case an effect needs to READ something without being woken by it. The
 *  alternative is a narrower dependency array than the effect's body justifies,
 *  which is what `exhaustive-deps` is complaining about whenever it names a
 *  dependency that would be wrong to add — a nonce-triggered effect that must not
 *  re-run when an unrelated flag flips, or one keyed on an id while it reads the
 *  object that id belongs to.
 *
 *  Mirrored during render rather than in an effect, so a handler called between
 *  renders is never one behind. `useSketchSession` and `useShortcutHandler` both do
 *  this for the same reason; this is the one-line version for everything else. */
export function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
