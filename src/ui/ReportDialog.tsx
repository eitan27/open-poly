// "Report an issue" modal. Gathers a description + category and, optionally, the
// current document and a screenshot — the context that actually makes a CAD bug
// reproducible — then POSTs to the /api/report Pages Function (which holds the
// GitHub token and files the issue). No secrets here; this is all client code.
import { useEffect, useRef, useState } from "react";
import { Modal, ModalHeader } from "./Modal";

interface Props {
  onClose: () => void;
  /** Stringified current document (.openpoly.json), or null if unavailable. */
  getDocJson: () => string | null;
  /** A PNG data URL of the current viewport, or null. */
  getScreenshot: () => string | null;
  /** Deployed build id, shown to the user and sent for triage. */
  version: string;
}

// Screenshot attach isn't wired up yet, so its option is hidden. Flip to true
// once it is (the getScreenshot plumbing is already in place).
const SCREENSHOTS_SUPPORTED = false;

type Category = "bug" | "missing_feature" | "confusing" | "other";
const CATEGORIES: { value: Category; label: string }[] = [
  { value: "bug", label: "🐛 Bug" },
  { value: "missing_feature", label: "✨ Missing feature" },
  { value: "confusing", label: "❓ Confusing / unclear" },
  { value: "other", label: "💬 Other feedback" },
];

export function ReportDialog({ onClose, getDocJson, getScreenshot, version }: Props) {
  const [category, setCategory] = useState<Category>("bug");
  const [description, setDescription] = useState("");
  // Default OFF (opt-in) — the document may hold geometry the user would rather
  // not send. Screenshot stays off + hidden until it's supported.
  const [includeDoc, setIncludeDoc] = useState(false);
  const [includeShot, setIncludeShot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string; error?: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!description.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category,
          description,
          doc: includeDoc ? (getDocJson() ?? undefined) : undefined,
          screenshot: includeShot ? (getScreenshot() ?? undefined) : undefined,
          meta: { version, ua: navigator.userAgent, url: location.href },
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) setResult({ url: data.url });
      else
        setResult({ error: data.error ?? `Failed (${res.status}). Reporting may not be configured on this deploy.` });
    } catch {
      setResult({ error: "Network error — could not reach the report endpoint." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} ariaLabel="Report an issue" className="report-dialog">
      <ModalHeader title="Report an issue" onClose={onClose} />

      {result?.url ? (
        <div className="report-done">
          <p>Thanks — your report was filed.</p>
          {/* A "View issue ↗" link (href={result.url}) belongs here, but the repo
                is private so the link would 404 for reporters. Restore it once
                open-poly is public. See memory: report-issue-feature. */}
          <button className="report-submit" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <>
          <label className="report-field">
            <span>Type</span>
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="report-field">
            <span>What happened?</span>
            <textarea
              ref={textRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the problem, and what you expected instead…"
              rows={5}
            />
          </label>
          <div className="report-attach">
            <label>
              <input type="checkbox" checked={includeDoc} onChange={(e) => setIncludeDoc(e.target.checked)} /> Include
              my current document (helps reproduce)
            </label>
            {SCREENSHOTS_SUPPORTED && (
              <label>
                <input type="checkbox" checked={includeShot} onChange={(e) => setIncludeShot(e.target.checked)} />{" "}
                Include a screenshot
              </label>
            )}
          </div>
          <p className="report-note">
            Also sent: app version <code>{version.slice(0, 12)}</code>, your browser, and the page URL.
          </p>
          {result?.error && <p className="report-error">{result.error}</p>}
          <div className="report-actions">
            <button className="report-cancel" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="report-submit" onClick={submit} disabled={busy || !description.trim()}>
              {busy ? "Sending…" : "Send report"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
