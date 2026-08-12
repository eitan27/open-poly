import type {
  BooleanFeature,
  Document,
  ExtrudeFeature,
  Feature,
  ImportFeature,
  LoftFeature,
  MirrorFeature,
  PatternFeature,
  PrimitiveFeature,
  RevolveFeature,
  SweepFeature,
  TransformFeature,
} from "../document/types";
import { colorToHex } from "../document/colors";
import { EyeIcon } from "./icons";

interface Props {
  doc: Document;
  /** Feature ids that produced an actual rendered body (primitives, "new"
   *  extrusions, add-targets that kept their id). */
  bodyIds: Set<string>;
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

/** A feature that owns a body's appearance (color/opacity). A copy-transform
 *  produces a body keyed by its own id; an in-place transform doesn't (its body
 *  keeps the target's id), so the bodyIds filter naturally excludes it. */
type SolidFeature =
  | PrimitiveFeature
  | ExtrudeFeature
  | BooleanFeature
  | TransformFeature
  | MirrorFeature
  | PatternFeature
  | RevolveFeature
  | SweepFeature
  | LoftFeature
  | ImportFeature;
function isSolidFeature(f: Feature): f is SolidFeature {
  return (
    f.type === "primitive" ||
    f.type === "extrude" ||
    f.type === "boolean" ||
    f.type === "transform" ||
    f.type === "mirror" ||
    f.type === "pattern" ||
    f.type === "revolve" ||
    f.type === "sweep" ||
    f.type === "loft" ||
    f.type === "import"
  );
}

export function SolidsList({
  doc,
  bodyIds,
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
  // List the features that have a rendered body and own its appearance. A body
  // consumed by a boolean isn't in `bodyIds` (the fold removed it), so this also
  // excludes operands.
  const solids = doc.features.filter((f): f is SolidFeature => bodyIds.has(f.id) && isSolidFeature(f));

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
