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
      {anim.error && <p className="ed-warning">{anim.error}</p>}
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
            disabled={!canVideo}
            title={canVideo ? "Save one cycle as a video (WebM, or MP4 in Safari)" : "This browser can't record video"}
            onClick={() => anim.exportAs("video")}
          >
            Video
          </button>
          <button
            className="asm-export-gif"
            title="Save one cycle as an animated GIF"
            onClick={() => anim.exportAs("gif")}
          >
            GIF
          </button>
        </div>
      )}
      <div className="ed-actions">
        {anim.playing ? (
          <button className="ed-primary asm-animate-stop" onClick={anim.stop}>
            ■ Stop
          </button>
        ) : (
          <button className="ed-primary asm-animate-play" disabled={!!anim.exporting} onClick={anim.play}>
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
