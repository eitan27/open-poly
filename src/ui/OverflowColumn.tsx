import {
  cloneElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { SearchIcon } from "./icons";
import { MoreFlyout } from "./MoreFlyout";
import { fitCount, type ToolbarRow } from "./toolbarOverflow";

/** One entry in a vertical toolbar: the element itself, plus how it appears in
 *  the More flyout when it doesn't fit. */
export interface ColumnSlot {
  id: string;
  /** Rendered into the bar as-is (cloned only to add a `visibility` style). */
  node: ReactElement<{ style?: CSSProperties }>;
  /** Rows the flyout lists/searches for this slot. A slot with none (a
   *  separator, a status badge) just disappears when it doesn't fit. */
  rows: ToolbarRow[];
}

interface Props {
  /** Bar class (e.g. "sketch-toolbar"), so it keeps its own look. */
  className: string;
  slots: ColumnSlot[];
  /** Gap to leave below the bar, in px. */
  bottomMargin?: number;
  /** Bump to toggle the More flyout from outside (the "/" shortcut). */
  openRequest?: number;
  /** The global "?" hint toggle — appends "(/)" to the More button. */
  showShortcuts?: boolean;
  /** Search box placeholder, naming this bar's tools. */
  searchPlaceholder?: string;
}

/**
 * The vertical counterpart of OverflowToolbar: a floating column that never
 * runs off the bottom of the window. Slots that don't fit are left in the DOM
 * but made `visibility: hidden` — they keep their layout boxes, so measuring
 * stays stable no matter how many are showing (the horizontal bar needs a
 * hidden mirror for the same reason) — and the column is given the exact height
 * of what fits, so its panel still ends in a clean rounded edge. The hidden
 * tools move into a "More" flyout pinned to the bottom of the column, opening
 * beside it. The button is always there — with nothing hidden it opens as a
 * plain "find me a tool" search — so room for it is always reserved.
 */
export function OverflowColumn({
  className,
  slots,
  bottomMargin = 12,
  openRequest,
  showShortcuts,
  searchPlaceholder,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ count: number; height: number } | null>(null);
  /** null = closed; otherwise the flyout's starting search text. */
  const [menuQuery, setMenuQuery] = useState<string | null>(null);
  const menuOpen = menuQuery !== null;

  const visibleCount = fit ? fit.count : slots.length;
  const hidden = slots.slice(visibleCount);
  const hasHidden = hidden.length > 0;

  // Measure after every render (slot list, labels and the panel's position can
  // all change) and on resize; the state write is guarded so it settles.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;

    const measure = () => {
      const style = getComputedStyle(bar);
      const padTop = parseFloat(style.paddingTop);
      const chrome =
        padTop +
        parseFloat(style.paddingBottom) +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth);
      const gap = parseFloat(style.rowGap || style.gap) || 0;
      // Slot elements only — the More button and its flyout are out of flow.
      const kids = (Array.from(bar.children) as HTMLElement[]).filter((el) => el.dataset.slot === "1");
      if (kids.length === 0) return;
      const barTop = bar.getBoundingClientRect().top;
      // OUTER heights: a slot may carry margins (the separators do), and leaving
      // them out made the column short by exactly that much — clipping the last
      // button whenever everything "fit".
      const boxes = kids.map((k) => {
        const r = k.getBoundingClientRect();
        const cs = getComputedStyle(k);
        const marginBottom = parseFloat(cs.marginBottom);
        return { outer: r.height + parseFloat(cs.marginTop) + marginBottom, bottom: r.bottom + marginBottom - barTop };
      });
      // The column is anchored at the top; what's left is the window below it.
      const avail = window.innerHeight - barTop - bottomMargin - chrome;
      const moreHeight = moreRef.current?.getBoundingClientRect().height ?? boxes[0].outer;
      const count = fitCount(
        boxes.map((b) => b.outer),
        gap,
        avail,
        moreHeight,
      );
      // Height straight off the last visible slot's measured bottom, rather than
      // re-adding the parts — whatever the layout actually did (margins, gaps,
      // sub-pixel rounding) is already in that number.
      const contentBottom =
        count > 0 ? boxes[count - 1].bottom : parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
      // The More button is always pinned below the last visible slot, so its
      // row is always part of the column's height.
      const height =
        contentBottom + gap + moreHeight + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
      setFit((f) => (f && f.count === count && Math.abs(f.height - height) < 0.5 ? f : { count, height }));
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });

  const closeMenu = () => setMenuQuery(null);

  // "/" from the app: toggle the flyout. With nothing hidden it opens as a
  // plain "find me a tool" search over the whole bar.
  useEffect(() => {
    if (!openRequest) return;
    setMenuQuery((q) => (q === null ? "" : null));
  }, [openRequest]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // The popup is a sibling of the button, not a child — so test for it by
      // class as well, or clicking into its search box would close it.
      if (moreRef.current?.contains(target) || target.closest?.(".tb-more-menu")) return;
      closeMenu();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const allRows = slots.flatMap((s) => s.rows);
  // Opened by "/" with nothing hidden, the flyout lists every tool rather than
  // an empty box.
  const hiddenRows = hasHidden ? hidden.flatMap((s) => s.rows) : allRows;

  return (
    // The flyout is a SIBLING of the column, not a child: it is wider than the
    // column, and anchoring it inside would land it on top of the visible tools
    // instead of beside them.
    <div className={`tbc-wrap ${className}-wrap`} ref={wrapRef}>
      <div className={className} ref={barRef} style={fit ? { height: fit.height } : undefined}>
        {/* The frosted panel, as a child layer — see .tb-blur in App.css for why
            the blur can't sit on the bar itself. */}
        <div className="tb-blur" />
        {slots.map((slot, i) =>
          cloneElement(slot.node, {
            key: slot.id,
            "data-slot": "1",
            style: i < visibleCount ? slot.node.props.style : { ...slot.node.props.style, visibility: "hidden" },
          } as Partial<{ style?: CSSProperties }>),
        )}
        <div className="tbc-more" ref={moreRef}>
          <button
            className={"tbc-more-btn" + (menuOpen ? " expanded" : "")}
            title={
              hasHidden
                ? `${hiddenRows.length} more tool${hiddenRows.length === 1 ? "" : "s"} — click to search all tools`
                : "Search all tools"
            }
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? closeMenu() : setMenuQuery(""))}
          >
            {/* Just the magnifier: this opens a search box, not one of the
                variant flyouts the ▸ arrows mark. */}
            <SearchIcon size={15} />
            {showShortcuts ? <span className="kbd-hint">/</span> : null}
          </button>
        </div>
      </div>
      {menuOpen && (
        <MoreFlyout
          key={menuQuery}
          className="tb-more-menu tbc-more-menu"
          rows={allRows}
          defaultRows={hiddenRows}
          initialQuery={menuQuery}
          placeholder={searchPlaceholder}
          onRun={(row) => row.onSelect()}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
