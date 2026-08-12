// Selection → Shell arming. Split out of App.tsx so the arming rules can be
// unit-tested directly — mirrors shellValidation.ts for the thickness field.
//
// The rule that matters here: Shell arms a BODY, never a face. Clicking a face
// is how you inspect anything in the viewport, so a face-first Shell meant the
// common case — "hollow this box" — almost always came out with that face
// accidentally opened. A face pick now resolves to its owning body, and the
// faces to open are armed separately, from inside the dialog.

import type { FaceRef } from "./types";

/** The parts of a viewport `Selection` this module needs. Declared structurally
 *  rather than imported from the viewport so `document/` stays framework-free;
 *  a real `Selection[]` is assignable to `ShellPick[]`. */
export type ShellPick =
  | { kind: "feature"; id: string }
  | { kind: "face" | "edge" | "vertex"; featureId: string }
  | { kind: "sketchEntity" | "sketchPoint" | "sketchFace"; sketchId: string };

/** The body a Shell should arm for the current selection, or null if there
 *  isn't exactly one.
 *
 *  Every pick on a rendered body — the body itself, or any face/edge/vertex of
 *  it — resolves to that body, so the tool arms the same thing however the user
 *  happened to click. Sketch picks contribute nothing. Two different bodies is
 *  ambiguous rather than a guess, and returns null (the tool stays disabled). */
export function shellBodyFromSelection(selection: readonly ShellPick[], bodyIds: ReadonlySet<string>): string | null {
  const ids = new Set<string>();
  for (const s of selection) {
    const id = s.kind === "feature" ? s.id : "featureId" in s ? s.featureId : null;
    if (id !== null && bodyIds.has(id)) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/** The faces a Shell will open, as parallel arrays: persistent topological
 *  names, and the geometric fingerprints used to re-find them after an upstream
 *  edit churns the names. They are kept in lockstep — index i of one describes
 *  the same face as index i of the other. */
export interface ShellFaces {
  faces: string[];
  faceRefs: FaceRef[];
}

export const NO_SHELL_FACES: ShellFaces = { faces: [], faceRefs: [] };

/** Add a face to the open-faces list, or remove it if already there — clicking
 *  an armed face again un-arms it, matching how the boolean dialog's operand
 *  list behaves. Both arrays are updated together so they can't drift. */
export function toggleShellFace(current: ShellFaces, name: string, ref: FaceRef): ShellFaces {
  const at = current.faces.indexOf(name);
  if (at === -1) return { faces: [...current.faces, name], faceRefs: [...current.faceRefs, ref] };
  return {
    faces: current.faces.filter((_, i) => i !== at),
    faceRefs: current.faceRefs.filter((_, i) => i !== at),
  };
}

/** Point the dialog at `nextTargetId`.
 *
 *  Switching to a DIFFERENT body drops the armed faces: a face name is only
 *  meaningful on the body it came from, so carrying them over would silently
 *  reference faces that don't exist (or, worse, unrelated same-named faces on
 *  the new body). Re-picking the SAME body keeps them, so an accidental
 *  re-click doesn't throw away the user's face picks. */
export function retargetShell(
  current: ShellFaces & { targetId: string | null },
  nextTargetId: string,
): ShellFaces & { targetId: string } {
  if (current.targetId === nextTargetId) {
    return { targetId: nextTargetId, faces: current.faces, faceRefs: current.faceRefs };
  }
  return { targetId: nextTargetId, ...NO_SHELL_FACES };
}
