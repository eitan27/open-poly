import type { ResolvedTheme } from "./settings";

/** The 3D scene's share of the colour theme. WebGL materials can't read CSS
 *  custom properties, so these are the one place colours are duplicated outside
 *  index.css — keep them in step with `--bg-chrome` and friends by eye.
 *
 *  Only the colours that are *defined against the background* live here. The
 *  rest of the scene is deliberately theme-independent: body colours come from
 *  the document, and the semantic overlays (orange selection, teal hover, green
 *  "fully constrained", amber guides, near-black body edges) are chosen to read
 *  on both a dark and a light backdrop — flipping them would make the same
 *  model look like a different model. */
export interface ViewportTheme {
  /** Scene clear colour. */
  background: number;
  /** Ground grid: the two axis lines through the origin… */
  gridMajor: number;
  /** …and the rest of the cells. */
  gridMinor: number;
  /** The navigation cube in the corner. It's the one widget that reads as UI
   *  chrome rather than as geometry, so it follows the theme like the panels do
   *  — a navy cube parked on a paper-white viewport looks like a bug. Its faces
   *  are canvas textures, hence the CSS colour strings. */
  cube: ViewCubePalette;
}

export interface ViewCubePalette {
  /** The solid body behind the six label planes, and its wireframe edges. */
  body: number;
  edge: number;
  /** Face plates: fill, border and label, at rest and hovered. */
  faceFill: string;
  faceFillHover: string;
  faceBorder: string;
  faceBorderHover: string;
  faceLabel: string;
  faceLabelHover: string;
  /** Corner nubs — a touch lighter than the faces on dark, darker on light, so
   *  they read as pressable either way. */
  corner: string;
  cornerHover: string;
  /** The ring that appears behind a hovered nub. */
  cornerOutline: number;
}

export const VIEWPORT_THEMES: Record<ResolvedTheme, ViewportTheme> = {
  dark: {
    background: 0x1b1d23,
    gridMajor: 0x3a3d48,
    gridMinor: 0x282b33,
    cube: {
      body: 0x2c3340,
      edge: 0x6b748c,
      faceFill: "#3b4356",
      faceFillHover: "#4c5a7c",
      faceBorder: "#6b748c",
      faceBorderHover: "#6ea0ff",
      faceLabel: "#e6e8ee",
      faceLabelHover: "#ffffff",
      corner: "#4a5570",
      cornerHover: "#5d6d96",
      cornerOutline: 0x6ea0ff,
    },
  },
  light: {
    // Not white: a paper-grey backdrop keeps light-coloured bodies and the
    // white specular highlights on every body readable, and stops the viewport
    // from glaring next to the panels.
    background: 0xe9edf3,
    gridMajor: 0xa9b4c6,
    gridMinor: 0xcfd6e1,
    cube: {
      body: 0xd7dde7,
      edge: 0x8d97a8,
      faceFill: "#dfe4ed",
      faceFillHover: "#cfdcf5",
      faceBorder: "#9aa4b5",
      faceBorderHover: "#2563eb",
      faceLabel: "#2b3242",
      faceLabelHover: "#12305e",
      corner: "#c4ccda",
      cornerHover: "#aab8ce",
      cornerOutline: 0x2563eb,
    },
  },
};
