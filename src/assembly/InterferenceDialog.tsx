// The Interference panel: which parts overlap, by how much. Each overlap is
// drawn in the viewport in removal red; clicking a row shows just that one
// and selects its two parts.
import { DraggableDialog } from "../ui/DraggableDialog";
import { fmtVolume } from "./interference";
import type { InterferenceDialogProps } from "./useInterference";

export function InterferenceDialog(p: InterferenceDialogProps) {
  const r = p.report;
  const scopeText = p.scope.length
    ? `${p.scope.length === 1 ? p.scope[0] : `${p.scope.length} selected parts`} against the rest`
    : `all ${p.total} parts`;
  return (
    <DraggableDialog className="feature-dialog asm-interference" style={{ left: 16, top: 72 }}>
      <div className="ed-title" data-drag-handle>
        Interference
      </div>
      <p className="ed-hint">
        Checking {scopeText}, where they are now.
        {p.scope.length > 0 && (
          <>
            {" "}
            <button className="asm-interference-all" onClick={p.onCheckAll}>
              Check all
            </button>
          </>
        )}
      </p>
      {p.running && <p className="ed-hint asm-interference-status">Checking…</p>}
      {p.error && <p className="ed-warning">{p.error}</p>}
      {r && !p.running && (
        <>
          {p.stale && <p className="ed-warning">The assembly has changed since: check again.</p>}
          {r.clashes.length === 0 ? (
            <p className="ed-hint asm-interference-status asm-interference-clear">
              <span className="asm-interference-check-mark" aria-hidden>
                ✓
              </span>
              <span>
                <strong>No interference.</strong>{" "}
              {r.checked === 0
                ? "No parts are close enough to touch."
                : `${r.checked} ${r.checked === 1 ? "pair is" : "pairs are"} close, but only touch.`}
              </span>
            </p>
          ) : (
            <>
              <p className="ed-hint asm-interference-status">
                {r.clashes.length} {r.clashes.length === 1 ? "overlap" : "overlaps"}, in red:
              </p>
              <ul className="asm-interference-list">
                {r.clashes.map((c, i) => (
                  <li key={i}>
                    <button
                      className={p.shown === i ? "active" : ""}
                      title="Show just this overlap and select its two parts (click again for all)"
                      onClick={() => p.onShow(p.shown === i ? null : i)}
                    >
                      <span className="asm-interference-pair">
                        {c.a} ↔ {c.b}
                      </span>
                      <span className="asm-interference-volume">{fmtVolume(c.volume)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {r.errors.map((e, i) => (
            <p key={i} className="ed-warning">
              Couldn't check {e.a} ↔ {e.b}: {e.error}
            </p>
          ))}
        </>
      )}
      <div className="ed-actions">
        <button className="ed-primary asm-interference-check" disabled={p.running} onClick={p.onCheck}>
          Check again
        </button>
        <button onClick={p.onClose}>Close</button>
      </div>
    </DraggableDialog>
  );
}
