# Extrude: current behavior and improvement opportunities

A read-through of the extrude feature end to end from an early snapshot of the
app. **Most of the gaps below have since shipped** — see the status marked on
each. Kept for the still-open items (#2, #5, #6, #7); superseded narrative
left in place for context rather than rewritten.

## Gaps

### 1. ~~Blind distance is the only extent type~~ — ✅ DONE
`ExtrudeExtent` is now `"blind" | "symmetric" | "throughAll" | "upToFace"`
(`document/types.ts`); all four ship in the dialog (see PLAN.md Phase 3).

### 2. No draft/taper angle, no thin (shell) extrude — still open
`prismFromFace` still builds a straight `MakePrism`; no angled-wall option, no
wall-thickness shell mode.

### 3. ~~One profile per operation~~ — ✅ DONE
Multi-select → one Extrude, one undo step (`extrudeProfiles[]` in `App.tsx`;
see PLAN.md Phase 3 "Multi-profile").

### 4. ~~No pre-commit 3D feedback~~ — ✅ DONE
Live translucent ghost preview while the dialog is open, tracking
distance/flip/mode/extent (`previewTool` in the kernel; PLAN.md Phase 3).

### 5. No direct-manipulation distance control — still open
Distance is still a plain text field; no viewport drag handle to set it (the
Transform feature got a drag gizmo for move/rotate — Phase 5.5 — extrude
distance never did).

### 6. Silent no-ops instead of errors — still open
`worker.ts`'s extrude case still deletes the cut tool silently when a
`remove` resolves to zero target bodies — no error, no visible effect,
unlike the explicit Boolean feature's validated failure message.

### 7. No validation on non-positive distance — still open
Distance expressions still pass straight through to `MakePrism` with no
zero/negative check; a degenerate value likely surfaces as a raw OCCT
exception rather than a friendly message.

### 8. ~~Full-document rebuild on every distance keystroke~~ — ✅ DONE
The worker now caches unchanged bodies' OCCT shapes and tessellations
(`builderCache`/`meshCache`, content-hash-keyed) and regen is debounced —
see PLAN.md's Phase 5.5 perf follow-up and the "Regen performance" risk row.

## Remaining, roughly in priority order

1. **#6 (silent remove no-op → real error)** — small, localized fix.
2. **#7 (validate distance > 0)** — small, same kind of localized guard.
3. **#5 (direct-manipulation distance drag)** — the Transform gizmo already
   proved the drag-preview pattern; extrude distance is the natural next case.
4. **#2 (taper/thin)** — the largest change (new OCCT calls, new params);
   belongs after the smaller fixes above.
