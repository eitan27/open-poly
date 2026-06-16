import { useEffect, useRef, useState } from "react";
import { KernelClient } from "./kernel/KernelClient";
import type { BoxParams, ShapeMeshPayload } from "./kernel/types";
import { Viewport } from "./viewport/Viewport";
import "./App.css";

const DIMS: (keyof BoxParams)[] = ["width", "height", "depth"];

export default function App() {
  const kernelRef = useRef<KernelClient | null>(null);
  const [ready, setReady] = useState(false);

  const [params, setParams] = useState<BoxParams>({
    width: 40,
    height: 30,
    depth: 20,
  });
  const [mesh, setMesh] = useState<ShapeMeshPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Own the worker's lifecycle here so each mount cycle (incl. StrictMode's
  // mount/unmount/remount) gets a fresh, live kernel rather than a disposed one.
  useEffect(() => {
    const kernel = new KernelClient();
    kernelRef.current = kernel;
    setReady(true);
    return () => {
      kernel.dispose();
      kernelRef.current = null;
      setReady(false);
    };
  }, []);

  // Regenerate whenever a parameter changes — the kernel runs off-thread.
  useEffect(() => {
    const kernel = kernelRef.current;
    if (!ready || !kernel) return;
    let cancelled = false;
    setBusy(true);
    kernel
      .buildBox(params)
      .then((result) => {
        if (cancelled) return;
        setMesh(result);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("regeneration failed:", err);
        setError(String(err?.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [params, ready]);

  const update = (key: keyof BoxParams) => (value: number) =>
    setParams((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">open-shape</span>
        <span className="phase">Phase&nbsp;0 · foundation</span>
        <span
          className={`status ${error ? "err" : busy ? "busy" : "idle"}`}
          title={error ?? undefined}
        >
          {error ? "kernel error" : busy ? "regenerating…" : "up to date"}
        </span>
      </header>
      <div className="body">
        <aside className="panel">
          <h2>Box</h2>
          {DIMS.map((key) => (
            <label className="field" key={key}>
              <span className="field-name">{key}</span>
              <input
                type="range"
                min={1}
                max={120}
                value={params[key]}
                onChange={(e) => update(key)(Number(e.target.value))}
              />
              <input
                className="num"
                type="number"
                min={1}
                value={params[key]}
                onChange={(e) => update(key)(Number(e.target.value))}
              />
            </label>
          ))}
          {error && <p className="error-box">{error}</p>}
          <p className="hint">
            Drag a slider — the box is rebuilt by the OCCT kernel in a worker and
            re-tessellated into three.js.
          </p>
        </aside>
        <main className="viewport">
          <Viewport mesh={mesh} />
        </main>
      </div>
    </div>
  );
}
