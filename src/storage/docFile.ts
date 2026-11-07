// The `.openpoly.json` document file: a small envelope around
// the parametric `Document` for sharing/backup. Deliberately EXCLUDES cached
// meshes — they're a render cache, not truth, and would bloat a diffable file.
// Pure string↔object code (no DOM/IDB), so it's Node-testable.
import type { Document } from "../document/types";
import type { AssemblyDoc } from "../assembly/types";
import { migrateAssembly } from "../assembly/assembly";

export const DOC_FILE_FORMAT = "openpoly-doc";
/** Bump when the envelope itself (not the Document) changes shape. Version 2
 *  added `assembly`. Part files are still WRITTEN as version 1, so a build from
 *  before assemblies keeps opening them; only an assembly file says 2, so that
 *  build refuses it ("saved by a newer version") instead of importing it as an
 *  empty part. */
export const DOC_FILE_VERSION = 2;

export interface DocFile {
  format: typeof DOC_FILE_FORMAT;
  version: number;
  name: string;
  doc: Document;
  assembly?: AssemblyDoc;
}

export function serializeDocFile(name: string, doc: Document, assembly?: AssemblyDoc): string {
  const file: DocFile = assembly
    ? { format: DOC_FILE_FORMAT, version: 2, name, doc, assembly }
    : { format: DOC_FILE_FORMAT, version: 1, name, doc };
  return JSON.stringify(file, null, 2);
}

/** Parse + validate a document file. Throws a READABLE error (surfaced as-is
 *  in the Documents dialog) — never returns a half-valid document. The caller
 *  still runs `migrateDocument` (older Document shapes) and assigns a FRESH id
 *  (an import must never silently overwrite an existing document). */
export function parseDocFile(text: string): { name: string; doc: Document; assembly?: AssemblyDoc } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not a JSON file.");
  }
  const file = raw as Partial<DocFile> | null;
  if (!file || typeof file !== "object" || file.format !== DOC_FILE_FORMAT) {
    throw new Error("Not an Open Poly document file.");
  }
  if (typeof file.version !== "number" || file.version > DOC_FILE_VERSION) {
    throw new Error("This file was saved by a newer version of Open Poly.");
  }
  const doc = file.doc as Document | undefined;
  if (!doc || !Array.isArray(doc.features) || !Array.isArray(doc.variables)) {
    throw new Error("Document data is missing or corrupt.");
  }
  let assembly: AssemblyDoc | undefined;
  if (file.assembly !== undefined) {
    try {
      assembly = migrateAssembly(file.assembly);
    } catch {
      throw new Error("Assembly data is missing or corrupt.");
    }
  }
  const name = typeof file.name === "string" && file.name.trim() ? file.name : "Imported";
  return assembly ? { name, doc, assembly } : { name, doc };
}
