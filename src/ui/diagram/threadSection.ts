// One side of a modelled ISO thread as it shows in a section through the axis:
// the basic trapezoid (P/8 crest flat at `rMajor`, P/4 root flat at `rMinor`,
// 60° flanks) repeated along z from z0 to z1, as (radius, z) points. `phase`
// shifts it along the axis — the far side of a section is half a pitch on.
// For the diagrams only; the solid comes from geom/thread.ts.
export function threadSection(
  rMajor: number,
  rMinor: number,
  pitch: number,
  z0: number,
  z1: number,
  phase = 0,
): [number, number][] {
  const P = pitch;
  const u = [0, P / 8, (7 * P) / 16, (11 * P) / 16];
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
    for (const ui of u) {
      const z = phase + k * P + ui;
      if (z > z0 && z < z1) pts.push([r[u.indexOf(ui)], z]);
    }
  pts.push([at(z1), z1]);
  return pts;
}
