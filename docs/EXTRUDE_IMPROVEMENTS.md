# Extrude: gaps still open

A read-through of the extrude feature from an early snapshot of the app. The
shipped items (extent types, multi-profile, ghost preview, incremental regen)
have been dropped from this list — see PLAN.md Phase 3 and git. What remains,
in rough priority order:

### 1. No draft/taper angle, no thin (shell) extrude — the largest

`prismFromFace` builds a straight `MakePrism`: no angled-wall option, no
wall-thickness shell mode. New OCCT calls + new params.
