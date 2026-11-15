// ISO metric fastener dimensions, shared by the Hole and Screw features.
//
// Values are nominal (mm) from the usual tables:
//   • clearance holes — ISO 273 fine / medium / coarse series (our Close /
//     Normal / Loose fits);
//   • tap drill — the common ~75%-thread drill for the COARSE pitch;
//   • counterbore — DIN 974-1 for ISO 4762 socket head cap screws (diameter;
//     depth = head height + a little, so the head sits just below flush);
//   • countersink — ISO 15065 diameters at 90°, for ISO 10642 flat heads;
//   • heads — ISO 4762 socket cap, ISO 7380 button, ISO 10642 countersunk,
//     ISO 4017 hex; nuts ISO 4032. Head dims are the max/nominal, rounded.
// Sizes below M3 have no ISO 7380 button head; those entries are scaled from
// M3 and marked so in a comment, good enough for a printed part.

export type MetricSize = "M2" | "M2.5" | "M3" | "M4" | "M5" | "M6" | "M8" | "M10" | "M12";

export const METRIC_SIZES: MetricSize[] = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10", "M12"];

export type HoleFit = "close" | "normal" | "loose";

export interface MetricSpec {
  /** Nominal (major) diameter. */
  d: number;
  /** Coarse thread pitch. */
  pitch: number;
  tapDrill: number;
  clearance: Record<HoleFit, number>;
  counterbore: { diameter: number; depth: number };
  countersink: { diameter: number; angle: number };
  /** ISO 4762 socket head cap: head diameter, height, hex key size. */
  socketHead: { dk: number; k: number; key: number };
  /** ISO 7380 button head: diameter, height, hex key size. */
  buttonHead: { dk: number; k: number; key: number };
  /** ISO 10642 countersunk (flat) head: diameter at the top, 90° included. */
  flatHead: { dk: number; key: number };
  /** ISO 4017 hex head: across flats, height. */
  hexHead: { s: number; k: number };
  /** ISO 4032 hex nut: across flats, height. */
  nut: { s: number; m: number };
  /** ISO 4026 hex socket set screw: hex key size. */
  setScrewKey: number;
}

