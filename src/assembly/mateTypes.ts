// The mate types as the UI presents them: in this order, with a label, a
// one-line explanation, an icon and a key. The Mate dialog's type grid and the assembly
// toolbar both read this.
import type { ShortcutId } from "../settings/shortcuts";
import type { MateType } from "./types";

export const MATE_TYPES: { type: MateType; label: string; icon: string; title: string; key: ShortcutId }[] = [
  { type: "fastened", icon: "▣", label: "Fastened", title: "Fixed together: no motion", key: "asm.mateFastened" },
  {
    type: "revolute",
    icon: "↻",
    label: "Revolute",
    title: "Turns about the axis: a hinge, a wheel on an axle",
    key: "asm.mateRevolute",
  },
  {
    type: "slider",
    icon: "⇕",
    label: "Slider",
    title: "Slides along the axis: a drawer, a piston",
    key: "asm.mateSlider",
  },
  {
    type: "cylindrical",
    icon: "⟳",
    label: "Cylindrical",
    title: "Slides along and turns about the axis: a shaft in a bushing",
    key: "asm.mateCylindrical",
  },
  {
    type: "planar",
    icon: "▱",
    label: "Planar",
    title: "Slides and turns on the plane: a part on a table",
    key: "asm.matePlanar",
  },
  { type: "ball", icon: "◉", label: "Ball", title: "Turns any way about the point: a ball joint", key: "asm.mateBall" },
  {
    type: "width",
    icon: "⇹",
    label: "Width",
    title: "Centres one part between two faces of another: a tab in a slot. Pick two faces on each part.",
    key: "asm.mateWidth",
  },
];

/** A mate type's icon, as the mates list and the toolbar draw it. */
export const mateIcon = (type: MateType) => MATE_TYPES.find((t) => t.type === type)!.icon;
