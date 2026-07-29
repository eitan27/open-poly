import { BOOLEAN_OP_LABELS, FEATURE_DEFS } from "../document/featureDefs";
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
  onEditTransform: (id: string) => void;
}

export function ParamEditor({
  feature,
  error,
  editingSketchId,
  onChangeParam,
  onRename,
  onEditSketch,
  onFinishSketch,
  onEditTransform,
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
            <span className="param-label">Extent</span>
            <select
              className="param-input"
              value={feature.extent}
              onChange={(e) => onChangeParam(feature.id, "extent", e.target.value)}
            >
              <option value="blind">Blind</option>
              <option value="symmetric">Symmetric</option>
              {/* Through All only makes sense as a cut, so it's shown for Remove only. */}
              {feature.mode === "remove" && <option value="throughAll">Through All</option>}
              {/* The up-to-face target face is chosen in the extrude dialog at
                  creation; shown here read-only so a committed feature displays
                  correctly. */}
              <option value="upToFace" disabled>Up to face</option>
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
          {feature.extent !== "symmetric" && (
            <label className="param-field">
              <span className="param-label">Flip</span>
              <input
                type="checkbox"
                checked={feature.flip}
                onChange={(e) => onChangeParam(feature.id, "flip", e.target.checked ? "true" : "false")}
              />
            </label>
          )}
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
          {/* Angle is chamfer-only; a fillet's round has no bevel to tilt.
              Blank means the default symmetric 45°. */}
          {feature.op === "chamfer" && (
            <>
              <label className="param-field">
                <span className="param-label">Angle (°)</span>
                <input
                  className="param-input"
                  value={feature.angle ?? "45"}
                  onChange={(e) => onChangeParam(feature.id, "angle", e.target.value)}
                />
              </label>
              <label className="param-field">
                <span className="param-label">Flip angle</span>
                <input
                  type="checkbox"
                  checked={feature.flip ?? false}
                  onChange={(e) => onChangeParam(feature.id, "flip", e.target.checked ? "true" : "false")}
                />
              </label>
            </>
          )}
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
      ) : feature.type === "boolean" ? (
        <div className="sketch-params">
          <div className="param-field">
            <span className="param-label">Operation</span>
            <span className="param-static">{BOOLEAN_OP_LABELS[feature.op]}</span>
          </div>
          <div className="param-field">
            <span className="param-label">Operands</span>
            <span className="param-static">{feature.operands.length}</span>
          </div>
        </div>
      ) : feature.type === "plane" ? (
        <div className="sketch-params">
          {(feature.method ?? "offset") === "through" ? (
            <div className="param-field">
              <span className="param-label">Plane</span>
              <span className="param-static">Through 3 points</span>
            </div>
          ) : (feature.method ?? "offset") === "midplane" ? (
            <div className="param-field">
              <span className="param-label">Midplane</span>
              <span className="param-static">
                {planeRefLabel(feature.base)} ↔ {feature.refB ? planeRefLabel(feature.refB) : "—"}
              </span>
            </div>
          ) : (
            <>
              <div className="param-field">
                <span className="param-label">On</span>
                <span className="param-static">{planeRefLabel(feature.base)}</span>
              </div>
              {(feature.method ?? "offset") === "angle" ? (
                <label className="param-field">
                  <span className="param-label">Angle°</span>
                  <input
                    className="param-input"
                    value={feature.angle ?? "0"}
                    onChange={(e) => onChangeParam(feature.id, "angle", e.target.value)}
                  />
                </label>
              ) : (
                <label className="param-field">
                  <span className="param-label">Offset</span>
                  <input
                    className="param-input"
                    value={feature.offset}
                    onChange={(e) => onChangeParam(feature.id, "offset", e.target.value)}
                  />
                </label>
              )}
            </>
          )}
        </div>
      ) : feature.type === "transform" ? (
        <div className="sketch-params">
          {(["tx", "ty", "tz"] as const).map((k) => (
            <label className="param-field" key={k}>
              <span className="param-label">Move {k[1].toUpperCase()}</span>
              <input
                className="param-input"
                value={feature[k]}
                onChange={(e) => onChangeParam(feature.id, k, e.target.value)}
              />
            </label>
          ))}
          <label className="param-field">
            <span className="param-label">Axis</span>
            <select
              className="param-input"
              value={feature.axis}
              onChange={(e) => onChangeParam(feature.id, "axis", e.target.value)}
            >
              <option value="x">X</option>
              <option value="y">Y</option>
              <option value="z">Z</option>
            </select>
          </label>
          <label className="param-field">
            <span className="param-label">Angle°</span>
            <input
              className="param-input"
              value={feature.angle}
              onChange={(e) => onChangeParam(feature.id, "angle", e.target.value)}
            />
          </label>
          <button className="add-btn sketch-btn" onClick={() => onEditTransform(feature.id)}>
            Edit in viewport
          </button>
        </div>
      ) : feature.type === "import" ? (
        <div className="sketch-params">
          <div className="param-field">
            <span className="param-label">Format</span>
            <span className="param-static">{feature.format.toUpperCase()}</span>
          </div>
          <div className="param-field">
            <span className="param-label">Size</span>
            <span className="param-static">{(feature.source.length / 1024).toFixed(1)} KB</span>
          </div>
        </div>
      ) : feature.type === "mirror" ? (
        <div className="sketch-params">
          <div className="param-field">
            <span className="param-label">Mirror</span>
            <span className="param-static">a reflected copy across a plane</span>
          </div>
        </div>
      ) : feature.type === "pattern" ? (
        <div className="sketch-params">
          {feature.kind === "linear" ? (
            <>
              <label className="param-field">
                <span className="param-label">Count</span>
                <input
                  className="param-input"
                  value={feature.count1 ?? ""}
                  onChange={(e) => onChangeParam(feature.id, "count1", e.target.value)}
                />
              </label>
              <label className="param-field">
                <span className="param-label">Spacing</span>
                <input
                  className="param-input"
                  value={feature.spacing1 ?? ""}
                  onChange={(e) => onChangeParam(feature.id, "spacing1", e.target.value)}
                />
              </label>
              <label className="param-field">
                <span className="param-label">Flip</span>
                <input
                  type="checkbox"
                  checked={feature.flip1 ?? false}
                  onChange={(e) => onChangeParam(feature.id, "flip1", e.target.checked ? "true" : "false")}
                />
              </label>
              {feature.dir2 && (
                <>
                  <label className="param-field">
                    <span className="param-label">Count 2</span>
                    <input
                      className="param-input"
                      value={feature.count2 ?? ""}
                      onChange={(e) => onChangeParam(feature.id, "count2", e.target.value)}
                    />
                  </label>
                  <label className="param-field">
                    <span className="param-label">Spacing 2</span>
                    <input
                      className="param-input"
                      value={feature.spacing2 ?? ""}
                      onChange={(e) => onChangeParam(feature.id, "spacing2", e.target.value)}
                    />
                  </label>
                  <label className="param-field">
                    <span className="param-label">Flip 2</span>
                    <input
                      type="checkbox"
                      checked={feature.flip2 ?? false}
                      onChange={(e) => onChangeParam(feature.id, "flip2", e.target.checked ? "true" : "false")}
                    />
                  </label>
                </>
              )}
            </>
          ) : (
            <>
              <label className="param-field">
                <span className="param-label">Count</span>
                <input
                  className="param-input"
                  value={feature.count ?? ""}
                  onChange={(e) => onChangeParam(feature.id, "count", e.target.value)}
                />
              </label>
              <label className="param-field">
                <span className="param-label">Angle°</span>
                <input
                  className="param-input"
                  value={feature.angle ?? "360"}
                  onChange={(e) => onChangeParam(feature.id, "angle", e.target.value)}
                />
              </label>
              <label className="param-field">
                <span className="param-label">Symmetric</span>
                <input
                  type="checkbox"
                  checked={feature.symmetric ?? false}
                  onChange={(e) => onChangeParam(feature.id, "symmetric", e.target.checked ? "true" : "false")}
                />
              </label>
            </>
          )}
        </div>
      ) : feature.type === "revolve" ? (
        <div className="sketch-params">
          <label className="param-field">
            <span className="param-label">Angle°</span>
            <input
              className="param-input"
              value={feature.angle}
              onChange={(e) => onChangeParam(feature.id, "angle", e.target.value)}
            />
          </label>
        </div>
      ) : feature.type === "sweep" ? (
        <div className="sketch-params">
          <div className="param-field">
            <span className="param-label">Sweep</span>
            <span className="param-static">a region along a path</span>
          </div>
        </div>
      ) : feature.type === "loft" ? (
        <div className="sketch-params">
          <div className="param-field">
            <span className="param-label">Sections</span>
            <span className="param-static">{feature.profiles.length}</span>
          </div>
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
