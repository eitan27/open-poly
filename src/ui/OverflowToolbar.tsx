import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreFlyout } from "./MoreFlyout";
import { fitCount, toRows, type ToolbarItem, type ToolbarRow } from "./toolbarOverflow";

interface Props {
  /** Toolbar class (e.g. "model-toolbar"), so each bar keeps its own look. */
  className: string;
  items: ToolbarItem[];
  /** The global "?" hint toggle — appends "(E)" to the button labels. */
  showShortcuts: boolean;
  /** Bump to toggle the More flyout from outside (the "/" shortcut). */
  openRequest?: number;
}

/**
 * A floating toolbar that never runs off the viewport: buttons that don't fit
 * collapse into a "More ▾" flyout listing the hidden ones, with a search box
 * that (once you type) searches every tool in the bar, arrow-navigable.
 *
 * Fitting is measured off a hidden mirror of the full button row (`.tb-mirror`)
 * rather than the live one, so the widths never depend on how many buttons are
 * currently shown — otherwise hiding a button would free up space, which would
 * show it again, and the layout would oscillate.
 */
export function OverflowToolbar({ className, items, showShortcuts, openRequest }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  /** The open ▾ dropdown, for its outside-click close. */
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [visibleCount, setVisibleCount] = useState(items.length);
  /** null = closed; otherwise the flyout's starting search text. */
  const [menuQuery, setMenuQuery] = useState<string | null>(null);
  const menuOpen = menuQuery !== null;

  // Button widths depend on the labels and the shortcut hints, nothing else —
  // re-measure when those change (and on every resize, below).
  const layoutKey =
    items.map((i) => `${i.icon}${i.label}${i.shortcut ?? ""}${i.choices ? "▾" : ""}`).join("|") +
    `#${showShortcuts}`;

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const bar = barRef.current;
    const mirror = mirrorRef.current;
    if (!wrap || !bar || !mirror) return;

    const measure = () => {
      const style = getComputedStyle(bar);
      const chrome =
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth);
      const gap = parseFloat(style.columnGap || style.gap) || 0;
      const kids = Array.from(mirror.children) as HTMLElement[];
      if (kids.length === 0) return;
      // The mirror renders the More button last, after every item.
      const moreWidth = kids[kids.length - 1].getBoundingClientRect().width;
      const widths = kids.slice(0, -1).map((k) => k.getBoundingClientRect().width);
      setVisibleCount(fitCount(widths, gap, wrap.clientWidth - chrome, moreWidth));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    ro.observe(mirror); // catches late font loads / label changes
    return () => ro.disconnect();
  }, [layoutKey]);

  const hidden = items.slice(visibleCount);
  const hiddenIds = new Set(hidden.map((i) => i.id));
  const allRows = toRows(items);
  // Closed-box default: the buttons you can't see. Typing searches the whole
  // bar — the flyout doubles as "find me the tool called…". Opened by "/" with
  // nothing hidden, it lists everything instead of nothing.
  const hiddenRows: ToolbarRow[] = hidden.length
    ? allRows.filter((r) => hiddenIds.has(r.itemId))
    : allRows;

  // Every tool in the bar is unavailable (the whole modeling toolbar greys out
  // while a sketch is being edited) → More greys out with them: there is
  // nothing behind it to reach.
  const allDisabled = allRows.length > 0 && allRows.every((r) => r.disabled);

  const closeMenu = () => setMenuQuery(null);
  const openMenu = (initialQuery = "") => setMenuQuery(initialQuery);

  useEffect(() => {
    if (allDisabled && menuOpen) closeMenu();
  }, [allDisabled]);

  // "/" from the app: toggle the flyout. It opens even when nothing is hidden
  // (there's no More button then) — as a plain "find me a tool" search.
  useEffect(() => {
    if (!openRequest || allDisabled) return;
    setMenuQuery((q) => (q === null ? "" : null));
  }, [openRequest]);

  // Nothing hidden any more (the window widened) → no More button to anchor
  // the flyout to.
  useEffect(() => {
    if (hidden.length === 0 && menuOpen) closeMenu();
  }, [hidden.length]);

  // A dropdown button (New Body) whose menu was opened by its keyboard shortcut
  // while the button itself is hidden: honour the keystroke by opening the
  // flyout pre-filtered to that button instead.
  const armedKey = hidden.map((i) => (i.choicesOpen ? i.id : "")).join(",");
  useEffect(() => {
    const armed = hidden.find((i) => i.choices && i.choicesOpen);
    if (!armed) return;
    armed.onChoicesOpenChange?.(false);
    openMenu(armed.label);
  }, [armedKey]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) closeMenu();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const openDropdown = items.find((i) => i.choices && i.choicesOpen);
  useEffect(() => {
    if (!openDropdown) return;
    const onDown = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) openDropdown.onChoicesOpenChange?.(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [openDropdown?.id]);

  const renderButton = (item: ToolbarItem, forMirror: boolean): ReactNode => {
    const label = (
      <>
        {item.icon} {item.label}
        {item.choices ? " ▾" : ""}
        {showShortcuts && item.shortcut ? <span className="kbd-hint">{item.shortcut}</span> : null}
      </>
    );
    if (item.choices) {
      const open = !forMirror && !!item.choicesOpen;
      return (
        <div className="mt-dropdown" key={item.id} ref={open ? dropdownRef : undefined}>
          <button
            title={item.title}
            disabled={item.disabled}
            tabIndex={forMirror ? -1 : undefined}
            aria-expanded={open}
            onClick={() => item.onChoicesOpenChange?.(!item.choicesOpen)}
          >
            {label}
          </button>
          {open && (
            <div className="mt-menu">
              {item.choices.map((c) => (
                <button
                  key={c.id}
                  disabled={c.disabled}
                  onClick={() => {
                    item.onChoicesOpenChange?.(false);
                    c.onSelect();
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }
    return (
      <button
        key={item.id}
        title={item.title}
        disabled={item.disabled}
        tabIndex={forMirror ? -1 : undefined}
        onClick={item.onSelect}
      >
        {label}
      </button>
    );
  };

  return (
    // The wrapper spans the width the bar is allowed to use (the bar itself is
    // only as wide as its buttons); it's what the ResizeObserver watches.
    <div className={`tb-wrap ${className}-wrap`} ref={wrapRef}>
      <div className={className} ref={barRef}>
        {/* The frosted panel, as a child layer — see .tb-blur in App.css for why
            the blur can't sit on the bar itself. */}
        <div className="tb-blur" />
        {items.slice(0, visibleCount).map((item) => renderButton(item, false))}
        {(hidden.length > 0 || menuOpen) && (
          <div className="tb-more" ref={moreRef}>
            {hidden.length > 0 && <button
              className="tb-more-btn"
              title={`${hidden.length} more tool${hidden.length === 1 ? "" : "s"} — click to search all tools`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={allDisabled}
              onClick={() => (menuOpen ? closeMenu() : openMenu())}
            >
              More ▾{showShortcuts ? <span className="kbd-hint">/</span> : null}
            </button>}
            {menuOpen && (
              // Keyed by the starting query so re-opening it pre-filtered (the
              // hidden-dropdown shortcut, below) remounts with that text.
              <MoreFlyout
                key={menuQuery}
                className="tb-more-menu"
                rows={allRows}
                defaultRows={hiddenRows}
                initialQuery={menuQuery}
                onRun={(row) => row.onSelect()}
                onClose={closeMenu}
              />
            )}
          </div>
        )}
        {/* Measured, never seen: the full row at its natural width. */}
        <div className="tb-mirror" ref={mirrorRef} aria-hidden>
          {items.map((item) => renderButton(item, true))}
          <button className="tb-more-btn" tabIndex={-1}>
            More ▾{showShortcuts ? <span className="kbd-hint">/</span> : null}
          </button>
        </div>
      </div>
    </div>
  );
}
