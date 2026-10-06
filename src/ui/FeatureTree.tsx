import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { featureTypeLabel } from "../document/featureDefs";
import type { Document } from "../document/types";
import type { DatumId } from "../selection/types";
import { EyeIcon, SuppressIcon } from "./icons";

interface Props {
  doc: Document;
  height: number;
  /** The fixed base datums (origin + standard planes), shown atop the timeline
   *  as non-removable, non-suppressable rows with only a visibility toggle. */
  datums: { id: DatumId; kind: string; label: string }[];
  datumVisibility: Record<DatumId, boolean>;
  onToggleDatum: (id: DatumId) => void;
  selectedIds: Set<string>;
  errors: Record<string, string>;
  /** Non-fatal kernel notices (a topological reference re-matched after an
   *  upstream edit, or partially lost) — an amber badge, not a red one. */
  warnings: Record<string, string>;
  onSelect: (id: string) => void;
  onDoubleClick: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleSuppress: (id: string) => void;
  /** Reference planes hide rather than suppress: a view toggle that leaves the
   *  plane in the model, so sketches and features built on it keep resolving. */
  onToggleHidden: (id: string, hidden: boolean) => void;
  /** Move the rollback bar. `dragging` marks the rapid updates of a scrub, so
   *  the whole drag collapses into one undo step. */
  onSetRollback: (index: number, dragging?: boolean) => void;
  /** The kernel is rebuilding. Shown on the rollback grip, which is where the
   *  eye already is right after a scrub. */
  busy: boolean;
  onMove: (id: string, delta: -1 | 1) => void;
}

/** How close to the panel edge a drag must get before the list scrolls itself,
 *  and the most it scrolls per frame at the very edge. */
const EDGE_BAND = 28;
const EDGE_SPEED = 14;

