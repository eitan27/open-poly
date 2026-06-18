import type { BooleanFeature, Document, PrimitiveFeature } from "../document/types";

interface Props {
  doc: Document;
  selectedIds: Set<string>;
  /** Ids consumed as an operand by some active boolean — these are still real
   *  features (other booleans may reuse them) but shouldn't get their own row. */
  consumedIds: Set<string>;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onColorChange: (id: string, color: number) => void;
  onOpacityChange: (id: string, opacity: number) => void;
  onExportStep: (id: string) => void;
  onExportStl: (id: string) => void;
}

const toHex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

function isSolid(f: Document["features"][number]): f is PrimitiveFeature | BooleanFeature {
  return f.type === "primitive" || f.type === "boolean";
}

export function SolidsList({
  doc,
  selectedIds,
  consumedIds,
  onSelect,
  onRename,
  onDelete,
  onColorChange,
  onOpacityChange,
  onExportStep,
  onExportStl,
}: Props) {
  const solids = doc.features.filter((f) => isSolid(f) && !consumedIds.has(f.id));

  if (solids.length === 0) {
    return <p className="hint">No solids yet — add a primitive above.</p>;
  }

  return (
    <div className="tree-list solids-list">
      {solids.map((f) => (
        <div
          key={f.id}
          className={
            "solid-row" +
            (selectedIds.has(f.id) ? " selected" : "") +
            (f.suppressed ? " dim" : "")
          }
          onClick={() => onSelect(f.id)}
        >
          <input
            type="color"
            className="solid-color"
            value={toHex(f.color)}
            title="Body color"
            onChange={(e) => onColorChange(f.id, parseInt(e.target.value.slice(1), 16))}
          />
          <input
            className="solid-name"
            value={f.name}
            title={f.name}
            onChange={(e) => onRename(f.id, e.target.value)}
          />
          <input
            type="range"
            className="solid-opacity"
            min={0}
            max={1}
            step={0.05}
            value={f.opacity}
            title={`Opacity ${Math.round(f.opacity * 100)}%`}
            onChange={(e) => onOpacityChange(f.id, Number(e.target.value))}
          />
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
