// Pure operations on an AssemblyDoc. No DOM, no storage, no kernel — like
// document/document.ts is for parts.
import type { AssemblyDoc } from "./types";

export function createAssembly(): AssemblyDoc {
  return { instances: [], mates: [], variables: [] };
}

/** True for an assembly nobody has worked on yet — what "New → Assembly"
 *  makes. Sync leaves these on the device, as it does starter parts. */
export function isStarterAssembly(a: AssemblyDoc): boolean {
  return a.instances.length === 0 && a.mates.length === 0 && a.variables.length === 0;
}

/** Validate persisted assembly data (IndexedDB, a document file, Drive) and
 *  fill fields older saves lack. Throws on malformed data, the same contract as
 *  `migrateDocument`: callers must call this BEFORE adopting a record, so a
 *  corrupt one is never overwritten by an empty autosave. */
export function migrateAssembly(raw: unknown): AssemblyDoc {
  const a = raw as Partial<AssemblyDoc> | null;
  if (!a || typeof a !== "object" || !Array.isArray(a.instances)) {
    throw new Error("Assembly data is missing or corrupt.");
  }
  return {
    instances: a.instances,
    mates: Array.isArray(a.mates) ? a.mates : [],
    variables: Array.isArray(a.variables) ? a.variables : [],
  };
}