export function FeatureTree({
  doc,
  height,
  datums,
  datumVisibility,
  onToggleDatum,
  selectedIds,
  errors,
  warnings,
  onSelect,
  onDoubleClick,
  onDelete,
  onToggleSuppress,
  onToggleHidden,
  onSetRollback,
  onMove,
  busy,
}: Props) {
  const { features, rollbackIndex } = doc;
  const treeRef = useRef<HTMLDivElement>(null);
  // Only drives the cursor + the "every insertion point is a target" styling.
  // The bar's POSITION isn't previewed state: a scrub commits as it goes, so the
  // model rolls with the bar and the dimming below it is the real feedback.
  const [dragging, setDragging] = useState(false);
  // Read inside effects that must not fight the drag (which owns the scroll
  // while it runs); state alone would be a render behind.
  const draggingRef = useRef(false);

  /** Keep the bar in view, sitting no higher than the middle of the panel — so
   *  at most half the visible timeline is the inactive tail below it. Runs when
   *  the bar moves or the timeline grows (and on mount), never during a drag,
   *  which does its own edge-scrolling. Clamping handles both ends for free: a
   *  bar at the very end lands on a fully-scrolled list, and one near the top
   *  can't be pushed below the middle, so the list simply sits at the top. */
  useEffect(() => {
    const el = treeRef.current;
    if (!el || draggingRef.current) return;
    const bar = el.querySelector<HTMLElement>(`[data-rollback-index="${rollbackIndex}"]`);
    if (!bar) return;
    // Measured through rects, not `offsetTop`: the gutter is positioned, so its
    // offsetParent is whatever ancestor happens to be positioned too — not the
    // scroller — and offsetTop would be relative to the wrong box.
    const barY = bar.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop + bar.offsetHeight / 2;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.max(0, Math.min(barY - el.clientHeight / 2, max));
  }, [rollbackIndex, features.length, height]);

  /** Where every insertion point sits on screen, measured from the DOM. Rows
   *  don't move during a scrub (they only dim), so one measurement holds for the
   *  whole drag — re-taken if the list scrolls under the pointer. */
  const measureStops = () => {
    const el = treeRef.current;
    if (!el) return [];
    return [...el.querySelectorAll<HTMLElement>("[data-rollback-index]")].map((g) => {
      const r = g.getBoundingClientRect();
      return { index: Number(g.dataset.rollbackIndex), y: r.top + r.height / 2 };
    });
  };

  const startRollbackDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // the gutter's own click must not also fire
    const tree = treeRef.current;
    let stops = measureStops();
    if (!tree || stops.length === 0) return;
    setDragging(true);
    draggingRef.current = true;
    let landed = rollbackIndex;
    let pointerY = e.clientY;
    const remeasure = () => {
      stops = measureStops();
    };
    const snap = () => {
      let best = stops[0];
      for (const s of stops) if (Math.abs(s.y - pointerY) < Math.abs(best.y - pointerY)) best = s;
      // Commit only when the nearest stop CHANGES, so a scrub is one regen per
      // position rather than one per pointer event.
      if (best.index !== landed) {
        landed = best.index;
        onSetRollback(best.index, true);
      }
    };
    // Held near an edge, the list scrolls itself — otherwise a timeline taller
    // than its panel can only be scrubbed as far as the visible rows. Speed
    // ramps with how far into the edge band the pointer is, so it creeps at the
    // boundary and moves at the very edge. The scroll fires `remeasure` through
    // the listener below, so the stops stay true as the list moves.
    let raf = 0;
    const autoScroll = () => {
      const r = tree.getBoundingClientRect();
      const into =
        pointerY < r.top + EDGE_BAND
          ? -(r.top + EDGE_BAND - pointerY) / EDGE_BAND
          : pointerY > r.bottom - EDGE_BAND
            ? (pointerY - (r.bottom - EDGE_BAND)) / EDGE_BAND
            : 0;
      if (into !== 0) {
        const before = tree.scrollTop;
        tree.scrollTop += Math.sign(into) * Math.ceil(Math.min(Math.abs(into), 1) * EDGE_SPEED);
        if (tree.scrollTop !== before) {
          stops = measureStops();
          snap();
        }
      }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);

    const move = (ev: globalThis.PointerEvent) => {
      pointerY = ev.clientY;
      snap();
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      setDragging(false);
      draggingRef.current = false;
      tree.removeEventListener("scroll", remeasure);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    tree.addEventListener("scroll", remeasure);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  // Arrow keys nudge the bar one feature at a time — the same control, reachable
  // without a pointer. Moving it renders the grip into a DIFFERENT gutter, which
  // unmounts the focused node, so a keyboard move re-takes focus on the new one;
  // without this the bar could be nudged exactly once.
  const gripRef = useRef<HTMLSpanElement>(null);
  const refocusGrip = useRef(false);
  useEffect(() => {
    if (!refocusGrip.current) return;
    refocusGrip.current = false;
    gripRef.current?.focus();
  }, [rollbackIndex]);

  const onGripKey = (e: React.KeyboardEvent) => {
    const to =
      e.key === "ArrowUp"
        ? rollbackIndex - 1
        : e.key === "ArrowDown"
          ? rollbackIndex + 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? features.length
              : null;
    if (to === null) return;
    e.preventDefault();
    refocusGrip.current = true;
    onSetRollback(to);
  };

  const gutterProps = (index: number) => ({
    index,
    active: rollbackIndex === index,
    total: features.length,
    dragging,
    onSet: onSetRollback,
    onGrab: startRollbackDrag,
    onGripKey,
    gripRef,
    busy,
  });

  return (
    <div className={"tree" + (dragging ? " rollback-dragging" : "")} style={{ height }} ref={treeRef}>
      <ol className="tree-list">
        {/* Fixed base datums — always first, above the rollback bar so they're
            never rolled back, and with no move/delete/suppress affordances. */}
        {datums.map((d) => {
          const visible = datumVisibility[d.id];
          return (
            <li key={d.id}>
              <div className={"tree-row datum-row" + (visible ? "" : " dim")}>
                <span className="row-kind">{d.kind}</span>
                <span className="row-name">{d.label}</span>
                <button
                  className="row-icon"
                  title={visible ? "Hide" : "Show"}
                  style={{ opacity: visible ? 1 : 0.35 }}
                  onClick={() => onToggleDatum(d.id)}
                >
                  <EyeIcon />
                </button>
              </div>
            </li>
          );
        })}
        <RollbackGutter {...gutterProps(0)} />
        {features.map((feature, i) => {
          const rolledBack = i >= rollbackIndex;
          const error = errors[feature.id];
          const warning = warnings[feature.id];
          return (
            <li key={feature.id}>
              <div
                className={
                  "tree-row" +
                  (selectedIds.has(feature.id) ? " selected" : "") +
                  (feature.suppressed || rolledBack || (feature.type === "plane" && feature.hidden) ? " dim" : "") +
                  (error ? " error" : "")
                }
                onClick={() => onSelect(feature.id)}
                onDoubleClick={() => onDoubleClick(feature.id)}
              >
                <span className="row-kind">{featureTypeLabel(feature)}</span>
                <span className="row-name">{feature.name}</span>
                {error && (
                  <span className="row-badge" title={error}>
                    !
                  </span>
                )}
                {!error && warning && (
                  <span className="row-badge warn" title={warning}>
                    ⚠
                  </span>
                )}
                <button
                  className="row-icon"
                  title="Move up (Alt+↑)"
                  disabled={i === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(feature.id, -1);
                  }}
                >
                  ▲
                </button>
                <button
                  className="row-icon"
                  title="Move down (Alt+↓)"
                  disabled={i === features.length - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMove(feature.id, 1);
                  }}
                >
                  ▼
                </button>
                {/* A reference plane hides rather than suppresses: hiding is a
                    view toggle, so sketches and features built on the plane keep
                    resolving instead of breaking the model. */}
                {feature.type === "plane" ? (
                  <button
                    className="row-icon"
                    title={feature.hidden ? "Show" : "Hide"}
                    style={{ opacity: feature.hidden ? 0.35 : 1 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleHidden(feature.id, !feature.hidden);
                    }}
                  >
                    <EyeIcon />
                  </button>
                ) : (
                  <button
                    className="row-icon"
                    title={feature.suppressed ? "Unsuppress (H)" : "Suppress (H): exclude from the model"}
                    // Eye (sketch): bright = visible, faded = hidden. Suppress icon
                    // (others): faded when active, bright when suppressed.
                    style={{
                      opacity:
                        feature.type === "sketch" ? (feature.suppressed ? 0.35 : 1) : feature.suppressed ? 1 : 0.35,
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSuppress(feature.id);
                    }}
                  >
                    {/* Sketches produce no solid geometry, so suppress ≈ hide →
                        eye; everything else removes geometry from the model → a
                        distinct "disabled" icon. */}
                    {feature.type === "sketch" ? <EyeIcon /> : <SuppressIcon />}
                  </button>
                )}
                <button
                  className="row-icon"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(feature.id);
                  }}
                >
                  ✕
                </button>
              </div>
              <RollbackGutter {...gutterProps(i + 1)} />
            </li>
          );
        })}
      </ol>

      {features.length === 0 && <p className="hint">Use the viewport toolbar to add a sketch or solid.</p>}
    </div>
  );
}

