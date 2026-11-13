// A content hash of what sync considers "the document": its name, its
// parametric `Document` and an assembly's `AssemblyDoc`, nothing else (no
// meshes, no view state, no dates).
// Keys are sorted first, so two equal documents hash equal however their
// objects were built — local state and a freshly parsed Drive file can list
// keys in different orders.
import type { Document } from "../document/types";
import type { AssemblyDoc } from "../assembly/types";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** `assembly` is left out of the canonical form when absent (undefined keys
 *  are dropped), so a part's hash is what it was before assemblies existed —
 *  no synced part looks edited after the upgrade. */
export async function docHash(name: string, doc: Document, assembly?: AssemblyDoc): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ name, doc, assembly }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
