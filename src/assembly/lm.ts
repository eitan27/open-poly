// A small dense Levenberg–Marquardt least-squares solver, for the assembly's
// loop groups (solve.ts). Assemblies are tiny — a loop group is a handful of
// parts, six unknowns each — so a numeric Jacobian and a dense Cholesky solve
// are plenty, and keep the solver free of any idea of what it's solving.
//
// The damping is λ·I rather than λ·diag(JᵀJ): directions the residuals don't
// care about (a linkage's free motion) then get no step at all, so the answer
// is the one nearest the starting point. That's what keeps a linkage from
// flipping to its other solution, and what "move the other parts as little as
// possible" needs.

export interface LmResult {
  x: number[];
  /** Sum of squared residuals at `x`. */
  cost: number;
  /** Largest residual at `x`, in absolute value. */
  worst: number;
  iterations: number;
}

/** Minimise |f(x)|² from `x0`. Stops when every residual is under `tol`, when
 *  steps stop helping, or after `maxIterations`. */
export function levenbergMarquardt(
  f: (x: number[]) => number[],
  x0: number[],
  { tol = 1e-9, maxIterations = 100 }: { tol?: number; maxIterations?: number } = {},
): LmResult {
  const n = x0.length;
  let x = x0.slice();
  let r = f(x);
  let cost = sumSq(r);
  let iterations = 0;
  let lambda = 1e-3;
  if (n === 0) return { x, cost, worst: maxAbs(r), iterations };

  while (iterations < maxIterations && maxAbs(r) > tol) {
    iterations++;
    const m = r.length;
    // Forward-difference Jacobian, m × n, row-major.
    const J = new Float64Array(m * n);
    for (let j = 0; j < n; j++) {
      const h = 1e-7 * Math.max(1, Math.abs(x[j]));
      const xp = x.slice();
      xp[j] += h;
      const rp = f(xp);
      for (let i = 0; i < m; i++) J[i * n + j] = (rp[i] - r[i]) / h;
    }
    const A = new Float64Array(n * n);
    const g = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const ri = r[i];
      for (let a = 0; a < n; a++) {
        const ja = J[i * n + a];
        if (ja === 0) continue;
        g[a] += ja * ri;
        for (let b = a; b < n; b++) A[a * n + b] += ja * J[i * n + b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a];
    // A floor on λ, relative to the problem's scale, so the null directions
    // (free motion) can't be amplified out of round-off.
    let trace = 0;
    for (let a = 0; a < n; a++) trace += A[a * n + a];
    const floor = 1e-10 * Math.max(trace / n, 1e-12);

    let accepted = false;
    while (lambda < 1e12) {
      const L = Math.max(lambda, floor);
      const M = A.slice();
      for (let a = 0; a < n; a++) M[a * n + a] += L;
      const dx = choleskySolve(M, g, n);
      if (dx) {
        const xn = x.map((v, k) => v - dx[k]);
        const rn = f(xn);
        const cn = sumSq(rn);
        if (cn < cost) {
          const step = Math.sqrt(sumSq(dx));
          const gain = cost - cn;
          x = xn;
          r = rn;
          lambda = Math.max(lambda / 3, 1e-12);
          accepted = true;
          // Settled: a vanishing step, or a cost that has stopped falling (a
          // conflict that can't be satisfied ends here rather than grinding on).
          const settled = step < 1e-14 || gain <= 1e-12 * cost;
          cost = cn;
          if (settled) return { x, cost, worst: maxAbs(r), iterations };
          break;
        }
      }
      lambda *= 4;
    }
    if (!accepted) break; // no step lowers the cost: a (local) minimum
  }
  return { x, cost, worst: maxAbs(r), iterations };
}

/** Solve M·x = b for a symmetric positive-definite M (n × n, row-major).
 *  Null if M isn't positive definite. */
function choleskySolve(M: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > 0)) return null;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

const sumSq = (v: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return s;
};
const maxAbs = (v: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < v.length; i++) s = Math.max(s, Math.abs(v[i]));
  return s;
};
