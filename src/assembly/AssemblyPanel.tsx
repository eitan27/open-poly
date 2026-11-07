// The side panel of an open assembly, in place of a part's Variables /
// Timeline / Parts: what the assembly places, and how those are joined. Rows
// follow the Parts list's (colour, name, eye, ✕) so the two read alike.
import { shortcutHint, shortcutName } from "../settings/shortcuts";
import { EyeIcon } from "../ui/icons";
import { mateIcon } from "./mateTypes";
import type { AssemblyDoc, Instance } from "./types";
import type { SourceState } from "./useAssemblySources";
import "./AssemblyPanel.css";

interface Props {
  assembly: AssemblyDoc;
  sources: ReadonlyMap<string, SourceState>;
  selectedIds: ReadonlySet<string>;
  onSelect: (id: string, additive: boolean) => void;
  onRename: (id: string, name: string) => void;
  onToggleGrounded: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onColor: (id: string, color: number) => void;
  onDelete: (id: string) => void;
  /** Open the instance's source document, to edit the part itself. */
  onOpenSource: (docId: string) => void;
  onInsert: () => void;
  /** Mates the solver couldn't apply, and why. */
  mateProblems: ReadonlyMap<string, string>;
  /** Instances a mate positions. */
  drivenIds: ReadonlyMap<string, unknown>;
  editingMateId: string | null;
  onNewMate: () => void;
  onEditMate: (id: string) => void;
  onRenameMate: (id: string, name: string) => void;
  onRemoveMate: (id: string) => void;
  /** Show the shortcut keys on the buttons (the ? toggle). */
  showShortcuts: boolean;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** What's wrong with an instance's source, if anything, in words. */
function instanceProblem(inst: Instance, src: SourceState | undefined): string | null {
  if (!src || src.status === "loading" || src.status === "building") return null;
  if (src.status === "missing") return "Its source document was deleted.";
  if (src.status === "error") return `${src.name}: ${src.message}`;
  if (!src.parts.some((p) => p.partId === inst.source.partId)) return `This part no longer exists in ${src.name}.`;
  return null;
}

export function AssemblyPanel(p: Props) {
  const { assembly, sources } = p;
  return (
    <>
      <div className="parts-header">
        <h2>Instances ({assembly.instances.length})</h2>
        <div className="parts-import">
          <button
            type="button"
            className="asm-insert"
            title={`Insert parts from a part document (${shortcutName("asm.insert")})`}
            onClick={p.onInsert}
          >
            ＋ Insert
            {p.showShortcuts && <span className="kbd-hint">{shortcutHint("asm.insert")}</span>}
          </button>
        </div>
      </div>
      {assembly.instances.length === 0 ? (
        <p className="asm-empty">No parts placed yet. Insert one from a part document.</p>
      ) : (
        <div className="tree-list asm-list">
          {assembly.instances.map((inst) => {
            const src = sources.get(inst.source.docId);
            const part = src?.status === "ready" ? src.parts.find((x) => x.partId === inst.source.partId) : undefined;
            const bad = instanceProblem(inst, src);
            const srcName = src && "name" in src ? src.name : null;
            const color = inst.color ?? part?.color;
            return (
              <div
                key={inst.id}
                className={
                  "solid-row asm-row" + (p.selectedIds.has(inst.id) ? " selected" : "") + (inst.hidden ? " dim" : "")
                }
                onClick={(e) => p.onSelect(inst.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                onDoubleClick={() => p.onOpenSource(inst.source.docId)}
              >
                {color !== undefined ? (
                  <input
                    type="color"
                    className="solid-color"
                    title="Colour in this assembly"
                    value={hex(color)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => p.onColor(inst.id, parseInt(e.target.value.slice(1), 16))}
                  />
                ) : (
                  <span className="solid-color asm-color-none" />
                )}
                <span className="asm-name">
                  <input
                    className="solid-name"
                    value={inst.name}
                    title={`${inst.name} — double-click the row to open ${srcName ?? "its document"}`}
                    onChange={(e) => p.onRename(inst.id, e.target.value)}
                  />
                  <span className={"asm-source" + (bad ? " bad" : "")} title={bad ?? undefined}>
                    {bad
                      ? `⚠ ${bad}`
                      : src?.status === "building"
                        ? `${src.name} · building…`
                        : (srcName ?? "loading…")}
                    {!bad && p.drivenIds.has(inst.id) && " · mated"}
                  </span>
                </span>
                <button
                  type="button"
                  className={"row-icon asm-ground" + (inst.grounded ? " active" : "")}
                  title={inst.grounded ? "Grounded: fixed in place. Click to unground" : "Ground: fix it in place"}
                  aria-pressed={!!inst.grounded}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onToggleGrounded(inst.id);
                  }}
                >
                  ⏚
                </button>
                <button
                  type="button"
                  className="row-icon"
                  title={inst.hidden ? "Show" : "Hide"}
                  style={{ opacity: inst.hidden ? 0.35 : 1 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onToggleHidden(inst.id);
                  }}
                >
                  <EyeIcon />
                </button>
                <button
                  type="button"
                  className="row-icon"
                  title="Remove from the assembly"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onDelete(inst.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="parts-header">
        <h2>Mates ({assembly.mates.length})</h2>
        <div className="parts-import">
          <button
            type="button"
            className="asm-new-mate"
            title={`Join two parts with a mate (${shortcutName("asm.mate")})`}
            disabled={assembly.instances.length < 2}
            onClick={p.onNewMate}
          >
            ＋ Mate
            {p.showShortcuts && <span className="kbd-hint">{shortcutHint("asm.mate")}</span>}
          </button>
        </div>
      </div>
      {assembly.mates.length === 0 ? (
        <p className="asm-empty">
          {assembly.instances.length < 2 ? "Insert two parts to mate them." : "No mates yet."}
        </p>
      ) : (
        <div className="tree-list asm-list">
          {assembly.mates.map((m) => {
            const name = (id: string) => assembly.instances.find((i) => i.id === id)?.name ?? "?";
            const bad = p.mateProblems.get(m.id);
            return (
              <div
                key={m.id}
                className={
                  "solid-row asm-row asm-mate-row" +
                  (p.editingMateId === m.id ? " selected" : "") +
                  (m.suppressed ? " dim" : "")
                }
                onClick={() => p.onEditMate(m.id)}
              >
                <span className="asm-mate-icon" title={m.type}>
                  {mateIcon(m.type)}
                </span>
                <span className="asm-name">
                  <input className="solid-name" value={m.name} onChange={(e) => p.onRenameMate(m.id, e.target.value)} />
                  <span className={"asm-source" + (bad ? " bad" : "")} title={bad}>
                    {bad ? `⚠ ${bad}` : `${name(m.a.instanceId)} ↔ ${name(m.b.instanceId)}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="row-icon"
                  title="Delete the mate"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onRemoveMate(m.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
