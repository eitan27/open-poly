// Derives readable measurements for the current selection (length / radius /
// area / coordinates), used by the bottom-right info pane.
import type { Document } from "../document/types";
import type { MeshedEdges, MeshedFaces } from "../kernel/types";
import type { FeatureMesh, Selection } from "../viewport/Viewport";

export interface MeasureInfo {
  title: string;
  rows: { label: string; value: string }[];
}

const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000;
  return Number.isInteger(r) ? String(r) : r.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
};

/** Sum of triangle areas belonging to one face group of a tessellated body. */
function faceArea(faces: MeshedFaces, faceId: number): number {
  const g = faces.faceGroups?.find((fg) => fg.faceId === faceId);
  if (!g) return 0;
  const { triangles, vertices } = faces;
  let area = 0;
  for (let k = g.start; k + 2 < g.start + g.count; k += 3) {
    const i0 = triangles[k] * 3;
    const i1 = triangles[k + 1] * 3;
    const i2 = triangles[k + 2] * 3;
    const ax = vertices[i1] - vertices[i0];
    const ay = vertices[i1 + 1] - vertices[i0 + 1];
    const az = vertices[i1 + 2] - vertices[i0 + 2];
    const bx = vertices[i2] - vertices[i0];
    const by = vertices[i2 + 1] - vertices[i0 + 1];
    const bz = vertices[i2 + 2] - vertices[i0 + 2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    area += 0.5 * Math.hypot(cx, cy, cz);
  }
  return area;
}

/** Summed segment length of one edge group of a tessellated body. */
function edgeLength(edges: MeshedEdges, edgeId: number): number {
  const g = edges.edgeGroups?.find((eg) => eg.edgeId === edgeId);
  if (!g) return 0;
  const { lines } = edges;
  let len = 0;
  for (let v = g.start; v + 1 < g.start + g.count; v += 2) {
    const a = v * 3;
    const b = (v + 1) * 3;
    len += Math.hypot(lines[b] - lines[a], lines[b + 1] - lines[a + 1], lines[b + 2] - lines[a + 2]);
  }
  return len;
}

export function measureSelection(
  selection: Selection | null,
  doc: Document,
  meshes: FeatureMesh[],
): MeasureInfo | null {
  if (!selection) return null;

  if (selection.kind === "sketchEntity") {
    const sk = doc.features.find((f) => f.id === selection.sketchId);
    if (sk?.type !== "sketch") return null;
    const e = sk.entities.find((x) => x.id === selection.entityId);
    if (!e) return null;
    if (e.type === "line") {
      return { title: "Line", rows: [{ label: "Length", value: fmt(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])) }] };
    }
    if (e.type === "circle") {
      return {
        title: "Circle",
        rows: [
          { label: "Radius", value: fmt(e.r) },
          { label: "Diameter", value: fmt(2 * e.r) },
        ],
      };
    }
    if (e.type === "arc") {
      return {
        title: "Arc",
        rows: [
          { label: "Radius", value: fmt(e.r) },
          { label: "Arc length", value: fmt(e.r * Math.abs(e.end - e.start)) },
        ],
      };
    }
    return null;
  }

  if (selection.kind === "sketchPoint") {
    return {
      title: "Point",
      rows: [
        { label: "X", value: fmt(selection.point[0]) },
        { label: "Y", value: fmt(selection.point[1]) },
      ],
    };
  }

  if (selection.kind === "vertex") {
    return {
      title: "Vertex",
      rows: [
        { label: "X", value: fmt(selection.point[0]) },
        { label: "Y", value: fmt(selection.point[1]) },
        { label: "Z", value: fmt(selection.point[2]) },
      ],
    };
  }

  if (selection.kind === "face") {
    const m = meshes.find((x) => x.id === selection.featureId);
    if (!m) return null;
    return { title: "Face", rows: [{ label: "Area", value: fmt(faceArea(m.mesh.faces, selection.faceId)) }] };
  }

  if (selection.kind === "edge") {
    const m = meshes.find((x) => x.id === selection.featureId);
    if (!m) return null;
    return { title: "Edge", rows: [{ label: "Length", value: fmt(edgeLength(m.mesh.edges, selection.edgeId)) }] };
  }

  return null;
}
