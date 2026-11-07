import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Vec2 } from "../document/types";
import { draftCursorStore } from "./draftCursorStore";
import { formatRounded3 } from "../lib/format";
import { DimValueInput, type VarOption } from "./DimValueInput";
import "./DraftSizeField.css";

interface Props {
  /** The placed circle centre (uv). */
  center: Vec2;
  kind: "radius" | "diameter";
  /** What the user has typed; empty = follow the cursor. */
  value: string;
  onChange: (v: string) => void;
  onToggleKind: () => void;
  onSubmit: () => void;
  variables: VarOption[];
}

/** The size field that rides beside the cursor once a circle's centre is down.
 *  It is focused from the start and styled as an active input (accent ring), and
 *  until something is typed it shows the live size as grey placeholder text
 *  behind a blinking caret — so it reads as "type here to set the size". Typing
 *  replaces the placeholder and fixes the preview at that size; Tab swaps R ↔ Ø;
 *  Enter places the circle. Escape is the app's cancel chain (clear the typed
 *  value, then the centre). */
export function DraftSizeField({ center, kind, value, onChange, onToggleKind, onSubmit, variables }: Props) {
  const cursor = useSyncExternalStore(draftCursorStore.subscribe, draftCursorStore.get);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep the keyboard here while the field is up: a canvas click or an orbit
  // drag steals focus to the page, after which typing would fire sketch
  // shortcuts instead. Only reclaim it from the page itself — focus that moved
  // to another control (a toolbar button, a dialog field) stays there.
  const reclaim = () => {
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!wrapRef.current || wrapRef.current.contains(a)) return;
      if (a === document.body || a instanceof HTMLCanvasElement) wrapRef.current.querySelector("input")?.focus();
    });
  };
  useEffect(() => {
    const onUp = () => reclaim();
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, []);

  if (!cursor) return null;
  const r = Math.hypot(cursor.uv[0] - center[0], cursor.uv[1] - center[1]);
  const live = formatRounded3(kind === "diameter" ? 2 * r : r);
  const typed = value.trim() !== "";

  return (
    <div
      ref={wrapRef}
      className={`draft-size${typed ? " typed" : ""}`}
      style={{ left: cursor.x, top: cursor.y }}
      data-testid="circle-size-field"
      onBlur={reclaim}
    >
      <div className="draft-size-box">
        <span className="draft-size-kind" title={kind === "diameter" ? "Diameter" : "Radius"}>
          {kind === "diameter" ? "Ø" : "R"}
        </span>
        <DimValueInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onCancel={() => {}}
          onTab={onToggleKind}
          placeholder={live}
          variables={variables}
        />
      </div>
      <div className="draft-size-hint">
        {typed ? (
          <>
            <kbd>Enter</kbd> to place · <kbd>Esc</kbd> to clear
          </>
        ) : (
          <>
            Type a {kind} · <kbd>Tab</kbd> {kind === "diameter" ? "Ø → R" : "R → Ø"}
          </>
        )}
      </div>
    </div>
  );
}
