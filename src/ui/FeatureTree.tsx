import { featureTypeLabel } from "../document/featureDefs";
import type { Document } from "../document/types";
import type { DatumId } from "../viewport/Viewport";
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
  onSetRollback: (index: number) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}

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
  onSetRollback,
  onMove,
}: Props) {
  const { features, rollbackIndex } = doc;

  return (
    <div className="tree" style={{ height }}>
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
        <RollbackGutter index={0} active={rollbackIndex === 0} onSet={onSetRollback} />
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
                  (feature.suppressed || rolledBack ? " dim" : "") +
                  (error ? " error" : "")
                }
                onClick={() => onSelect(feature.id)}
                onDoubleClick={() => onDoubleClick(feature.id)}
              >
                <span className="row-kind">{featureTypeLabel(feature)}</span>
                <span className="row-name">{feature.name}</span>
                {error && <span className="row-badge" title={error}>!</span>}
                {!error && warning && <span className="row-badge warn" title={warning}>⚠</span>}
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
                <button
                  className="row-icon"
                  title={feature.suppressed ? "Unsuppress (H)" : "Suppress (H): exclude from the model"}
                  // Eye (sketch): bright = visible, faded = hidden. Suppress icon
                  // (others): faded when active, bright when suppressed.
                  style={{
                    opacity:
                      feature.type === "sketch" || feature.type === "plane"
                        ? feature.suppressed ? 0.35 : 1
                        : feature.suppressed ? 1 : 0.35,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSuppress(feature.id);
                  }}
                >
                  {/* Sketches/planes produce no solid geometry, so suppress ≈ hide
                      → eye; everything else removes geometry from the model → a
                      distinct "disabled" icon. */}
                  {feature.type === "sketch" || feature.type === "plane" ? <EyeIcon /> : <SuppressIcon />}
                </button>
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
              <RollbackGutter
                index={i + 1}
                active={rollbackIndex === i + 1}
                onSet={onSetRollback}
              />
            </li>
          );
        })}
      </ol>

      {features.length === 0 && (
        <p className="hint">Use the viewport toolbar to add a sketch or solid.</p>
      )}
    </div>
  );
}

function RollbackGutter({
  index,
  active,
  onSet,
}: {
  index: number;
  active: boolean;
  onSet: (index: number) => void;
}) {
  return (
    <div
      className={"rollback-gutter" + (active ? " active" : "")}
      title={active ? "Rollback bar (drag features below are inactive)" : "Roll back to here"}
      onClick={() => onSet(index)}
    >
      <span className="rollback-line" />
    </div>
  );
}
