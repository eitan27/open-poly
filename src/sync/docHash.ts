// A content hash of what sync considers "the document": its name and its
// parametric `Document`, nothing else (no meshes, no view state, no dates).
// Keys are sorted first, so two equal documents hash equal however their
// objects were built — local state and a freshly parsed Drive file can list
// keys in different orders.
import type { Document } from "../document/types";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export async function docHash(name: string, doc: Document): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ name, doc }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
