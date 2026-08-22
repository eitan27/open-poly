import type { ReactNode } from "react";

/** A "pick something in the viewport" slot — the shared shape behind every
 *  arming affordance in the dialogs (Revolve's profile/axis, Boolean's
 *  base/tools, Shell's body/faces, Pattern's body/axis/directions, Extrude's
 *  up-to face, Mirror's plane face, the reference-plane references).
 *
 *  Every slot moves through the same three states, and they must LOOK the same
 *  everywhere, since they mean the same thing everywhere:
 *
 *    UNARMED  `PickButton`            "Select a profile"     plain control
 *    ARMING   `PickButton armed`      "Selecting a profile…" dashed, pulsing
 *    ARMED    `PickedRow`             "Sketch 1"      ✕      solid accent fill
 *
 *  (A slot inside a labelled `.ed-field` shows its value in the button itself
 *  instead of a row — there's no room for a second line — via `children`.)
 *
 *  Keeping that in one place is the point: the states used to be hand-rolled at
 *  ~16 call sites, which is how the arming state ended up wearing the *filled*
 *  state's styling and reading as "already picked". */

/** "Select a profile" ⇄ "Selecting a profile…".
 *
 *  A narrow (field-aligned) slot drops the noun while arming — its field label
 *  already names what's being picked, and the full phrase doesn't fit the
 *  control width. */
function pickLabel(noun: string, armed: boolean, wide: boolean): string {
  if (!armed) return `Select ${noun}`;
  return wide ? `Selecting ${noun}…` : "Selecting…";
}

export function PickButton({
  noun,
  armed,
  wide = false,
  disabled = false,
  title,
  onClick,
  children,
}: {
  /** What's being picked, as it reads after "Select": "a profile", "an axis". */
  noun: string;
  /** True while the next viewport click fills this slot. */
  armed: boolean;
  /** Standalone slot (full dialog width, wraps) vs. field-aligned (112px). */
  wide?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  /** Overrides the label — for a field-aligned slot that shows its chosen value
   *  in place of a separate row ("On Body 1", "Front plane", "2/3 picked"). */
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={"ed-pick-btn" + (wide ? " ed-wide" : "") + (armed ? " active" : "")}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {children ?? pickLabel(noun, armed, wide)}
    </button>
  );
}

/** A FILLED slot: what got picked, plus ✕ to clear and pick again. */
export function PickedRow({
  label,
  title,
  clearTitle = "Re-pick",
  onClear,
}: {
  label: ReactNode;
  /** Tooltip on the name (a full face name behind an ellipsis, say). */
  title?: string;
  clearTitle?: string;
  onClear: () => void;
}) {
  return (
    <div className="bool-operand-row">
      <span className="bool-operand-name" title={title}>
        {label}
      </span>
      <button type="button" className="bool-operand-x" title={clearTitle} onClick={onClear}>
        ✕
      </button>
    </div>
  );
}
