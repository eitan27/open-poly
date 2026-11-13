// The mate types as the UI presents them: in this order, with a label, a
// one-line explanation and a key (the icons are MateIcon.tsx). The Mate dialog's type grid and the assembly
// toolbar both read this.
import type { ShortcutId } from "../settings/shortcuts";
import { formatValue, isDriven, isRotation, MATE_DOFS } from "./solve";
import type { Dof, Mate, MateType } from "./types";

export const MATE_TYPES: { type: MateType; label: string; title: string; key: ShortcutId }[] = [
  { type: "fastened", label: "Fastened", title: "Fixed together: no motion", key: "asm.mateFastened" },
  {
    type: "revolute",
    label: "Revolute",
    title: "Turns about the axis: a hinge, a wheel on an axle",
    key: "asm.mateRevolute",
  },
  {
    type: "slider",
    label: "Slider",
    title: "Slides along the axis: a drawer, a piston",
    key: "asm.mateSlider",
  },
  {
    type: "cylindrical",
    label: "Cylindrical",
    title: "Slides along and turns about the axis: a shaft in a bushing",
    key: "asm.mateCylindrical",
  },
  {
    type: "planar",
    label: "Planar",
    title: "Slides and turns on the plane: a part on a table",
    key: "asm.matePlanar",
  },
  { type: "ball", label: "Ball", title: "Turns any way about the point: a ball joint", key: "asm.mateBall" },
  {
    type: "width",
    label: "Width",
    title: "Centres one part between two faces of another: a tab in a slot. Pick two faces on each part.",
    key: "asm.mateWidth",
  },
];

/** A free DOF's name in the UI, with its unit. */
export function dofLabel(type: MateType, d: Dof): string {
  if (type === "ball") return `Turn ${d[1].toUpperCase()} (°)`;
  if (d === "rz") return "Angle (°)";
  if (d === "tz") return "Distance (mm)";
  return `Offset ${d[1].toUpperCase()} (mm)`;
}

/** A mate's values as the mates list shows them: "15 mm", "90°", or for a
 *  mate with several of a kind "x 3 mm · y 4 mm · 30°". A value set by an
 *  expression shows it: "lift = 25 mm". Empty for a mate with no free DOFs. */
export function mateValuesText(
  mate: Pick<Mate, "type" | "values">,
  values: Partial<Record<Dof, number>> | undefined,
): string {
  const dofs = MATE_DOFS[mate.type];
  const several = (d: Dof) => dofs.filter((x) => isRotation(x) === isRotation(d)).length > 1;
  return dofs
    .map((d) => {
      const v = values?.[d] ?? 0;
      const amount = isRotation(d) ? `${formatValue(v, true)}°` : `${formatValue(v, false)} mm`;
      const shown = isDriven(mate, d) ? `${mate.values![d]!.trim()} = ${amount}` : amount;
      return several(d) ? `${d[1]} ${shown}` : shown;
    })
    .join(" · ");
}
