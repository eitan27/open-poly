// Exporting an assembly as files for printing, viewing or making it, from the
// meshes it shows (each instance's part mesh at its solved placement):
//
// - 3MF, assembled: one file, each instance a separate named, coloured object
//   where it sits in the assembly. Placements are baked into the vertices
//   (not left as build-item transforms), so every slicer shows the assembly
//   as built. The format to print or view the whole thing.
// - STL, assembled: every instance merged into one mesh, for tools that only
//   take STL. It can't be told apart again.
// - STL, each part once: one file per distinct part in its own coordinates,
//   with how many the assembly uses in its name ("Bolt ×8.stl"), zipped. For
//   making the parts.
//
// Hidden instances are left out: hiding one says it isn't part of what's
// shown. All lengths are millimetres.
import { zipSync, strToU8 } from "fflate";
import { applyPoint, IDENTITY } from "./placement";
import type { AssemblyDoc, Mat4 } from "./types";
import type { SourceState } from "./useAssemblySources";
import type { ShapeMeshPayload } from "../kernel/types";

export type AssemblyExportKind = "3mf" | "stl" | "stl-parts";

/** One instance as exported: its mesh in part coordinates and where it sits. */
export interface ExportPiece {
  name: string;
  /** Distinct per part (document + part id). */
  partKey: string;
  partName: string;
  mesh: ShapeMeshPayload;
  transform: Mat4;
  color: number;
}

/** The instances to export: visible ones whose part has loaded, at their
 *  solved placements (else their own). */
export function exportPieces(
  assembly: AssemblyDoc,
  sources: ReadonlyMap<string, SourceState>,
  placements: ReadonlyMap<string, Mat4> | undefined,
): ExportPiece[] {
  const out: ExportPiece[] = [];
  for (const i of assembly.instances) {
    if (i.hidden) continue;
    const src = sources.get(i.source.docId);
    const part = src?.status === "ready" ? src.parts.find((p) => p.partId === i.source.partId) : undefined;
    if (!part) continue;
    out.push({
      name: i.name,
      partKey: `${i.source.docId}/${i.source.partId}`,
      partName: part.name,
      mesh: part.mesh,
      transform: placements?.get(i.id) ?? i.transform,
      color: i.color ?? part.color,
    });
  }
  return out;
}

/** A triangle mesh with shared vertices: `positions` xyz, `indices` three per
 *  triangle. */
export interface IndexedMesh {
  positions: Float64Array;
  indices: Uint32Array;
}

/** `mesh`'s triangles moved by `m`, with vertices at the same place (to 1e-5
 *  mm) welded into one: a mesh tessellated face by face repeats each edge's
 *  vertices, and 3MF wants every edge shared by the triangles on both sides.
 *  Degenerate triangles (two corners welded together) are dropped. */
export function weld(mesh: ShapeMeshPayload, m: Mat4 = IDENTITY): IndexedMesh {
  const { vertices: v, triangles: t } = mesh.faces;
  const key = new Map<string, number>();
  const pos: number[] = [];
  const remap = new Uint32Array(v.length / 3);
  for (let i = 0; i < v.length / 3; i++) {
    const p = applyPoint(m, [v[3 * i], v[3 * i + 1], v[3 * i + 2]]);
    const k = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
    let at = key.get(k);
    if (at === undefined) {
      at = pos.length / 3;
      key.set(k, at);
      pos.push(p[0], p[1], p[2]);
    }
    remap[i] = at;
  }
  const idx: number[] = [];
  for (let k = 0; k + 2 < t.length; k += 3) {
    const a = remap[t[k]],
      b = remap[t[k + 1]],
      c = remap[t[k + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) };
}

/** A binary STL of `meshes`, merged. */
export function toStl(meshes: IndexedMesh[], name = "Open Poly"): Uint8Array {
  const count = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + 50 * count);
  const out = new Uint8Array(buf);
  out.set(strToU8(name.slice(0, 80)));
  const dv = new DataView(buf);
  dv.setUint32(80, count, true);
  let o = 84;
  for (const { positions: p, indices: ix } of meshes)
    for (let k = 0; k < ix.length; k += 3) {
      const [a, b, c] = [ix[k] * 3, ix[k + 1] * 3, ix[k + 2] * 3];
      const ux = p[b] - p[a],
        uy = p[b + 1] - p[a + 1],
        uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a],
        vy = p[c + 1] - p[a + 1],
        vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      for (const x of [nx, ny, nz]) {
        dv.setFloat32(o, x, true);
        o += 4;
      }
      for (const i of [a, b, c])
        for (let j = 0; j < 3; j++) {
          dv.setFloat32(o, p[i + j], true);
          o += 4;
        }
      dv.setUint16(o, 0, true);
      o += 2;
    }
  return out;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (c: number) => "#" + c.toString(16).padStart(6, "0").toUpperCase() + "FF";
