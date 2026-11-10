// A text input for an expression ("40", "width * 2"), which autocompletes the
// open document's variable names: as an identifier is typed at the end, a list
// of matching variables (with their values) drops below the field; ↑/↓ choose,
// Tab or Enter (or a click) completes, Esc closes the list.
//
// A drop-in for `<input>`: every prop passes through, and a completion is
// written as if typed (the native value set, then an input event), so the
// field's own onChange sees it and nothing at the call site changes but the
// tag. While the list is open its keys don't reach the field's own onKeyDown,
// so Enter completes rather than confirming the dialog, and Esc closes the
// list rather than the dialog. The list is a portal at the field's position,
// so no layout needs a wrapper. Variables come from the ExprVariables
// context, or `variables` when given.
import { useContext, useLayoutEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { formatNumber } from "../lib/format";
import { completeWith, matchVariables } from "./dimAutocomplete";
import type { VarOption } from "./DimValueInput";
import { ExprVariables } from "./exprVariables";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  value: string;
  /** Overrides the context's variables. */
  variables?: VarOption[];
  ref?: React.Ref<HTMLInputElement>;
};

/** Set an input's value as typing would, so React's onChange fires. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function ExprInput({ variables, ref, onKeyDown, onFocus, onBlur, ...input }: Props) {
  const fromContext = useContext(ExprVariables);
  const options = variables ?? fromContext;
  const own = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);

  const suggestions = focused && dismissed !== input.value ? matchVariables(input.value, options) : [];
  const open = suggestions.length > 0;
  const hl = Math.min(highlight, Math.max(0, suggestions.length - 1));

  // Place the list under the field (it's fixed-position, in a portal).
  useLayoutEffect(() => {
    if (!open || !own.current) return;
    const r = own.current.getBoundingClientRect();
    setAt({ left: r.left, top: r.bottom + 4, width: r.width });
  }, [open, input.value]);

  const accept = (name: string) => {
    if (!own.current) return;
    typeInto(own.current, completeWith(input.value, name));
    setHighlight(0);
    own.current.focus();
  };

  return (
    <>
      <input
        {...input}
        ref={(el) => {
          own.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) (ref as React.RefObject<HTMLInputElement | null>).current = el;
        }}
        autoComplete="off"
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (open) {
            const n = suggestions.length;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => (e.key === "ArrowDown" ? h + 1 : h - 1 + n) % n);
              return;
            }
            if (e.key === "Tab" || e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              accept(suggestions[hl].name);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(input.value);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {open &&
        at &&
        createPortal(
          <ul
            className="dim-suggest expr-suggest"
            style={{ position: "fixed", left: at.left, top: at.top, minWidth: Math.max(120, at.width) }}
          >
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
          </ul>,
          document.body,
        )}
    </>
  );
}
