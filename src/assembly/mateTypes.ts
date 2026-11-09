// The mate types as the UI presents them: in this order, with a label, a
// one-line explanation and a key (the icons are MateIcon.tsx). The Mate dialog's type grid and the assembly
// toolbar both read this.
import type { ShortcutId } from "../settings/shortcuts";
import type { Dof, MateType } from "./types";

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
