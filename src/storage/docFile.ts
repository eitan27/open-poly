// The `.openpoly.json` document file (Phase 8.7 M3): a small envelope around
// the parametric `Document` for sharing/backup. Deliberately EXCLUDES cached
// meshes — they're a render cache, not truth, and would bloat a diffable file.
// Pure string↔object code (no DOM/IDB), so it's Node-testable.
import type { Document } from "../document/types";

export const DOC_FILE_FORMAT = "openpoly-doc";
/** Bump when the envelope itself (not the Document) changes shape. */
export const DOC_FILE_VERSION = 1;

export interface DocFile {
  format: typeof DOC_FILE_FORMAT;
  version: number;
  name: string;
  doc: Document;
}

export function serializeDocFile(name: string, doc: Document): string {
  const file: DocFile = { format: DOC_FILE_FORMAT, version: DOC_FILE_VERSION, name, doc };
  return JSON.stringify(file, null, 2);
}

/** Parse + validate a document file. Throws a READABLE error (surfaced as-is
 *  in the Documents dialog) — never returns a half-valid document. The caller
 *  still runs `migrateDocument` (older Document shapes) and assigns a FRESH id
 *  (an import must never silently overwrite an existing document). */
export function parseDocFile(text: string): { name: string; doc: Document } {
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
  return { name: typeof file.name === "string" && file.name.trim() ? file.name : "Imported", doc };
}
