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
 *    ARMING   `PickButton armed`      "Select a profile"     dashed, pulsing
 *    ARMED    `PickedRow`             "Sketch 1"      ✕      solid accent fill
 *
 *  (A slot inside a labelled `.ed-field` shows its value in the button itself
 *  instead of a row — there's no room for a second line — via `children`.)
 *
 *  Keeping that in one place is the point: the states used to be hand-rolled at
 *  ~16 call sites, which is how the arming state ended up wearing the *filled*
 *  state's styling and reading as "already picked". Reach for `PickSlot` — it
 *  drives the whole cycle from one `value` — and only drop to `PickButton` /
 *  `PickedRow` for a slot that accumulates several picks. */

/** Always "Select a profile" — the imperative, in both the unarmed and the
 *  arming state.
 *
 *  The label says what the slot WANTS, so it must not change under the user
 *  mid-pick: a button that re-words itself the instant it's clicked reads as if
 *  something already happened. Arming is carried by the styling instead (the
 *  dashed, pulsing `.ed-pick-btn.active`) plus the viewport's pick banner. */
function pickLabel(noun: string): string {
  return `Select ${noun}`;
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
      {children ?? pickLabel(noun)}
    </button>
  );
}

/** A single-value slot: the whole three-state cycle in ONE control. Filled and
 *  idle → the ARMED row (name + ✕); empty, or listening for a click → the pick
 *  button. Two rules fall out of putting it here rather than at each call site:
 *  an armed slot never wears the filled styling (it's listening, not chosen),
 *  and ✕ always re-arms, so clearing means "pick a different one" instead of
 *  stranding the slot empty and inert.
 *
 *  Accumulating slots (Boolean's tools, Shell's faces to open) aren't this
 *  shape — they render one `PickedRow` per item plus an "add more" button. */
export function PickSlot({
  noun,
  armed,
  value = null,
  title,
  clearTitle,
  wide = false,
  disabled = false,
  onArm,
  onClear,
  children,
}: {
  noun: string;
  armed: boolean;
  /** The chosen thing's label — null while the slot is still empty. */
  value?: ReactNode;
  title?: string;
  clearTitle?: string;
  wide?: boolean;
  disabled?: boolean;
  onArm: () => void;
  /** Runs instead of `onArm` on ✕ — for a slot that must also drop the value it
   *  holds (re-arming alone doesn't). Keep it re-arming. */
  onClear?: () => void;
  /** Overrides the BUTTON's label: a counting slot's tally, say. */
  children?: ReactNode;
}) {
  if (value != null && !armed) {
    return <PickedRow label={value} title={title} clearTitle={clearTitle} onClear={onClear ?? onArm} />;
  }
  return (
    <PickButton noun={noun} armed={armed} wide={wide} disabled={disabled} title={title} onClick={onArm}>
      {children}
    </PickButton>
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
