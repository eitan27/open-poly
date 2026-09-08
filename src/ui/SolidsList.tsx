import type { Document } from "../document/types";
import { colorToHex, DEFAULT_SOLID_COLOR } from "../document/colors";
import { featureIdOfPart, partAppearance } from "../document/parts";
import { EyeIcon } from "./icons";

interface Props {
  doc: Document;
  /** Every rendered part, in build order. A part id is the id of the feature
   *  that produced it, or `<featureId>#<n>` for the 2nd, 3rd… disjoint solid of
   *  that feature's result (see document/parts.ts). */
  partIds: string[];
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onColorChange: (id: string, color: number) => void;
  onOpacityChange: (id: string, opacity: number) => void;
  onToggleHidden: (id: string, hidden: boolean) => void;
  onExportStep: (id: string) => void;
  onExportStl: (id: string) => void;
  /** The body currently isolated (only it is shown), or null. */
  isolatedId: string | null;
  onIsolate: (id: string) => void;
}

export function SolidsList({
  doc,
  partIds,
  selectedIds,
  onSelect,
  onRename,
  onDelete,
  onColorChange,
  onToggleHidden,
  onExportStep,
  onExportStl,
  isolatedId,
  onIsolate,
}: Props) {
  // One row per rendered PART, not per feature: a feature that produced three
  // disjoint solids has three rows, each with its own colour, name and eye. A
  // body consumed by a boolean isn't in `partIds` (the fold removed it), so this
  // also excludes operands. Parts whose feature doesn't own an appearance are
  // dropped, as they always were — an in-place modifier's body is listed under
  // the feature that created it, not the one that last touched it.
  const solids = partIds
    .map((id) => ({ id, ...partAppearance(doc, id, DEFAULT_SOLID_COLOR) }))
    .filter((p) => p.owned)
    .map((p) => ({
      ...p,
      suppressed: !!doc.features.find((f) => f.id === featureIdOfPart(p.id))?.suppressed,
    }));

  if (solids.length === 0) {
    return <p className="hint">No parts yet — add a primitive or extrude above.</p>;
  }

  return (
    <div className="tree-list solids-list">
      {solids.map((f) => (
        <div
          key={f.id}
          className={
            "solid-row" + (selectedIds.has(f.id) ? " selected" : "") + (f.suppressed || f.hidden ? " dim" : "")
          }
          onClick={() => onSelect(f.id)}
        >
          <input
            type="color"
            className="solid-color"
            value={colorToHex(f.color)}
            title="Body color"
            onChange={(e) => onColorChange(f.id, parseInt(e.target.value.slice(1), 16))}
          />
          <input
            className="solid-name"
            value={f.name}
            title={f.name}
            onChange={(e) => onRename(f.id, e.target.value)}
          />
          <button
            className="row-icon"
            type="button"
            title={f.hidden ? "Show" : "Hide"}
            style={{ opacity: f.hidden ? 0.35 : 1 }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleHidden(f.id, !f.hidden);
            }}
          >
            <EyeIcon />
          </button>
          <button
            className={"row-icon" + (isolatedId === f.id ? " active" : "")}
            type="button"
            title={isolatedId === f.id ? "Exit isolate" : "Isolate (show only this)"}
            onClick={(e) => {
              e.stopPropagation();
              onIsolate(f.id);
            }}
          >
            ◎
          </button>
          <button
            className="row-icon export-btn"
            type="button"
            title="Export STEP"
            onClick={(e) => {
              e.stopPropagation();
              onExportStep(f.id);
            }}
          >
            STEP
          </button>
          <button
            className="row-icon export-btn"
            type="button"
            title="Export STL"
            onClick={(e) => {
              e.stopPropagation();
              onExportStl(f.id);
            }}
          >
            STL
          </button>
          <button
            className="row-icon"
            type="button"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(f.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
