// Pure operations on an AssemblyDoc. No DOM, no storage, no kernel — like
// document/document.ts is for parts.
import type { AssemblyDoc, Instance, Mat4, Mate, MateType } from "./types";
import { multiply } from "./placement";

const MATE_TYPES: MateType[] = ["fastened", "revolute", "slider", "cylindrical", "planar", "ball", "width"];

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
  for (const i of a.instances as Partial<Instance>[]) {
    const ok =
      i &&
      typeof i.id === "string" &&
      typeof i.source?.docId === "string" &&
      typeof i.source?.partId === "string" &&
      Array.isArray(i.transform) &&
      i.transform.length === 16;
    if (!ok) throw new Error("Assembly data is missing or corrupt.");
  }
  const mates = Array.isArray(a.mates) ? (a.mates as Partial<Mate>[]) : [];
  const side = (c: Mate["a"] | undefined, width: boolean) =>
    !!c &&
    typeof c.instanceId === "string" &&
    typeof c.ref?.name === "string" &&
    typeof c.anchor === "string" &&
    (width ? typeof c.ref2?.name === "string" : c.ref2 === undefined || typeof c.ref2.name === "string");
  for (const m of mates) {
    const width = m?.type === "width";
    const ok =
      m && typeof m.id === "string" && MATE_TYPES.includes(m.type as MateType) && side(m.a, width) && side(m.b, width);
    if (!ok) throw new Error("Assembly data is missing or corrupt.");
  }
  return {
    instances: a.instances,
    mates: mates as Mate[],
    variables: Array.isArray(a.variables) ? a.variables : [],
  };
}

/** The documents an assembly reads parts from, each once. */
export function referencedDocIds(a: AssemblyDoc): string[] {
  return [...new Set(a.instances.map((i) => i.source.docId))];
}

/** "Bracket <3>": the part's name and the lowest number not already taken by
 *  another instance of that name — Onshape's convention, so copies read as
 *  copies of one thing. */
export function nextInstanceName(a: AssemblyDoc, partName: string, taken: string[] = []): string {
  const used = new Set([...a.instances.map((i) => i.name), ...taken]);
  for (let n = 1; ; n++) {
    const name = `${partName} <${n}>`;
    if (!used.has(name)) return name;
  }
}

/** Place one instance per part of a document. The first instance an assembly
 *  ever gets is grounded, as in Onshape, so mates have something fixed to
 *  build from. Resolves the new assembly and the new instances' ids. */
export function insertInstances(
  a: AssemblyDoc,
  docId: string,
  parts: { partId: string; name: string; transform: Mat4 }[],
  genId: () => string,
): { assembly: AssemblyDoc; ids: string[] } {
  const added: Instance[] = [];
  for (const p of parts) {
    added.push({
      id: genId(),
      name: nextInstanceName(
        a,
        p.name,
        added.map((i) => i.name),
      ),
      source: { docId, partId: p.partId },
      transform: p.transform,
      ...(a.instances.length === 0 && added.length === 0 ? { grounded: true } : {}),
    });
  }
  return { assembly: { ...a, instances: [...a.instances, ...added] }, ids: added.map((i) => i.id) };
}

/** Patch one instance. Unknown ids leave the assembly as it is. */
export function updateInstance(
  a: AssemblyDoc,
  id: string,
  patch: Partial<Pick<Instance, "name" | "grounded" | "hidden" | "color" | "transform">>,
): AssemblyDoc {
  if (!a.instances.some((i) => i.id === id)) return a;
  return {
    ...a,
    instances: a.instances.map((i) => {
      if (i.id !== id) return i;
      const next: Instance = { ...i, ...patch };
      // Absent, not false/undefined, so a saved assembly only says what's set.
      for (const k of ["grounded", "hidden", "color"] as const)
        if (next[k] === undefined || next[k] === false) delete next[k];
      return next;
    }),
  };
}

/** Move an instance by a world-space motion (applied after its placement). A
 *  grounded instance doesn't move: unground it first. */
export function moveInstance(a: AssemblyDoc, id: string, motion: Mat4): AssemblyDoc {
  const inst = a.instances.find((i) => i.id === id);
  if (!inst || inst.grounded) return a;
  return updateInstance(a, id, { transform: multiply(motion, inst.transform) });
}

/** Remove instances, and the mates that joined them to anything. */
export function removeInstances(a: AssemblyDoc, ids: string[]): AssemblyDoc {
  const drop = new Set(ids);
  return {
    ...a,
    instances: a.instances.filter((i) => !drop.has(i.id)),
    mates: a.mates.filter((m) => !drop.has(m.a.instanceId) && !drop.has(m.b.instanceId)),
  };
}

const TYPE_NAMES: Record<MateType, string> = {
  fastened: "Fastened",
  revolute: "Revolute",
  slider: "Slider",
  cylindrical: "Cylindrical",
  planar: "Planar",
  ball: "Ball",
  width: "Width",
};

/** "Revolute 2": the type and the lowest number not taken. */
export function nextMateName(a: AssemblyDoc, type: MateType): string {
  const used = new Set(a.mates.map((m) => m.name));
  for (let n = 1; ; n++) {
    const name = `${TYPE_NAMES[type]} ${n}`;
    if (!used.has(name)) return name;
  }
}

export function addMate(a: AssemblyDoc, mate: Mate): AssemblyDoc {
  return { ...a, mates: [...a.mates, mate] };
}

/** Replace one mate (matched by id). Unknown ids leave the assembly as it is. */
export function updateMate(a: AssemblyDoc, mate: Mate): AssemblyDoc {
  if (!a.mates.some((m) => m.id === mate.id)) return a;
  return { ...a, mates: a.mates.map((m) => (m.id === mate.id ? mate : m)) };
}

export function removeMates(a: AssemblyDoc, ids: string[]): AssemblyDoc {
  const drop = new Set(ids);
  return { ...a, mates: a.mates.filter((m) => !drop.has(m.id)) };
}

/** Store solved placements as the instances' own, so a part a mate was
 *  holding stays where it is when that mate goes (rather than jumping back to
 *  wherever it was before it was mated). */
export function keepPlacements(a: AssemblyDoc, placements: ReadonlyMap<string, Mat4>): AssemblyDoc {
  let changed = false;
  const instances = a.instances.map((i) => {
    const p = placements.get(i.id);
    if (!p || p === i.transform || p.every((v, k) => v === i.transform[k])) return i;
    changed = true;
    return { ...i, transform: p };
  });
  return changed ? { ...a, instances } : a;
}
