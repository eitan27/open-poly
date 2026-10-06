import { DraggableDialog } from "./DraggableDialog";
import { PickButton, PickedRow } from "./PickSlot";

export interface LoftSectionRow {
  /** Stable key for the row — the section's sketch/region pair. */
  key: string;
  /** Resolved label, already carrying its 1-based position. */
  label: string;
}

interface Props {
  /** The sections to blend through, in pick order. */
  sections: LoftSectionRow[];
  /** Whether the accumulating slot is live (see `PickSlot.tsx`). */
  arming: boolean;
  onToggleArming: () => void;
  onRemoveSection: (index: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LoftDialog({ sections, arming, onToggleArming, onRemoveSection, onConfirm, onCancel }: Props) {
  return (
    <DraggableDialog className="feature-dialog" style={{ left: "50%", top: 70 }} baseTransform="translateX(-50%)">
      <div className="ed-title" data-drag-handle>
        Loft
      </div>
      <div className="ed-hint">Blends through the sections in the order below — the order you pick them in.</div>
      {/* An accumulating slot (see PickSlot.tsx): the arming stays live between
          picks, and clicking a listed section in the viewport removes it. */}
      <div className="bool-group-label">Sections</div>
      {sections.map((s, i) => (
        <PickedRow key={s.key} label={s.label} clearTitle="Remove" onClear={() => onRemoveSection(i)} />
      ))}
      <PickButton noun="sections" armed={arming} wide onClick={onToggleArming}>
        {arming ? "Select sections (Esc to stop)" : sections.length ? "Add more sections" : undefined}
      </PickButton>
      {sections.length === 1 && <p className="ed-hint">A loft needs at least two sections.</p>}
      <div className="ed-actions">
        <button className="ed-primary" disabled={sections.length < 2} onClick={onConfirm}>
          Create
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </DraggableDialog>
  );
}
