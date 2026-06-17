import { FEATURE_DEFS, FEATURE_KINDS } from "../document/featureDefs";
import type { Document, FeatureKind } from "../document/types";
import { EyeIcon } from "./icons";

interface Props {
  doc: Document;
  selectedIds: Set<string>;
  errors: Record<string, string>;
  onSelect: (id: string) => void;
  onAdd: (kind: FeatureKind) => void;
  onStartSketch: () => void;
  onDelete: (id: string) => void;
  onToggleSuppress: (id: string) => void;
  onSetRollback: (index: number) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}

export function FeatureTree({
  doc,
  selectedIds,
  errors,
  onSelect,
  onAdd,
  onStartSketch,
  onDelete,
  onToggleSuppress,
  onSetRollback,
  onMove,
}: Props) {
  const { features, rollbackIndex } = doc;

  return (
    <div className="tree">
      <button className="add-btn sketch-start" onClick={onStartSketch}>
        + Sketch
      </button>
      <div className="tree-add">
        {FEATURE_KINDS.map((kind) => (
          <button key={kind} className="add-btn" onClick={() => onAdd(kind)}>
            + {FEATURE_DEFS[kind].label}
          </button>
        ))}
      </div>

      <ol className="tree-list">
        <RollbackGutter index={0} active={rollbackIndex === 0} onSet={onSetRollback} />
        {features.map((feature, i) => {
          const rolledBack = i >= rollbackIndex;
          const error = errors[feature.id];
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
              >
                <span className="row-kind">
                  {feature.type === "sketch"
                    ? "Sketch"
                    : FEATURE_DEFS[feature.kind].label}
                </span>
                <span className="row-name">{feature.name}</span>
                {error && <span className="row-badge" title={error}>!</span>}
                <button
                  className="row-icon"
                  title="Move up"
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
                  title="Move down"
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
                  title={feature.suppressed ? "Unsuppress (show)" : "Suppress (hide)"}
                  style={{ opacity: feature.suppressed ? 0.35 : 1 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSuppress(feature.id);
                  }}
                >
                  <EyeIcon />
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
        <p className="hint">Add a feature above to start the timeline.</p>
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
