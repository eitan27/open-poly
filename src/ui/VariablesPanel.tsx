import { validateVariableNames } from "../document/document";
import type { Variable } from "../document/types";
import { useRef, useState } from "react";
import { formatNumber } from "../lib/format";
import { ExprInput } from "./ExprInput";

interface Props {
  variables: Variable[];
  scope: Record<string, number>;
  errors: Record<string, string>;
  /** variableId -> invalid-name message (flagged on the name field). */
  nameErrors: Record<string, string>;
  onAdd: () => void;
  onChange: (id: string, field: "name" | "expression", value: string) => void;
  onDelete: (id: string) => void;
}

/** The variable rows. Adding one is the section heading's button (see
 *  VariablesSection), so it stays in reach while the list is collapsed. */
export function VariablesPanel({ variables, scope, errors, nameErrors, onChange, onDelete }: Omit<Props, "onAdd">) {
  return (
    <div className="vars">
      {variables.map((v) => {
        const nameError = nameErrors[v.id];
        const error = errors[v.id];
        const value = scope[v.name];
        return (
          <div className="var-row" key={v.id}>
            <NameField
              variable={v}
              variables={variables}
              error={nameError}
              onCommit={(name) => onChange(v.id, "name", name)}
            />
            <span className="var-eq">=</span>
            <ExprInput
              // An invalid name is grayed out (disabled) — the expression can't
              // be used until the name is fixed.
              className={"var-expr" + (error ? " invalid" : "")}
              value={v.expression}
              spellCheck={false}
              disabled={!!nameError}
              title={nameError ? "Fix the variable name first" : error}
              onChange={(e) => onChange(v.id, "expression", e.target.value)}
            />
            <span className="var-value" title={nameError ?? error ?? undefined}>
              {nameError || error ? "!" : value === undefined ? "" : formatNumber(value)}
            </span>
            <button className="row-icon" title="Delete" onClick={() => onDelete(v.id)}>
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The side panel's collapsible "Variables (n)" section: a part document's,
 *  and an assembly's (which starts collapsed). "＋ Variable" sits beside the
 *  heading, as "＋ Insert" and "＋ Mate" do beside theirs, so it's there while
 *  the list is collapsed; adding from a collapsed section opens it. */
export function VariablesSection({ open, onToggle, ...panel }: Props & { open: boolean; onToggle: () => void }) {
  return (
    <>
      <div className="parts-header vars-header">
        <button className="params-heading collapsible" aria-expanded={open} onClick={onToggle}>
          <span className={"collapse-caret" + (open ? " open" : "")}>▶</span>
          Variables ({panel.variables.length})
        </button>
        <div className="parts-import">
          <button
            type="button"
            className="var-add"
            title="Add a variable"
            onClick={() => {
              panel.onAdd();
              if (!open) onToggle();
            }}
          >
            ＋ Variable
          </button>
        </div>
      </div>
      {open && <VariablesPanel {...panel} />}
    </>
  );
}

/** A variable's name, committed on Enter or leaving the field (Esc puts it
 *  back), not per keystroke: a rename carries into every expression that uses
 *  the variable, and the names typed on the way ("", "l", "li" …) mustn't. The
 *  draft is checked as it's typed, by the same rules. */
function NameField({
  variable,
  variables,
  error,
  onCommit,
}: {
  variable: Variable;
  variables: Variable[];
  error?: string;
  onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const draftError =
    draft === null
      ? error
      : (validateVariableNames(variables.map((x) => (x.id === variable.id ? { ...x, name: draft } : x)))[variable.id] ??
        (variables.some((x) => x.id !== variable.id && x.name === draft)
          ? "Another variable has this name"
          : undefined));
  return (
    <input
      className={"var-name" + (draftError ? " invalid" : "")}
      value={draft ?? variable.name}
      spellCheck={false}
      title={draftError}
      onFocus={() => setDraft(variable.name)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!cancelled.current && draft !== null && draft !== variable.name) onCommit(draft);
        cancelled.current = false;
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