export const METRIC: Record<MetricSize, MetricSpec> = {
  M2: {
    d: 2,
    pitch: 0.4,
    tapDrill: 1.6,
    clearance: { close: 2.2, normal: 2.4, loose: 2.6 },
    counterbore: { diameter: 4.3, depth: 2.4 },
    countersink: { diameter: 4.4, angle: 90 },
    socketHead: { dk: 3.8, k: 2, key: 1.5 },
    buttonHead: { dk: 3.5, k: 1.1, key: 1.3 }, // scaled from M3 (no ISO 7380 M2)
    flatHead: { dk: 4, key: 1.3 },
    hexHead: { s: 4, k: 1.4 },
    nut: { s: 4, m: 1.6 },
    setScrewKey: 0.9,
  },
  "M2.5": {
    d: 2.5,
    pitch: 0.45,
    tapDrill: 2.05,
    clearance: { close: 2.7, normal: 2.9, loose: 3.1 },
    counterbore: { diameter: 5, depth: 2.9 },
    countersink: { diameter: 5.5, angle: 90 },
    socketHead: { dk: 4.5, k: 2.5, key: 2 },
    buttonHead: { dk: 4.7, k: 1.4, key: 1.5 }, // scaled from M3 (no ISO 7380 M2.5)
    flatHead: { dk: 5, key: 1.5 },
    hexHead: { s: 5, k: 1.7 },
    nut: { s: 5, m: 2 },
    setScrewKey: 1.3,
  },
  M3: {
    d: 3,
    pitch: 0.5,
    tapDrill: 2.5,
    clearance: { close: 3.2, normal: 3.4, loose: 3.6 },
    counterbore: { diameter: 6, depth: 3.4 },
    countersink: { diameter: 6.3, angle: 90 },
    socketHead: { dk: 5.5, k: 3, key: 2.5 },
    buttonHead: { dk: 5.7, k: 1.65, key: 2 },
    flatHead: { dk: 6, key: 2 },
    hexHead: { s: 5.5, k: 2 },
    nut: { s: 5.5, m: 2.4 },
    setScrewKey: 1.5,
  },
  M4: {
    d: 4,
    pitch: 0.7,
    tapDrill: 3.3,
    clearance: { close: 4.3, normal: 4.5, loose: 4.8 },
    counterbore: { diameter: 8, depth: 4.4 },
    countersink: { diameter: 9.4, angle: 90 },
    socketHead: { dk: 7, k: 4, key: 3 },
    buttonHead: { dk: 7.6, k: 2.2, key: 2.5 },
    flatHead: { dk: 8, key: 2.5 },
    hexHead: { s: 7, k: 2.8 },
    nut: { s: 7, m: 3.2 },
    setScrewKey: 2,
  },
  M5: {
    d: 5,
    pitch: 0.8,
    tapDrill: 4.2,
    clearance: { close: 5.3, normal: 5.5, loose: 5.8 },
    counterbore: { diameter: 10, depth: 5.4 },
    countersink: { diameter: 10.4, angle: 90 },
    socketHead: { dk: 8.5, k: 5, key: 4 },
    buttonHead: { dk: 9.5, k: 2.75, key: 3 },
    flatHead: { dk: 10, key: 3 },
    hexHead: { s: 8, k: 3.5 },
    nut: { s: 8, m: 4.7 },
    setScrewKey: 2.5,
  },
  M6: {
    d: 6,
    pitch: 1,
    tapDrill: 5,
    clearance: { close: 6.4, normal: 6.6, loose: 7 },
    counterbore: { diameter: 11, depth: 6.4 },
    countersink: { diameter: 12.6, angle: 90 },
    socketHead: { dk: 10, k: 6, key: 5 },
    buttonHead: { dk: 10.5, k: 3.3, key: 4 },
    flatHead: { dk: 12, key: 4 },
    hexHead: { s: 10, k: 4 },
    nut: { s: 10, m: 5.2 },
    setScrewKey: 3,
  },
  M8: {
    d: 8,
    pitch: 1.25,
    tapDrill: 6.8,
    clearance: { close: 8.4, normal: 9, loose: 10 },
    counterbore: { diameter: 15, depth: 8.6 },
    countersink: { diameter: 17.3, angle: 90 },
    socketHead: { dk: 13, k: 8, key: 6 },
    buttonHead: { dk: 14, k: 4.4, key: 5 },
    flatHead: { dk: 16, key: 5 },
    hexHead: { s: 13, k: 5.3 },
    nut: { s: 13, m: 6.8 },
    setScrewKey: 4,
  },
  M10: {
    d: 10,
    pitch: 1.5,
    tapDrill: 8.5,
    clearance: { close: 10.5, normal: 11, loose: 12 },
    counterbore: { diameter: 18, depth: 10.6 },
    countersink: { diameter: 20, angle: 90 },
    socketHead: { dk: 16, k: 10, key: 8 },
    buttonHead: { dk: 17.5, k: 5.5, key: 6 },
    flatHead: { dk: 20, key: 6 },
    hexHead: { s: 16, k: 6.4 },
    nut: { s: 16, m: 8.4 },
    setScrewKey: 5,
  },
  M12: {
    d: 12,
    pitch: 1.75,
    tapDrill: 10.2,
    clearance: { close: 13, normal: 13.5, loose: 14.5 },
    counterbore: { diameter: 20, depth: 12.6 },
    countersink: { diameter: 24, angle: 90 },
    socketHead: { dk: 18, k: 12, key: 10 },
    buttonHead: { dk: 21, k: 6.6, key: 8 },
    flatHead: { dk: 24, key: 8 },
    hexHead: { s: 18, k: 7.5 },
    nut: { s: 18, m: 10.8 },
    setScrewKey: 6,
  },
};

export const isMetricSize = (s: string): s is MetricSize => (METRIC_SIZES as string[]).includes(s);
