// "Report an issue" modal. Gathers a description + category and, optionally, the
// current document and a screenshot — the context that actually makes a CAD bug
// reproducible — then POSTs to the /api/report Pages Function (which holds the
// GitHub token and files the issue). No secrets here; this is all client code.
import { useEffect, useRef, useState } from "react";
import { Modal, ModalHeader } from "./Modal";
import { loadTurnstile, turnstileSitekey } from "./turnstile";
import { REPO_ISSUES_URL } from "../lib/repo";

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

  // Turnstile. The token is short-lived and single-use, so it is state, not a
  // ref: submit is disabled until one arrives and again after it expires.
  // `check` distinguishes "still loading" from "loaded and waiting for the
  // user" from "unavailable" — the last must not strand a reporter behind a
  // widget that never appeared, so it offers GitHub instead (see below).
  const [token, setToken] = useState<string | null>(null);
  const [check, setCheck] = useState<"loading" | "ready" | "unavailable">("loading");
  const widgetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widgetId: string | undefined;
    let live = true;
    void loadTurnstile()
      .then((api) => {
        if (!live || !widgetRef.current) return;
        setCheck("ready");
        widgetId = api.render(widgetRef.current, {
          sitekey: turnstileSitekey(),
          // The app's OWN resolved theme, not Turnstile's "auto" — auto follows
          // the OS, which disagrees with an in-app theme override and leaves a
          // white widget in a dark dialog. applyTheme() stamps this attribute
          // on <html>, so it is already the right answer, with no plumbing.
          theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
          callback: (t) => setToken(t),
          "expired-callback": () => setToken(null),
          "error-callback": () => setCheck("unavailable"),
        });
      })
      .catch(() => {
        if (live) setCheck("unavailable");
      });
    return () => {
      live = false;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
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
          turnstileToken: token ?? undefined,
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
          <a href={result.url} target="_blank" rel="noreferrer">
            View issue ↗
          </a>
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
          {/* The spam check. Mounted always so the widget has somewhere to go;
              when it can't load we say so and offer the route that doesn't
              depend on it, rather than leaving a dead Send button. */}
          <div className="report-turnstile" ref={widgetRef} />
          {check === "unavailable" && (
            <p className="report-note">
              The spam check couldn't load, so this form can't send. You can{" "}
              <a href={REPO_ISSUES_URL} target="_blank" rel="noreferrer">
                open an issue on GitHub
              </a>{" "}
              instead.
            </p>
          )}
          {result?.error && <p className="report-error">{result.error}</p>}
          <div className="report-actions">
            <button className="report-cancel" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              className="report-submit"
              onClick={submit}
              disabled={busy || !description.trim() || !token}
              title={!token && check !== "unavailable" ? "Waiting for the spam check" : undefined}
            >
              {busy ? "Sending…" : "Send report"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
