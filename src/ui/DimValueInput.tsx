import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "../lib/format";
import { completeWith, matchVariables } from "./dimAutocomplete";

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
}

/** Dimension value field: accepts a number or an expression, and autocompletes
 *  variable names. As the user types an identifier at the end of the value, a
 *  dropdown of matching variables appears; Enter/Tab/click completes it, and a
 *  plain Enter (no pending suggestion) commits the dimension. */
export function DimValueInput({ value, onChange, onSubmit, onCancel, variables }: Props) {
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => matchVariables(value, variables), [value, variables]);

  // Pre-select the prepopulated value on mount so the first keystroke overwrites
  // the current dimension rather than appending to it. Mount-only (not onFocus)
  // so completing a variable — which refocuses the field — doesn't reselect.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const hl = Math.min(highlight, Math.max(0, suggestions.length - 1));

  const accept = (name: string) => {
    onChange(completeWith(value, name));
    setHighlight(0);
    inputRef.current?.focus();
  };

  return (
    <div className="dim-value">
      <input
        ref={inputRef}
        autoFocus
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={(e) => {
          if (suggestions.length > 0) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => (h + 1) % suggestions.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === "Tab" || e.key === "Enter") {
              e.preventDefault();
              accept(suggestions[hl].name);
              return;
            }
          }
          if (e.key === "Enter") onSubmit();
          else if (e.key === "Escape") onCancel();
        }}
      />
      {suggestions.length > 0 && (
        <ul className="dim-suggest">
          {suggestions.map((s, i) => (
            <li
              key={s.name}
              className={i === hl ? "active" : ""}
              // onMouseDown (not onClick) so the field doesn't blur first.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s.name);
              }}
            >
              <span className="dim-suggest-name">{s.name}</span>
              <span className="dim-suggest-val">{formatNumber(s.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
