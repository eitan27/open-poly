# Extrude: gaps still open

A read-through of the extrude feature from an early snapshot of the app. The
shipped items (extent types, multi-profile, ghost preview, incremental regen)
have been dropped from this list — see PLAN.md Phase 3 and git. What remains,
in rough priority order:

### 1. Silent no-ops instead of errors — small, localized
`worker.ts`'s extrude case deletes the cut tool silently when a `remove`
resolves to zero target bodies — no error, no visible effect, unlike the
Boolean feature's validated failure message.

### 2. No validation on non-positive distance — small, same shape of fix
Distance expressions pass straight to `MakePrism` with no zero/negative check;
a degenerate value surfaces as a raw OCCT exception rather than a friendly
message.

### 3. No direct-manipulation distance control
Distance is a plain text field; no viewport drag handle. The Transform feature
(Phase 5.5) already proved the drag-preview pattern — extrude distance is the
natural next case.

### 4. No draft/taper angle, no thin (shell) extrude — the largest
`prismFromFace` builds a straight `MakePrism`: no angled-wall option, no
wall-thickness shell mode. New OCCT calls + new params; belongs after the
smaller fixes above.
