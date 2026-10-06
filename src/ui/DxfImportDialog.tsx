import { DXF_UNITS, type DxfUnitsKey } from "../document/dxfImport";
import { DraggableDialog } from "./DraggableDialog";

export interface DxfPlaneOption {
  /** The `planeKey` this option selects (`datum:…` or `plane:<id>`). */
  key: string;
  label: string;
}

interface Props {
  fileName: string;
  /** Entity counts from a scale-independent pre-parse, for the summary line. */
  total: number;
  skipped: number;
  planeKey: string;
  /** Every plane the sketch can land on: the three datums plus the user's own. */
  planeOptions: DxfPlaneOption[];
  unitsKey: DxfUnitsKey;
  onPlaneChange: (key: string) => void;
  onUnitsChange: (key: DxfUnitsKey) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DxfImportDialog({
  fileName,
  total,
  skipped,
  planeKey,
  planeOptions,
  unitsKey,
  onPlaneChange,
  onUnitsChange,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <DraggableDialog className="feature-dialog" style={{ left: "50%", top: 64 }} baseTransform="translateX(-50%)">
      <div className="ed-title" data-drag-handle>
        Import DXF sketch
      </div>
      <div className="ed-hint">
        {fileName} — {total} entit{total === 1 ? "y" : "ies"}
        {skipped > 0 && `, ${skipped} unsupported skipped`}
      </div>
      <label className="ed-field">
        <span>Plane</span>
        <select value={planeKey} onChange={(e) => onPlaneChange(e.target.value)}>
          {planeOptions.map((pl) => (
            <option key={pl.key} value={pl.key}>
              {pl.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ed-field">
        <span>Units</span>
        <select value={unitsKey} onChange={(e) => onUnitsChange(e.target.value as DxfUnitsKey)}>
          {DXF_UNITS.map((u) => (
            <option key={u.key} value={u.key}>
              {u.label}
            </option>
          ))}
        </select>
      </label>
      <div className="ed-actions">
        <button className="ed-primary" onClick={onConfirm} disabled={total === 0}>
          Import
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
