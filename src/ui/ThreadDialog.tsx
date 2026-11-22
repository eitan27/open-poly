import { useRef, useState } from "react";
import {
  THREAD_PROFILE_HINTS,
  THREAD_PROFILE_LABELS,
  threadReadout,
  type ThreadDims,
  type ThreadSettings,
} from "../document/threadFeature";
import type { ThreadParams } from "../document/types";
import type { ThreadProfile } from "../geom/thread";
import type { ThreadSlot } from "../hooks/useThreadDialog";
import { DraggableDialog } from "./DraggableDialog";
import { PickSlot } from "./PickSlot";
import { ExprInput } from "./ExprInput";
import { ThreadDiagram } from "./diagram/ThreadDiagram";
import "./GearDialog.css";

interface Props {
  editing?: boolean;
  settings: ThreadSettings;
  side: "external" | "internal";
  /** The picked face, as the slot shows it; null while there's none. */
  faceLabel: string | null;
  /** What the settings were matched to, when they were. */
  matched: string | null;
  slot: ThreadSlot | null;
  /** The last settings that resolved, so the diagram holds still while a
   *  field is half-typed. */
  dims: ThreadDims | null;
  error: string | null;
  onArm: (slot: ThreadSlot | null) => void;
  onClearMatch: () => void;
  onChange: (patch: Partial<ThreadSettings>) => void;
  onParam: (name: keyof ThreadParams, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const PROFILES = Object.keys(THREAD_PROFILE_LABELS) as ThreadProfile[];

export function ThreadDialog({
  editing,
  settings,
  side,
  faceLabel,
  matched,
  slot,
  dims,
  error,
  onArm,
  onClearMatch,
  onChange,
  onParam,
  onConfirm,
  onCancel,
}: Props) {
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const internal = side === "internal";

  const field = (name: keyof ThreadParams, label: string, title?: string) => (
    <label
      className="ed-field"
      title={title}
      onMouseEnter={() => setHovered(name)}
      onMouseLeave={() => setHovered(null)}
    >
      <span>{label}</span>
      <ExprInput
        ref={(el: HTMLInputElement | null) => {
          if (el) inputs.current.set(name, el);
        }}
        value={settings.params[name]}
        onFocus={(e) => {
          setFocused(name);
          e.currentTarget.select();
        }}
        onBlur={() => setFocused(null)}
        onChange={(e) => onParam(name, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm();
          else if (e.key === "Escape") onCancel();
        }}
      />
    </label>
  );

  const check = (label: string, value: boolean, set: (v: boolean) => void, title: string) => (
    <label className="ed-field ed-flip" title={title}>
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => set(e.target.checked)} />
    </label>
  );

  return (
    <DraggableDialog className="feature-dialog gear-dialog hole-dialog" style={{ right: 16, top: 64 }} baseTransform="">
      <div className="ed-title" data-drag-handle>
        {editing ? "Edit thread" : "Thread"}
      </div>
      <div className="bool-group-label">Face</div>
      <PickSlot
        noun="a cylindrical face or a hole's wall"
        wide
        armed={slot === "face"}
        value={faceLabel}
        title="A rod gets its grooves cut in; a hole gets them cut outward into its wall"
        onArm={() => onArm(slot === "face" ? null : "face")}
      />
      <div className="bool-group-label">Match</div>
      <PickSlot
        noun="a thread to match (optional)"
        wide
        armed={slot === "match"}
        value={matched && `Matches ${matched}`}
        title="Click a Thread, a tapped Hole, a Screw, or a plain rod or hole: its size, pitch, profile, starts and hand are copied, so the two screw together"
        clearTitle="Match something else"
        onArm={() => onArm(slot === "match" ? null : "match")}
        onClear={onClearMatch}
      />
      <div className="ed-modes">
        {PROFILES.map((p) => (
          <button
            key={p}
            className={settings.profile === p ? "active" : ""}
            title={THREAD_PROFILE_HINTS[p]}
            onClick={() => onChange({ profile: p })}
          >
            {THREAD_PROFILE_LABELS[p]}
          </button>
        ))}
      </div>

      {dims && (
        <ThreadDiagram dims={dims} active={focused ?? hovered} onPick={(name) => inputs.current.get(name)?.focus()} />
      )}

      {field(
        "diameter",
        "Diameter",
        "Major diameter of the rod's thread — a hole's is cut to mate with that size. Suggested from the face: a rod's own diameter; for a hole, the size whose minor diameter is the bore",
      )}
      {field("pitch", "Pitch", "Axial distance tooth to tooth. For FDM printing, 1.5 mm and up")}
      {check(
        "Full length",
        settings.fullLength,
        (fullLength) => onChange({ fullLength }),
        "Thread the whole face, end to end",
      )}
      {!settings.fullLength && field("length", "Length", "From the end the thread starts at")}
      {field("starts", "Starts", "Interleaved helices: 2–4 close a lid in fewer turns")}
      {field(
        "clearance",
        "Clearance",
        "Radial gap per part (mm) — a rod's thread shrinks by it, a hole's grows — so printed halves fit. 0.15 suits most FDM printers",
      )}
      {check("Left-hand", settings.leftHand, (leftHand) => onChange({ leftHand }), "Tightens anticlockwise")}
      {check(
        "Lead-in",
        settings.leadIn,
        (leadIn) => onChange({ leadIn }),
        internal
          ? "A 45° countersink at the mouth, so the rod finds the thread"
          : "A 45° chamfer at the tip, so it finds the nut",
      )}
      {check(
        "Start at other end",
        settings.flip,
        (flip) => onChange({ flip }),
        "The thread starts at the face's open end — a rod's tip, a hole's mouth. This starts it at the other",
      )}

      {dims && !error && <div className="gear-readout">{threadReadout(dims)}</div>}
      {error && <p className="ed-warning">{error}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={!!error || !faceLabel} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
