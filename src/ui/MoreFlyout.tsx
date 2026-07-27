import { useEffect, useRef, useState } from "react";
import { nextEnabledIndex, searchRows, type ToolbarRow } from "./toolbarOverflow";

interface Props {
  /** Every tool in the bar — what the search box searches. */
  rows: ToolbarRow[];
  /** What to list before anything is typed: the tools you can't see. */
  defaultRows: ToolbarRow[];
  /** Placement class for the popup (each bar anchors its own). */
  className: string;
  /** Pre-filled search text (a hidden dropdown reached by its shortcut). */
  initialQuery?: string;
  /** Names what's being searched — each bar holds a different set of tools. */
  placeholder?: string;
  onRun: (row: ToolbarRow) => void;
  onClose: () => void;
}

/**
 * The "More ▾" popup shared by the horizontal and vertical toolbars: hidden
 * tools by default, every tool once you type, arrow-navigable (disabled tools
 * are listed — they're still discoverable — but skipped and unselectable).
 */
export function MoreFlyout({
  rows,
  defaultRows,
  className,
  initialQuery = "",
  placeholder = "Search tools…",
  onRun,
  onClose,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = query.trim() ? searchRows(rows, query) : defaultRows;

  // Keep the highlight on a row that exists and can be picked.
  useEffect(() => {
    setActive((a) => (shown[a] && !shown[a].disabled ? a : nextEnabledIndex(shown, -1, 1)));
  }, [query, shown.length]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (row: ToolbarRow) => {
    if (row.disabled) return;
    onClose();
    onRun(row);
  };

  return (
    <div className={className}>
      <input
        className="tb-more-search"
        autoFocus
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => nextEnabledIndex(shown, a, e.key === "ArrowDown" ? 1 : -1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (shown[active]) run(shown[active]);
          } else if (e.key === "Escape") {
            // Stop the app's global Esc chain from also firing — closing the
            // flyout is the whole of this keystroke.
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="tb-more-list" ref={listRef}>
        {shown.map((row, i) => (
          <button
            key={row.id}
            className={i === active ? "active" : ""}
            title={row.title}
            disabled={row.disabled}
            // Mouse MOVE (not enter) so arrowing through the list under a
            // resting cursor doesn't lose the highlight.
            onMouseMove={() => !row.disabled && setActive(i)}
            // Mouse down so the search field doesn't blur first.
            onMouseDown={(e) => {
              e.preventDefault();
              run(row);
            }}
          >
            <span className="tb-row-icon">{row.icon}</span>
            <span className="tb-row-label">{row.label}</span>
            {row.shortcut && <span className="tb-row-kbd">{row.shortcut}</span>}
          </button>
        ))}
        {shown.length === 0 && <div className="tb-more-empty">No matching tool</div>}
      </div>
    </div>
  );
}
