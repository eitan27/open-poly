// The side panel of an open assembly, in place of a part's Variables /
// Timeline / Parts: what the assembly places, and how those are joined. Rows
// follow the Parts list's (colour, name, eye, ✕) so the two read alike.
import { useEffect, useRef, useState } from "react";
import { shortcutHint, shortcutName } from "../settings/shortcuts";
import { EyeIcon, GroundIcon, SuppressIcon } from "../ui/icons";
import { MateIcon, RelationIcon } from "./MateIcon";
import { mateValuesText } from "./mateTypes";
import { animatableDofs } from "./animate";
import { RELATION_TYPES } from "./relations";
import type { AssemblyExportKind } from "./exportAssembly";
import type { AssemblyDoc, Dof, Instance } from "./types";
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
  /** Ask how many copies of the instance (or of all selected, if it's one). */
  onDuplicate: (id: string) => void;
  /** Open the instance's source document, to edit the part itself. */
  onOpenSource: (docId: string) => void;
  onInsert: () => void;
  /** Save the assembly as a file (exportAssembly.ts). */
  onExport: (kind: AssemblyExportKind) => void;
  /** Mates the solver couldn't apply, and why. */
  mateProblems: ReadonlyMap<string, string>;
  /** Mates that still work but whose connector was re-found by fingerprint,
   *  and what to check: an amber ⚠ on the row, as on a timeline feature. */
  mateWarnings: ReadonlyMap<string, string>;
  /** Each mate's current values (solved), shown in its row. */
  mateValues: ReadonlyMap<string, Partial<Record<Dof, number>>>;
  /** The pointer is over a mate's row (null: it left): its connectors show. */
  onHoverMate: (id: string | null) => void;
  /** Instances a mate positions. */
  drivenIds: { has(id: string): boolean };
  editingMateId: string | null;
  onNewMate: () => void;
  onEditMate: (id: string) => void;
  onRenameMate: (id: string, name: string) => void;
  onRemoveMate: (id: string) => void;
  /** Suppress a mate or relation, or bring it back. */
  onToggleSuppressed: (id: string) => void;
  /** Open the Animate dialog on a mate with free DOFs. */
  onAnimateMate: (id: string) => void;
  /** The mate the Animate dialog is open on. */
  animatingMateId: string | null;
  /** Relations that couldn't be applied, and why. */
  relationProblems: ReadonlyMap<string, string>;
  editingRelationId: string | null;
  /** A relation can be made: some mate has a free DOF. */
  canRelate: boolean;
  onNewRelation: () => void;
  onEditRelation: (id: string) => void;
  onRenameRelation: (id: string, name: string) => void;
  onRemoveRelation: (id: string) => void;
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
          <ExportMenu disabled={assembly.instances.length === 0} onExport={p.onExport} />
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
                  <GroundIcon />
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
                  className="row-icon asm-duplicate-btn"
                  title="Duplicate…"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onDuplicate(inst.id);
                  }}
                >
                  ⧉
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
                  (p.editingMateId === m.id || p.animatingMateId === m.id ? " selected" : "") +
                  (m.suppressed ? " dim" : "")
                }
                onClick={() => p.onEditMate(m.id)}
                onMouseEnter={() => p.onHoverMate(m.id)}
                onMouseLeave={() => p.onHoverMate(null)}
              >
                <span className="asm-mate-icon" title={m.type}>
                  <MateIcon type={m.type} />
                </span>
                <span className="asm-name">
                  <input className="solid-name" value={m.name} onChange={(e) => p.onRenameMate(m.id, e.target.value)} />
                  <span className={"asm-source" + (bad ? " bad" : "")} title={bad}>
                    {bad
                      ? `⚠ ${bad}`
                      : [
                          `${name(m.a.instanceId)} ↔ ${name(m.b.instanceId)}`,
                          m.suppressed ? "suppressed" : mateValuesText(m, p.mateValues.get(m.id)),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                  </span>
                </span>
                {!bad && p.mateWarnings.get(m.id) && (
                  <span className="row-badge warn asm-mate-warn" title={p.mateWarnings.get(m.id)}>
                    ⚠
                  </span>
                )}
                {!bad && !m.suppressed && animatableDofs(assembly, m).length > 0 && (
                  <button
                    type="button"
                    className="row-icon asm-mate-animate"
                    title="Animate the mate"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onAnimateMate(m.id);
                    }}
                  >
                    ▶
                  </button>
                )}
                <SuppressToggle on={!!m.suppressed} what="mate" onToggle={() => p.onToggleSuppressed(m.id)} />
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
      <RelationsSection {...p} />
    </>
  );
}

