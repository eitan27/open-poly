// The Interference panel's state: what was checked (the selection when it
// opened, or everything), the report, which overlap is shown, and whether the
// assembly has moved on since (then the report is stale until checked again).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Kernel } from "../kernel/types";
import type { GhostMesh } from "../viewport/types";
import { checkInterference, type InterferenceReport } from "./interference";
import type { Solution } from "./solve";
import type { AssemblyDoc } from "./types";
import type { SourceState } from "./useAssemblySources";

export function useInterference({
  assembly,
  solution,
  sources,
  kernel,
  selected,
  setSelected,
}: {
  assembly: AssemblyDoc | null;
  solution: Solution | null;
  sources: ReadonlyMap<string, SourceState>;
  kernel: { current: Pick<Kernel, "interfere"> | null };
  selected: string[];
  setSelected: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<InterferenceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  // What the report was made from: any change after it makes it stale.
  const [checkedAt, setCheckedAt] = useState<{
    a: AssemblyDoc;
    s: Solution | null;
    /** Instance names then: a stale report still names a part since removed. */
    names: Map<string, string>;
  } | null>(null);
  const runId = useRef(0);

  const run = async (ids: string[] = scope) => {
    const k = kernel.current;
    if (!assembly || !k) return;
    const id = ++runId.current;
    setRunning(true);
    setError(null);
    setShown(null);
    try {
      const r = await checkInterference(k, assembly, sources, solution?.placements, new Set(ids));
      if (id !== runId.current) return;
      if (typeof r === "string") {
        setError(r);
        setReport(null);
      } else setReport(r);
      setCheckedAt({ a: assembly, s: solution, names: new Map(assembly.instances.map((i) => [i.id, i.name])) });
    } catch (e) {
      if (id === runId.current) setError(String((e as Error)?.message ?? e));
    } finally {
      if (id === runId.current) setRunning(false);
    }
  };

  /** Open on the selection (or everything), and check. */
  const openPanel = () => {
    setOpen(true);
    setScope(selected);
    setReport(null);
    void run(selected);
  };
  const close = () => {
    runId.current++;
    setOpen(false);
    setReport(null);
    setRunning(false);
    setShown(null);
  };
  // Another assembly: close.
  useEffect(() => {
    if (!assembly) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assembly === null]);

  const stale = !!report && !!checkedAt && (checkedAt.a !== assembly || checkedAt.s !== solution) && !running;

  // The overlaps in removal red, on top of the parts (they're inside both).
  const ghosts = useMemo<GhostMesh[]>(() => {
    if (!open || !report || stale) return [];
    return report.clashes
      .filter((c, i) => c.mesh && (shown === null || shown === i))
      .map((c) => ({ mesh: c.mesh!, variant: "cut" as const }));
  }, [open, report, shown, stale]);

  const name = (id: string) =>
    assembly?.instances.find((i) => i.id === id)?.name ?? checkedAt?.names.get(id) ?? "a removed part";
  return {
    open,
    openPanel,
    close,
    ghosts,
    dialog: open
      ? {
          scope: scope.map(name),
          total: assembly?.instances.filter((i) => !i.hidden).length ?? 0,
          running,
          stale,
          error,
          report: report && {
            ...report,
            clashes: report.clashes.map((c) => ({ a: name(c.a), b: name(c.b), volume: c.volume })),
            errors: report.errors.map((e) => ({ a: name(e.a), b: name(e.b), error: e.error })),
          },
          shown,
          onShow: (i: number | null) => {
            setShown(i);
            const c = i === null ? null : report?.clashes[i];
            setSelected(c ? [c.a, c.b] : []);
          },
          onCheck: () => void run(),
          onCheckAll: () => {
            setScope([]);
            void run([]);
          },
          onClose: close,
        }
      : null,
  };
}

export type InterferenceDialogProps = NonNullable<ReturnType<typeof useInterference>["dialog"]>;
