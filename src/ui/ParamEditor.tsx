import { FEATURE_DEFS } from "../document/featureDefs";
import type { Feature } from "../document/types";

interface Props {
  feature: Feature | null;
  error: string | null;
  onChangeParam: (id: string, name: string, value: string) => void;
  onRename: (id: string, name: string) => void;
}

export function ParamEditor({ feature, error, onChangeParam, onRename }: Props) {
  if (!feature) {
    return (
      <div className="params">
        <p className="hint">Select a feature to edit its parameters.</p>
      </div>
    );
  }

  const def = FEATURE_DEFS[feature.kind];

  return (
    <div className="params">
      <input
        className="param-name-input"
        value={feature.name}
        onChange={(e) => onRename(feature.id, e.target.value)}
      />
      {def.params.map((p) => (
        <label className="param-field" key={p.name}>
          <span className="param-label">{p.label}</span>
          <input
            className="param-input"
            value={feature.params[p.name] ?? ""}
            onChange={(e) => onChangeParam(feature.id, p.name, e.target.value)}
          />
        </label>
      ))}
      {error && <p className="error-box">{error}</p>}
    </div>
  );
}
