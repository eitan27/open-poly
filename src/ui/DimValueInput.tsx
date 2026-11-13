import { useEffect, useRef } from "react";
import { ExprInput } from "./ExprInput";

export interface VarOption {
  name: string;
  value: number;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Commit the dimension (Enter with no suggestion pending). */
  onSubmit: () => void;
  /** Dismiss the dimension input (Escape). */
  onCancel: () => void;
  /** Variables offered as autocomplete suggestions. */
  variables: VarOption[];
  /** Tab with no suggestion pending (otherwise Tab completes the suggestion). */
  onTab?: () => void;
  placeholder?: string;
}

/** Dimension value field: accepts a number or an expression, and autocompletes
 *  variable names (ExprInput, with this field's own variables). A plain Enter
 *  (no list open) commits the dimension, Tab moves on, Esc dismisses. */
export function DimValueInput({ value, onChange, onSubmit, onCancel, variables, onTab, placeholder }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Pre-select the prepopulated value on mount so the first keystroke overwrites
  // the current dimension rather than appending to it. Mount-only (not onFocus)
  // so completing a variable — which refocuses the field — doesn't reselect.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <div className="dim-value">
      <ExprInput
        ref={inputRef}
        autoFocus
        value={value}
        placeholder={placeholder}
        variables={variables}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Tab" && onTab) {
            e.preventDefault();
            onTab();
          } else if (e.key === "Enter") onSubmit();
          else if (e.key === "Escape") onCancel();
        }}
      />
    </div>
  );
}
