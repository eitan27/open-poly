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
import { DraggableDialog } from "./DraggableDialog";
import { ExprInput } from "./ExprInput";
import { ThreadDiagram } from "./diagram/ThreadDiagram";
import "./GearDialog.css";

export interface ThreadOption {
  id: string;
  name: string;
}

interface Props {
  editing?: boolean;
  settings: ThreadSettings;
  sketchId: string | null;
  sketchOptions: (ThreadOption & { points: number })[];
  targetId: string | null;
  targetOptions: ThreadOption[];
  /** The last settings that resolved, so the diagram holds still while a
   *  field is half-typed. */
  dims: ThreadDims | null;
  error: string | null;
  onSketchChange: (id: string) => void;
  onTargetChange: (id: string) => void;
  onChange: (patch: Partial<ThreadSettings>) => void;
  onParam: (name: keyof ThreadParams, value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const PROFILES = Object.keys(THREAD_PROFILE_LABELS) as ThreadProfile[];

export function ThreadDialog({
  editing,
  settings,
  sketchId,
  sketchOptions,
  targetId,
  targetOptions,
  dims,
  error,
  onSketchChange,
  onTargetChange,
  onChange,
  onParam,
  onConfirm,
  onCancel,
}: Props) {
  const [focused, setFocused] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const internal = settings.side === "internal";

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
      <div className="ed-modes">
        <button
          className={!internal ? "active" : ""}
          title="A threaded rod, as a new body standing out of the sketch plane"
          onClick={() => onChange({ side: "external" })}
        >
          External
        </button>
        <button
          className={internal ? "active" : ""}
          title="The matching thread cut into a body, going in against the sketch plane's normal"
          onClick={() => onChange({ side: "internal" })}
        >
          Internal
        </button>
      </div>
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

      <label className="ed-field">
        <span>Sketch</span>
        <select value={sketchId ?? ""} onChange={(e) => onSketchChange(e.target.value)}>
          <option value="" disabled>
            {sketchOptions.length ? "Select a sketch…" : "No sketch with points"}
          </option>
          {sketchOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.points} {s.points === 1 ? "thread" : "threads"})
            </option>
          ))}
        </select>
      </label>
      {internal && (
        <label className="ed-field">
          <span>Body</span>
          <select value={targetId ?? ""} onChange={(e) => onTargetChange(e.target.value)}>
            <option value="" disabled>
              Select a part…
            </option>
            {targetOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {field("diameter", "Diameter", "Major diameter of the external thread — the internal one is cut to mate with it")}
      {field("pitch", "Pitch", "Axial distance tooth to tooth. For FDM printing, 1.5 mm and up")}
      {field("length", "Length")}
      {field("starts", "Starts", "Interleaved helices: 2–4 close a lid in fewer turns")}
      {field(
        "clearance",
        "Clearance",
        "Radial gap per part (mm) — an external thread shrinks by it, an internal one grows — so printed halves fit. 0.15 suits most FDM printers",
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
        "Flip direction",
        settings.flip,
        (flip) => onChange({ flip }),
        "Build the other way from the sketch plane",
      )}

      {dims && !error && <div className="gear-readout">{threadReadout(dims)}</div>}
      {error && <p className="ed-warning">{error}</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={!!error || !sketchId || (internal && !targetId)} onClick={onConfirm}>
          {editing ? "Done" : "Create"}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
