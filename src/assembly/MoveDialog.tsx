// Moving a placed instance with the transform gizmo: translate along the world
// axes, or rotate about a world axis through its centre. The gizmo is the same
// one a part's Transform uses; this is its panel.
import { DraggableDialog } from "../ui/DraggableDialog";

export type MoveMode = "translate" | "rotate";
export type WorldAxis = "x" | "y" | "z";

interface Props {
  name: string;
  grounded: boolean;
  mode: MoveMode;
  axis: WorldAxis;
  onMode: (mode: MoveMode) => void;
  onAxis: (axis: WorldAxis) => void;
  onUnground: () => void;
}

export function MoveDialog(p: Props) {
  return (
    <DraggableDialog
      className="feature-dialog asm-move"
      style={{ left: "50%", top: 64 }}
      baseTransform="translateX(-50%)"
    >
      <div className="ed-title" data-drag-handle>
        {p.name}
      </div>
      {p.grounded ? (
        <>
          <p className="ed-hint">Grounded: it stays where it is.</p>
          <button className="text-btn" onClick={p.onUnground}>
            Unground to move it
          </button>
        </>
      ) : (
        <>
          <div className="ed-modes">
            <button className={p.mode === "translate" ? "active" : ""} onClick={() => p.onMode("translate")}>
              Move
            </button>
            <button className={p.mode === "rotate" ? "active" : ""} onClick={() => p.onMode("rotate")}>
              Rotate
            </button>
          </div>
          {p.mode === "rotate" && (
            <>
              <div className="bool-group-label">About</div>
              <div className="ed-modes">
                {(["x", "y", "z"] as const).map((a) => (
                  <button key={a} className={p.axis === a ? "active" : ""} onClick={() => p.onAxis(a)}>
                    {a.toUpperCase()}
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="ed-hint">Drag the gizmo to {p.mode === "rotate" ? "turn" : "move"} it.</p>
        </>
      )}
    </DraggableDialog>
  );
}
