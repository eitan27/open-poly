// A still picture of one part's mesh, for the Insert dialog: so a row shows
// what will be inserted, not just its colour. Drawn on a 2D canvas (flat-shaded
// triangles, back to front, from the isometric corner the view cube's Home
// uses, Z up) rather than a WebGL context each: a document can have many parts,
// and browsers cap live WebGL contexts at a handful.
import { useEffect, useRef } from "react";
import type { ShapeMeshPayload } from "../kernel/types";

const HEIGHT = 140;

/** Screen-space triangles of `mesh` seen from the isometric corner (+X, -Y, +Z
 *  towards the viewer), sorted back to front, each with its shade 0–1. */
function isoTriangles(mesh: ShapeMeshPayload): {
  tris: { pts: [number, number][]; shade: number }[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
} {
  const v = mesh.faces.vertices;
  const t = mesh.faces.triangles;
  // Camera basis: looking from (1, -1, 1) at the origin, Z up.
  const s2 = Math.SQRT1_2;
  const s6 = 1 / Math.sqrt(6);
  const s3 = 1 / Math.sqrt(3);
  const right = [s2, s2, 0];
  const up = [-s6, s6, 2 * s6];
  const toward = [s3, -s3, s3];
  const light = norm([0.4, -0.7, 1]);
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const out: { pts: [number, number][]; shade: number; depth: number }[] = [];
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (let i = 0; i + 2 < t.length; i += 3) {
    const p = [t[i], t[i + 1], t[i + 2]].map((k) => [v[3 * k], v[3 * k + 1], v[3 * k + 2]]);
    const e1 = p[1].map((x, j) => x - p[0][j]);
    const e2 = p[2].map((x, j) => x - p[0][j]);
    const n = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
    // Skip faces turned away; a closed solid's front faces cover them.
    if (dot(n, toward) < 0) continue;
    const pts = p.map((q) => [dot(q, right), -dot(q, up)] as [number, number]);
    for (const [x, y] of pts) {
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
    const depth = (dot(p[0], toward) + dot(p[1], toward) + dot(p[2], toward)) / 3;
    out.push({ pts, shade: 0.45 + 0.55 * Math.max(0, dot(n, light)), depth });
  }
  out.sort((a, b) => a.depth - b.depth);
  return { tris: out, bounds };
}

function norm(a: number[]): number[] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function PartPreview({ mesh, color }: { mesh: ShapeMeshPayload; color: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, HEIGHT);
    const { tris, bounds } = isoTriangles(mesh);
    if (!tris.length) return;
    const pad = 12;
    const bw = bounds.maxX - bounds.minX || 1;
    const bh = bounds.maxY - bounds.minY || 1;
    const k = Math.min((w - 2 * pad) / bw, (HEIGHT - 2 * pad) / bh);
    const ox = (w - bw * k) / 2 - bounds.minX * k;
    const oy = (HEIGHT - bh * k) / 2 - bounds.minY * k;
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    ctx.lineJoin = "round";
    ctx.lineWidth = 0.6;
    for (const tri of tris) {
      const c = `rgb(${Math.round(r * tri.shade)},${Math.round(g * tri.shade)},${Math.round(b * tri.shade)})`;
      ctx.beginPath();
      ctx.moveTo(ox + tri.pts[0][0] * k, oy + tri.pts[0][1] * k);
      ctx.lineTo(ox + tri.pts[1][0] * k, oy + tri.pts[1][1] * k);
      ctx.lineTo(ox + tri.pts[2][0] * k, oy + tri.pts[2][1] * k);
      ctx.closePath();
      ctx.fillStyle = c;
      // Stroked in its own colour too, so neighbouring triangles leave no
      // hairline seams between them.
      ctx.strokeStyle = c;
      ctx.fill();
      ctx.stroke();
    }
  }, [mesh, color]);
  return <canvas ref={ref} className="insert-preview" style={{ height: HEIGHT }} aria-hidden />;
}