/** Relations: one mate's DOF driven by another's (a gear, a rack, a screw). */
function RelationsSection(p: Props) {
  const { assembly } = p;
  const relations = assembly.relations ?? [];
  const mateName = (id: string) => assembly.mates.find((m) => m.id === id)?.name ?? "?";
  return (
    <>
      <div className="parts-header">
        <h2>Relations ({relations.length})</h2>
        <div className="parts-import">
          <button
            type="button"
            className="asm-new-relation"
            title="Drive one mate from another: gears, a rack and pinion, a screw"
            disabled={!p.canRelate}
            onClick={p.onNewRelation}
          >
            ＋ Relation
          </button>
        </div>
      </div>
      {relations.length === 0 ? (
        <p className="asm-empty">
          {p.canRelate ? "No relations yet." : "Mate parts so they can move, then relate their mates."}
        </p>
      ) : (
        <div className="tree-list asm-list">
          {relations.map((r) => {
            const bad = p.relationProblems.get(r.id);
            const kind = RELATION_TYPES.find((t) => t.type === r.type)!;
            return (
              <div
                key={r.id}
                className={
                  "solid-row asm-row asm-relation-row" +
                  (p.editingRelationId === r.id ? " selected" : "") +
                  (r.suppressed ? " dim" : "")
                }
                onClick={() => p.onEditRelation(r.id)}
              >
                <span className="asm-mate-icon" title={kind.label}>
                  <RelationIcon type={r.type} />
                </span>
                <span className="asm-name">
                  <input
                    className="solid-name"
                    value={r.name}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => p.onRenameRelation(r.id, e.target.value)}
                  />
                  <span className={"asm-source" + (bad ? " bad" : "")} title={bad ?? kind.title}>
                    {bad
                      ? `⚠ ${bad}`
                      : `${mateName(r.driver.mateId)} → ${mateName(r.driven.mateId)} · ${r.value}${r.reverse ? " · reversed" : ""}${r.suppressed ? " · suppressed" : ""}`}
                  </span>
                </span>
                <SuppressToggle on={!!r.suppressed} what="relation" onToggle={() => p.onToggleSuppressed(r.id)} />
                <button
                  type="button"
                  className="row-icon"
                  title="Delete the relation"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onRemoveRelation(r.id);
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

/** A mate's or relation's suppress button, as the timeline's: faded while it
 *  applies, bright while it's suppressed. */
function SuppressToggle({ on, what, onToggle }: { on: boolean; what: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={"row-icon asm-suppress" + (on ? " on" : "")}
      title={on ? `Unsuppress the ${what}` : `Suppress the ${what}: leave it out, keeping it`}
      aria-pressed={on}
      style={{ opacity: on ? 1 : 0.35 }}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <SuppressIcon />
    </button>
  );
}

const EXPORTS: { kind: AssemblyExportKind; label: string; title: string }[] = [
  {
    kind: "3mf",
    label: "3MF — assembled, parts kept separate",
    title: "One file for printing or viewing the whole assembly: each part a separate, coloured object where it sits",
  },
  {
    kind: "stl",
    label: "STL — one file, assembled",
    title: "Every part merged into one mesh where it sits, for tools that only take STL",
  },
  {
    kind: "stl-parts",
    label: "STL — each part once, zipped",
    title:
      "One STL per distinct part, in its own coordinates, with how many the assembly uses in its name: for making the parts",
  },
];

/** The assembly's Export menu: three ways to save it as files. */
function ExportMenu({ disabled, onExport }: { disabled: boolean; onExport: (k: AssemblyExportKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);
  return (
    <div
      className="mt-dropdown asm-export"
      ref={wrap}
      onKeyDown={(e) => {
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="asm-export-btn"
        title="Save the assembly as a file (hidden parts are left out)"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Export ▾
      </button>
      {open && (
        <div className="mt-menu mt-menu-right asm-export-menu" role="menu">
          {EXPORTS.map((x) => (
            <button
              key={x.kind}
              type="button"
              role="menuitem"
              className={`asm-export-${x.kind}`}
              title={x.title}
              onClick={() => {
                setOpen(false);
                onExport(x.kind);
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
