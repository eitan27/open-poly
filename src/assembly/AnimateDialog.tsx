// Animating one of a mate's free DOFs (see animate.ts, useMateAnimation.ts):
// which DOF, from and to, how long one sweep takes, and once, loop or bounce.
// Play shows it; nothing is written to the document, and Stop or Close puts
// every part back.
import { useEffect, useState } from "react";
import { DraggableDialog } from "../ui/DraggableDialog";
import type { AnimateMode } from "./animate";
import { videoMimeType } from "./exportAnimation";
import { dofLabel } from "./mateTypes";
import { formatValue, isRotation } from "./solve";
import type { MateAnimation } from "./useMateAnimation";
import type { Dof, Mate } from "./types";
import { fmtVolume } from "./interference";

const MODES: { mode: AnimateMode; label: string; title: string }[] = [
  { mode: "once", label: "Once", title: "From → to, then stop" },
  { mode: "loop", label: "Loop", title: "From → to, again and again" },
  { mode: "bounce", label: "Bounce", title: "From → to → from, again and again" },
];

export function AnimateDialog({ mate, anim, dofs }: { mate: Mate; anim: MateAnimation; dofs: Dof[] }) {
  const spec = anim.spec;
  if (!spec) return null;
  const rot = isRotation(spec.dof);
  const canVideo = videoMimeType() !== null;
  const unit = rot ? "°" : "mm";
  // Export waits for the sweep to be checked, and needs it to run clean.
  const exportable = anim.check !== null && !anim.blocked;
  return (
    <DraggableDialog className="feature-dialog asm-animate" style={{ left: 16, top: 72 }}>
      <div className="ed-title" data-drag-handle>
        Animate {mate.name}
      </div>
      {dofs.length > 1 && (
        <div className="ed-modes">
          {dofs.map((d) => (
            <button
              key={d}
              className={spec.dof === d ? "active" : ""}
              title={dofLabel(mate.type, d)}
              onClick={() => anim.setDof(d)}
            >
              {dofLabel(mate.type, d).replace(/ \(.*\)$/, "")}
            </button>
          ))}
        </div>
      )}
      <NumberField label={`From (${unit})`} value={spec.from} onChange={(from) => anim.setSpec({ from })} />
      <NumberField label={`To (${unit})`} value={spec.to} onChange={(to) => anim.setSpec({ to })} />
      <NumberField label="Seconds" value={spec.seconds} min={0.1} onChange={(seconds) => anim.setSpec({ seconds })} />
      <div className="ed-modes">
        {MODES.map((m) => (
          <button
            key={m.mode}
            className={spec.mode === m.mode ? "active" : ""}
            title={m.title}
            onClick={() => anim.setSpec({ mode: m.mode })}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="ed-hint asm-animate-live">
        {anim.live !== null
          ? `${dofLabel(mate.type, spec.dof).replace(/ \(.*\)$/, "")}: ${formatValue(anim.live, rot)} ${unit}`
          : "Plays in the view only: nothing is saved."}
      </p>
      {anim.blocked ? (
        <p className="ed-warning asm-animate-blocked">{anim.blocked.text}</p>
      ) : (
        anim.error && <p className="ed-warning">{anim.error}</p>
      )}
      <div className="bool-group-label">Export one cycle</div>
      {anim.exporting ? (
        <div className="asm-export-progress">
          <span>
            Exporting {anim.exporting.format === "gif" ? "GIF" : "video"}… {anim.exporting.done}/{anim.exporting.total}
          </span>
          <button className="asm-export-cancel" onClick={anim.cancelExport}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="ed-modes">
          <button
            className="asm-export-video"
            disabled={!canVideo || !exportable}
            title={
              canVideo
                ? `Save one cycle as a video (${videoMimeType()!.includes("mp4") ? "MP4" : "WebM"})`
                : "This browser can't record video"
            }
            onClick={() => anim.exportAs("video")}
          >
            Video
          </button>
          <button
            className="asm-export-gif"
            disabled={!exportable}
            title="Save one cycle as an animated GIF"
            onClick={() => anim.exportAs("gif")}
          >
            GIF
          </button>
        </div>
      )}
      <div className="bool-group-label">Clashes</div>
      <Clashes anim={anim} rot={rot} />
      <div className="ed-actions">
        {anim.playing ? (
          <button className="ed-primary asm-animate-stop" onClick={anim.stop}>
            ■ Stop
          </button>
        ) : (
          <button
            className="ed-primary asm-animate-play"
            disabled={!!anim.exporting || anim.blocked?.play === false}
            onClick={anim.play}
          >
            ▶ Play
          </button>
        )}
        <button className="asm-animate-close" onClick={anim.close}>
          Close
        </button>
      </div>
    </DraggableDialog>
  );
}

/** Checking the motion for parts that overlap, and what it found: each pair's
 *  runs of clashing values, a click posing the parts where it's worst. */
function Clashes({ anim, rot }: { anim: MateAnimation; rot: boolean }) {
  const c = anim.clashes;
  const fmt = (v: number) => `${formatValue(v, rot)}${rot ? "°" : " mm"}`;
  if (!c || c.kind === "error")
    return (
      <>
        {c?.kind === "error" && <p className="ed-warning">{c.message}</p>}
        <p className="ed-hint">Find parts that overlap anywhere from From to To.</p>
        <div className="ed-modes">
          <button
            className="asm-clash-check"
            disabled={!!anim.exporting || anim.blocked?.play === false || anim.check === null}
            title="Step through the motion and intersect the moving parts with everything else"
            onClick={anim.checkClashes}
          >
            Check the motion
          </button>
        </div>
      </>
    );
  if (c.kind === "running")
    return (
      <div className="asm-export-progress asm-clash-progress">
        <span>
          Checking… {c.done}/{c.total}
        </span>
        <button className="asm-export-cancel" onClick={anim.cancelClashes}>
          Cancel
        </button>
      </div>
    );
  return (
    <>
      <p className="ed-hint asm-clash-status">
        {c.ranges.length === 0
          ? `No clashes over the motion (${c.samples} positions checked).`
          : `${c.ranges.length === 1 ? "A clash" : `${c.ranges.length} clashes`} — click to see where it's worst:`}
      </p>
      {c.ranges.length > 0 && (
        <ul className="asm-interference-list asm-clash-list">
          {c.ranges.map((r, i) => (
            <li key={i}>
              <button
                className={anim.shownClash === i ? "active" : ""}
                title={`Worst at ${fmt(r.worst.value)}: ${fmtVolume(r.worst.volume)} (click again to put the parts back)`}
                onClick={() => anim.showClash(anim.shownClash === i ? null : i)}
              >
                <span className="asm-interference-pair">
                  {r.aName} ↔ {r.bName}
                </span>
                <span className="asm-interference-volume">
                  {r.from === r.to ? fmt(r.from) : `${fmt(r.from)} – ${fmt(r.to)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {c.jammedAt !== undefined && (
        <p className="ed-hint">The motion jams at {fmt(c.jammedAt)}: checked up to there.</p>
      )}
      <div className="ed-modes">
        <button className="asm-clash-check" onClick={anim.checkClashes}>
          Check again
        </button>
      </div>
    </>
  );
}

/** A number typed and kept on Enter or leaving the field; anything that isn't
 *  one puts the last good value back. */
function NumberField({
  label,
  value,
  min,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() && Number.isFinite(v) && (min === undefined || v >= min)) {
      if (v !== value) onChange(v);
    } else setDraft(String(value));
  };
  return (
    <label className="ed-field">
      <span>{label}</span>
      <input
        value={draft}
        inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            setDraft(String(value));
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
    </label>
  );
}