/** Coordinates as 3MF wants them: plain decimals, to a micron's tenth. */
const num = (x: number) => String(Math.round(x * 1e4) / 1e4);

/** A 3MF package of `pieces`: each a separate object, named and coloured,
 *  its placement baked into its vertices. */
export function to3mf(pieces: ExportPiece[], title: string): Uint8Array {
  const colors = [...new Set(pieces.map((p) => p.color))];
  const objects: string[] = [];
  const items: string[] = [];
  pieces.forEach((piece, k) => {
    const { positions: p, indices: ix } = weld(piece.mesh, piece.transform);
    const id = k + 2; // 1 is the materials
    const verts: string[] = [];
    for (let i = 0; i < p.length; i += 3)
      verts.push(`<vertex x="${num(p[i])}" y="${num(p[i + 1])}" z="${num(p[i + 2])}"/>`);
    const tris: string[] = [];
    for (let i = 0; i < ix.length; i += 3) tris.push(`<triangle v1="${ix[i]}" v2="${ix[i + 1]}" v3="${ix[i + 2]}"/>`);
    objects.push(
      `<object id="${id}" type="model" name="${xml(piece.name)}" pid="1" pindex="${colors.indexOf(piece.color)}">` +
        `<mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`,
    );
    items.push(`<item objectid="${id}"/>`);
  });
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${xml(title)}</metadata>` +
    `<metadata name="Application">Open Poly</metadata>` +
    `<resources><basematerials id="1">` +
    colors.map((c, i) => `<base name="Colour ${i + 1}" displaycolor="${hex(c)}"/>`).join("") +
    `</basematerials>${objects.join("")}</resources>` +
    `<build>${items.join("")}</build></model>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ),
    "3D/3dmodel.model": strToU8(model),
  });
}

/** One file name per distinct part — "Bolt ×8.stl", "Plate.stl" — made safe
 *  for a file system and unique. */
export function partFiles(pieces: ExportPiece[]): { name: string; piece: ExportPiece; count: number }[] {
  const byPart = new Map<string, { piece: ExportPiece; count: number }>();
  for (const p of pieces) {
    const cur = byPart.get(p.partKey);
    if (cur) cur.count++;
    else byPart.set(p.partKey, { piece: p, count: 1 });
  }
  const used = new Set<string>();
  return [...byPart.values()].map(({ piece, count }) => {
    const base = (piece.partName.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Part") + (count > 1 ? ` ×${count}` : "");
    let name = `${base}.stl`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).stl`;
    used.add(name.toLowerCase());
    return { name, piece, count };
  });
}

/** The file for `kind`: its bytes, type and extension. */
export function exportAssemblyFile(
  kind: AssemblyExportKind,
  pieces: ExportPiece[],
  title: string,
): { bytes: Uint8Array; type: string; extension: string } {
  if (kind === "3mf") return { bytes: to3mf(pieces, title), type: "model/3mf", extension: "3mf" };
  if (kind === "stl")
    return {
      bytes: toStl(
        pieces.map((p) => weld(p.mesh, p.transform)),
        title,
      ),
      type: "model/stl",
      extension: "stl",
    };
  const files: Record<string, Uint8Array> = {};
  for (const f of partFiles(pieces)) files[f.name] = toStl([weld(f.piece.mesh)], f.piece.partName);
  return { bytes: zipSync(files), type: "application/zip", extension: "zip" };
}
