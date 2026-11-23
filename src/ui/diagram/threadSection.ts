// One side of a modelled thread as it shows in a section through the axis:
// the profile's trapezoid (ISO by default: P/8 crest flat at `rMajor`, P/4
// root flat at `rMinor`, 60° flanks; `breaks` gives another, as fractions of a
// pitch — geom/thread.ts profileBreaks) repeated along z from z0 to z1, as
// (radius, z) points. `phase` shifts it along the axis — the far side of a
// section is half a pitch on. For the diagrams only; the solid comes from
// geom/thread.ts.
export function threadSection(
  rMajor: number,
  rMinor: number,
  pitch: number,
  z0: number,
  z1: number,
  phase = 0,
  breaks: number[] = [0, 1 / 8, 7 / 16, 11 / 16],
): [number, number][] {
  const P = pitch;
  const u = breaks.map((b) => b * P);
  const r = [rMajor, rMajor, rMinor, rMinor];
  const at = (z: number): number => {
    const t = (((z - phase) % P) + P) % P;
    for (let i = 0; i < 4; i++) {
      const u0 = u[i];
      const u1 = i === 3 ? P : u[i + 1];
      if (t <= u1) return r[i] + ((r[(i + 1) % 4] - r[i]) * (t - u0)) / (u1 - u0);
    }
    return rMajor;
  };
  const pts: [number, number][] = [[at(z0), z0]];
  const first = Math.floor((z0 - phase) / P);
  for (let k = first; phase + k * P < z1; k++)
    u.forEach((ui, i) => {
      const z = phase + k * P + ui;
      if (z > z0 && z < z1) pts.push([r[i], z]);
    });
  pts.push([at(z1), z1]);
  return pts;
}