/** One insertion point between two timeline rows. Every gutter is a click
 *  target ("roll back to here"); the one the bar sits on also carries the grip
 *  you drag, and — while dragging — a chip counting the features still active,
 *  so a scrub says which point in time it has reached, not just where the line
 *  landed. */
function RollbackGutter({
  index,
  active,
  total,
  dragging,
  onSet,
  onGrab,
  onGripKey,
  gripRef,
  busy,
}: {
  index: number;
  active: boolean;
  total: number;
  dragging: boolean;
  onSet: (index: number, dragging?: boolean) => void;
  onGrab: (e: ReactPointerEvent<HTMLElement>) => void;
  onGripKey: (e: React.KeyboardEvent) => void;
  gripRef: React.RefObject<HTMLSpanElement | null>;
  busy: boolean;
}) {
  return (
    <div
      className={"rollback-gutter" + (active ? " active" : "")}
      data-rollback-index={index}
      title={active ? undefined : "Roll back to here"}
      onClick={() => onSet(index)}
    >
      <span className="rollback-line" />
      {active && (
        <span
          ref={gripRef}
          className={"rollback-grip" + (busy ? " busy" : "")}
          role="slider"
          tabIndex={0}
          aria-label="Rollback bar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={index}
          aria-valuetext={`${index} of ${total} features active`}
          title="Drag to roll the model back or forward (↑/↓)"
          onPointerDown={onGrab}
          onKeyDown={onGripKey}
          onClick={(e) => e.stopPropagation()}
        >
          {/* At rest, the two rules that read as "draggable"; while the kernel
              rebuilds, they give way to a sweep, so the wait is reported where
              the hand already is instead of only up in the status chip. */}
          <span className="rollback-grip-bars" aria-hidden="true" />
        </span>
      )}
      {active && dragging && (
        <span className="rollback-count" aria-hidden="true">
          {index} / {total}
        </span>
      )}
    </div>
  );
}
