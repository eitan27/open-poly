import { FEATURE_DEFS } from "../document/featureDefs";
import { planeRefLabel } from "../document/planes";
import type { Feature } from "../document/types";

interface Props {
  feature: Feature | null;
  error: string | null;
  editingSketchId: string | null;
  onChangeParam: (id: string, name: string, value: string) => void;
  onRename: (id: string, name: string) => void;
  onEditSketch: (id: string) => void;
  onFinishSketch: () => void;
}

export function ParamEditor({
  feature,
  error,
  editingSketchId,
  onChangeParam,
  onRename,
  onEditSketch,
  onFinishSketch,
}: Props) {
  if (!feature) {
    return (
      <div className="params">
        <p className="hint">Select a feature to edit its parameters.</p>
      </div>
    );
  }

  return (
    <div className="params">
      <input
        className="param-name-input"
        value={feature.name}
        onChange={(e) => onRename(feature.id, e.target.value)}
      />
      {feature.type === "extrude" ? (
        <div className="sketch-params">
          <label className="param-field">
            <span className="param-label">Mode</span>
            <select
              className="param-input"
              value={feature.mode}
              onChange={(e) => onChangeParam(feature.id, "mode", e.target.value)}
            >
              <option value="new">New</option>
              <option value="add">Add</option>
              <option value="remove">Remove</option>
            </select>
          </label>
          <label className="param-field">
            <span className="param-label">Distance</span>
            <input
              className="param-input"
              value={feature.distance}
              onChange={(e) => onChangeParam(feature.id, "distance", e.target.value)}
            />
          </label>
          <label className="param-field">
            <span className="param-label">Flip</span>
            <input
              type="checkbox"
              checked={feature.flip}
              onChange={(e) => onChangeParam(feature.id, "flip", e.target.checked ? "true" : "false")}
            />
          </label>
        </div>
      ) : feature.type === "dressup" ? (
        <div className="sketch-params">
          <div className="param-field">
            <span className="param-label">Edges</span>
            <span className="param-static">{feature.edges.length}</span>
          </div>
          <label className="param-field">
            <span className="param-label">{feature.op === "chamfer" ? "Distance" : "Radius"}</span>
            <input
              className="param-input"
              value={feature.size}
              onChange={(e) => onChangeParam(feature.id, "size", e.target.value)}
            />
          </label>
        </div>
      ) : feature.type === "sketch" ? (
        <div className="sketch-params">
          <div className="param-field">
            <span className="param-label">On</span>
            <span className="param-static">{planeRefLabel(feature.plane)}</span>
          </div>
          <div className="param-field">
            <span className="param-label">Entities</span>
            <span className="param-static">{feature.entities.length}</span>
          </div>
          {editingSketchId === feature.id ? (
            <button className="add-btn sketch-btn" onClick={onFinishSketch}>
              Finish sketch
            </button>
          ) : (
            <button className="add-btn sketch-btn" onClick={() => onEditSketch(feature.id)}>
              Edit sketch
            </button>
          )}
        </div>
      ) : (
        FEATURE_DEFS[feature.kind].params.map((p) => (
          <label className="param-field" key={p.name}>
            <span className="param-label">{p.label}</span>
            <input
              className="param-input"
              value={feature.params[p.name] ?? ""}
              onChange={(e) => onChangeParam(feature.id, p.name, e.target.value)}
            />
          </label>
        ))
      )}
      {error && <p className="error-box">{error}</p>}
    </div>
  );
}
