import type { Variable } from "../document/types";

interface Props {
  variables: Variable[];
  scope: Record<string, number>;
  errors: Record<string, string>;
  onAdd: () => void;
  onChange: (id: string, field: "name" | "expression", value: string) => void;
  onDelete: (id: string) => void;
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
}

export function VariablesPanel({
  variables,
  scope,
  errors,
  onAdd,
  onChange,
  onDelete,
}: Props) {
  return (
    <div className="vars">
      {variables.map((v) => {
        const error = errors[v.id];
        const value = scope[v.name];
        return (
          <div className="var-row" key={v.id}>
            <input
              className="var-name"
              value={v.name}
              spellCheck={false}
              onChange={(e) => onChange(v.id, "name", e.target.value)}
            />
            <span className="var-eq">=</span>
            <input
              className={"var-expr" + (error ? " invalid" : "")}
              value={v.expression}
              spellCheck={false}
              title={error}
              onChange={(e) => onChange(v.id, "expression", e.target.value)}
            />
            <span className="var-value" title={error ?? undefined}>
              {error ? "!" : value === undefined ? "" : formatValue(value)}
            </span>
            <button className="row-icon" title="Delete" onClick={() => onDelete(v.id)}>
              ✕
            </button>
          </div>
        );
      })}
      <button className="add-btn var-add" onClick={onAdd}>
        + Variable
      </button>
    </div>
  );
}
