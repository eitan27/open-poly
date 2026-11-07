// The side panel of an open assembly, in place of a part's Variables /
// Timeline / Parts: what the assembly places, and how those are joined.
import type { AssemblyDoc } from "./types";
import "./AssemblyPanel.css";

export function AssemblyPanel({ assembly }: { assembly: AssemblyDoc }) {
  return (
    <>
      <h2>Instances ({assembly.instances.length})</h2>
      {assembly.instances.length === 0 ? (
        <p className="asm-empty">No parts placed yet.</p>
      ) : (
        <ul className="asm-list">
          {assembly.instances.map((inst) => (
            <li key={inst.id}>{inst.name}</li>
          ))}
        </ul>
      )}
      <h2>Mates ({assembly.mates.length})</h2>
      {assembly.mates.length === 0 && <p className="asm-empty">No mates yet.</p>}
    </>
  );
}
