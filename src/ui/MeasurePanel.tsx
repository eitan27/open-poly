// The passive measure box at the bottom right of the view: what the current
// selection measures (selection/measure.ts), in a part document and in an
// assembly alike. Nothing to click: picking is measuring.
import type { MeasureInfo } from "../selection/measure";
import "./MeasurePanel.css";

export function MeasurePanel({ info }: { info: MeasureInfo }) {
  return (
    <div className="selection-info" role="status" aria-label="Measurements">
      <div className="si-title">{info.title}</div>
      {info.rows.map((r) => (
        <div className="si-row" key={r.label}>
          <span className="si-label">{r.label}</span>
          <span className="si-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
