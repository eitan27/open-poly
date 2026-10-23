// Google Drive sync UI: the topbar status button, and the dialog behind it —
// connect, the first-connect choice of what to upload (shown only when a name
// clashes with Drive), open issues (conflicts, same-name documents, documents
// deleted in Drive) with their resolutions, and disconnect. All decisions are the engine's (src/sync/engine.ts); this only
// shows them and passes the user's choices back.
import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { timeAgo } from "../storage/docNames";
import type { DriveSync } from "../sync/useDriveSync";
import type { OnboardingChoice, OnboardingDoc, Resolution, SyncIssue, SyncSnapshot } from "../sync/engine";
import "./DriveDialog.css";

function CloudIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.4 9.2 4.5 4.5 0 0 0 7 18Z" strokeLinejoin="round" />
    </svg>
  );
}

/** One-line summary of where sync stands, shared by the button and dialog. */
function driveStatusText(sync: DriveSync): string {
  const s = sync.snapshot;
  if (!sync.config?.connected || !s) return "Not connected to Google Drive";
  const issues = s.issues.length + (s.onboarding ? 1 : 0);
  if (s.onboarding) return "Choose which documents to put in Google Drive";
  if (s.status === "syncing") return "Syncing with Google Drive…";
  if (s.status === "offline") return "Offline — changes are saved on this device and will sync when you're back online";
  if (s.status === "reauth") return "Google Drive needs to be reconnected";
  if (s.status === "error") return `Sync problem: ${s.error ?? "unknown error"}`;
  if (issues) return `${issues} document${issues === 1 ? " needs" : "s need"} your attention`;
  return s.lastSyncedAt ? `Synced with Google Drive ${timeAgo(s.lastSyncedAt)}` : "Connected to Google Drive";
}

export function DriveStatusButton({ sync, onClick }: { sync: DriveSync; onClick: () => void }) {
  if (!sync.config?.enabled) return null;
  const s = sync.snapshot;
  const connected = !!sync.config.connected && !!s;
  const attention = connected ? s!.issues.length + (s!.onboarding ? 1 : 0) : 0;
  let state = sync.notice?.kind === "warn" ? "problem" : "off";
  if (connected) {
    if (attention) state = "attention";
    else if (s!.status === "syncing") state = "busy";
    else if (s!.status === "offline" || s!.status === "error" || s!.status === "reauth") state = "problem";
    else state = "ok";
  }
  return (
    <button
      className={`tool-btn drive-btn drive-btn--${state}`}
      onClick={onClick}
      title={connected ? driveStatusText(sync) : (sync.notice?.text ?? "Sync your documents with Google Drive")}
      aria-label={connected ? driveStatusText(sync) : "Google Drive sync"}
    >
      <CloudIcon />
      {state === "off" && <span className="drive-btn-label">Drive</span>}
      {state === "busy" && <span className="status-spinner" aria-hidden />}
      {state === "ok" && (
        <span className="drive-btn-mark" aria-hidden>
          ✓
        </span>
      )}
      {state === "attention" && <span className="drive-btn-count">{attention}</span>}
      {state === "problem" && (
        <span className="drive-btn-mark drive-btn-mark--problem" aria-hidden>
          !
        </span>
      )}
    </button>
  );
}

export function DriveDialog({ sync, onClose }: { sync: DriveSync; onClose: () => void }) {
  const connected = !!sync.config?.connected && !!sync.snapshot;
  return (
    <Modal onClose={onClose} ariaLabel="Google Drive" className="docs-dialog drive-dialog" escapeCapture>
      <div className="docs-header">
        <h2>Google Drive</h2>
        <button className="row-icon docs-close" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      {sync.notice && (
        <p className={sync.notice.kind === "info" ? "drive-info" : "docs-error"}>
          {sync.notice.text}{" "}
          <button className="banner-link" onClick={sync.dismissNotice}>
            Dismiss
          </button>
        </p>
      )}
      {!connected ? (
        <ConnectView sync={sync} />
      ) : sync.snapshot!.onboarding ? (
        <OnboardingView docs={sync.snapshot!.onboarding} sync={sync} />
      ) : (
        <ConnectedView sync={sync} snapshot={sync.snapshot!} />
      )}
    </Modal>
  );
}

function ConnectView({ sync }: { sync: DriveSync }) {
  return (
    <div className="drive-connect">
      <p>
        Keep your documents in your own Google Drive, in an <strong>Open Poly</strong> folder, and pick them up in any
        browser you sign in from.
      </p>
      <ul className="drive-points">
        <li>Open Poly can only see the files it creates — nothing else in your Drive.</li>
        <li>Your documents stay on this device too. Editing never waits for the network.</li>
        <li>You sign in once per browser.</li>
      </ul>
      {sync.connecting ? (
        <div className="drive-actions">
          <span className="drive-waiting">
            <span className="status-spinner" aria-hidden /> Waiting for Google… finish signing in in the popup.
          </span>
          <button className="text-btn" onClick={sync.cancelConnect}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="drive-actions">
          <button className="text-btn drive-primary" onClick={() => void sync.connect()}>
            Connect Google Drive
          </button>
        </div>
      )}
    </div>
  );
}

// --- first connect ---------------------------------------------------------

type DraftChoice = OnboardingChoice["kind"];

function OnboardingView({ docs, sync }: { docs: OnboardingDoc[]; sync: DriveSync }) {
  const [choices, setChoices] = useState<Record<string, DraftChoice>>(() =>
    Object.fromEntries(docs.map((d) => [d.id, d.collision ? "rename" : "upload"])),
  );
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(docs.filter((d) => d.collision).map((d) => [d.id, suggestRename(d.name)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setBusy(true);
    setError(null);
    const out: Record<string, OnboardingChoice> = {};
    for (const d of docs) {
      const c = choices[d.id];
      out[d.id] =
        c === "rename" ? { kind: "rename", name: (names[d.id] ?? "").trim() || suggestRename(d.name) } : { kind: c };
    }
    try {
      await sync.completeOnboarding(out);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const collisions = docs.filter((d) => d.collision).length;
  return (
    <div className="drive-onboarding">
      <p>
        Connected as <strong>{sync.config?.email}</strong>. {docs.length} document{docs.length === 1 ? " is" : "s are"}{" "}
        on this device but not in your Drive yet. Choose what to upload.
        {collisions > 0 &&
          ` ${collisions} share${collisions === 1 ? "s" : ""} a name with a different document already in your Drive.`}
      </p>
      {error && <p className="docs-error">{error}</p>}
      <ul className="docs-list">
        {docs.map((d) => (
          <li key={d.id} className="docs-row drive-ob-row">
            <div className="docs-row-main">
              <span className="drive-doc-name">{d.name}</span>
              <span className="docs-sub">
                edited {timeAgo(d.updatedAt)}
                {d.collision && (
                  <span className="drive-collision">
                    {" "}
                    · your Drive has a different “{d.name}” (edited{" "}
                    {timeAgo(Date.parse(d.collision.remoteModifiedTime))})
                  </span>
                )}
              </span>
              {d.collision && choices[d.id] === "rename" && (
                <input
                  className="docs-name-input drive-rename-input"
                  aria-label={`New name for ${d.name}`}
                  value={names[d.id] ?? ""}
                  onChange={(e) => setNames({ ...names, [d.id]: e.target.value })}
                />
              )}
            </div>
            <select
              className="drive-select"
              aria-label={`What to do with ${d.name}`}
              value={choices[d.id]}
              onChange={(e) => setChoices({ ...choices, [d.id]: e.target.value as DraftChoice })}
            >
              {d.collision ? (
                <>
                  <option value="rename">Rename this one and upload</option>
                  <option value="keepLocal">Replace Drive's with this one</option>
                  <option value="keepCloud">Replace this one with Drive's</option>
                  <option value="localOnly">Keep on this device only</option>
                </>
              ) : (
                <>
                  <option value="upload">Upload to Drive</option>
                  <option value="localOnly">Keep on this device only</option>
                </>
              )}
            </select>
          </li>
        ))}
      </ul>
      <p className="drive-hint">
        Replacing a Drive document keeps its previous version in Drive's version history. Replacing one on this device
        can't be undone.
      </p>
      <div className="drive-actions">
        <button className="text-btn drive-primary" disabled={busy} onClick={() => void apply()}>
          {busy ? "Working…" : "Continue"}
        </button>
      </div>
    </div>
  );
}

/** A starting point for the rename field; the user edits it. */
function suggestRename(name: string): string {
  return `${name} (this device)`;
}

// --- steady state ----------------------------------------------------------

function ConnectedView({ sync, snapshot }: { sync: DriveSync; snapshot: SyncSnapshot }) {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  return (
    <div className="drive-connected">
      <div className="drive-account">
        <div className="docs-row-main">
          <span>
            Connected as <strong>{sync.config?.email}</strong>
          </span>
          <span className={`docs-sub drive-status drive-status--${snapshot.status}`}>{driveStatusText(sync)}</span>
        </div>
        <button className="text-btn" disabled={snapshot.status === "syncing"} onClick={sync.syncNow}>
          Sync now
        </button>
      </div>

      {snapshot.issues.length > 0 && (
        <ul className="docs-list drive-issues">
          {snapshot.issues.map((issue) => (
            <IssueCard key={issue.docId} issue={issue} sync={sync} />
          ))}
        </ul>
      )}

      <label className="drive-toggle">
        <input type="checkbox" checked={sync.autoUpload} onChange={(e) => sync.setAutoUpload(e.target.checked)} />
        Put new documents in Drive automatically
      </label>

      <div className="drive-actions drive-footer">
        <button
          className="text-btn"
          title="Stop syncing in this browser. Your documents stay here and in Drive."
          onClick={() => void sync.disconnect(false)}
        >
          Disconnect this browser
        </button>
        {confirmRevoke ? (
          <button className="text-btn docs-delete-confirm" onClick={() => void sync.disconnect(true)}>
            Really remove access everywhere?
          </button>
        ) : (
          <button
            className="text-btn"
            title="Withdraw Open Poly's access to your Google Drive, signing out every browser. Your files stay in Drive."
            onClick={() => setConfirmRevoke(true)}
          >
            Remove access on all devices
          </button>
        )}
      </div>
    </div>
  );
}

function IssueCard({ issue, sync }: { issue: SyncIssue; sync: DriveSync }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => setError(null), [issue]);

  const act = async (r: Resolution) => {
    setBusy(true);
    setError(null);
    try {
      await sync.resolve(issue.docId, r);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const btn = (label: string, r: Resolution, title?: string) => (
    <button className="text-btn" disabled={busy} title={title} onClick={() => void act(r)}>
      {label}
    </button>
  );

  return (
    <li className={`docs-row drive-issue drive-issue--${issue.kind}`}>
      <div className="docs-row-main">
        {issue.kind === "conflict" && (
          <>
            <span>
              <strong>“{issue.name}”</strong> changed both here and in Drive since it last synced.
            </span>
            <span className="docs-sub">
              This device: edited {timeAgo(issue.localUpdatedAt)} · Drive: edited{" "}
              {timeAgo(Date.parse(issue.remoteModifiedTime))}
              {issue.remoteName !== issue.name && ` as “${issue.remoteName}”`}
            </span>
            <div className="drive-issue-actions">
              {btn(
                "Keep this device's",
                { kind: "keepLocal" },
                "Overwrite Drive's version (it stays in Drive's version history)",
              )}
              {btn(
                "Keep Drive's",
                { kind: "keepCloud" },
                "Replace this device's version with Drive's — can't be undone",
              )}
              {btn(
                "Keep both",
                { kind: "keepBoth" },
                "Save this device's version as a separate “(conflict copy)” document",
              )}
            </div>
          </>
        )}
        {issue.kind === "nameCollision" && (
          <>
            <span>
              Your Drive already has a different document named <strong>“{issue.name}”</strong>, so this one wasn't
              uploaded.
            </span>
            <span className="docs-sub">Drive's was edited {timeAgo(Date.parse(issue.remoteModifiedTime))}.</span>
            {renaming !== null ? (
              <div className="drive-issue-actions">
                <input
                  className="docs-name-input"
                  autoFocus
                  aria-label="New name"
                  value={renaming}
                  onChange={(e) => setRenaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && renaming.trim()) void act({ kind: "rename", name: renaming.trim() });
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setRenaming(null);
                    }
                  }}
                />
                <button
                  className="text-btn drive-primary"
                  disabled={busy || !renaming.trim()}
                  onClick={() => void act({ kind: "rename", name: renaming.trim() })}
                >
                  Rename and upload
                </button>
                <button className="text-btn" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="drive-issue-actions">
                <button
                  className="text-btn drive-primary"
                  disabled={busy}
                  onClick={() => setRenaming(suggestRename(issue.name))}
                >
                  Rename this one…
                </button>
                {btn(
                  "Replace Drive's",
                  { kind: "keepLocal" },
                  "Overwrite Drive's document with this one (it stays in Drive's version history)",
                )}
                {btn("Use Drive's", { kind: "keepCloud" }, "Replace this document with Drive's — can't be undone")}
                {btn("Don't sync this one", { kind: "localOnly" })}
              </div>
            )}
          </>
        )}
        {issue.kind === "remoteGone" && (
          <>
            <span>
              <strong>“{issue.name}”</strong> was deleted from Google Drive (or moved to its trash).
            </span>
            <div className="drive-issue-actions">
              {btn("Upload it again", { kind: "keepLocal" })}
              {btn("Keep on this device only", { kind: "localOnly" })}
              {btn("Delete it here too", { kind: "deleteLocal" })}
            </div>
          </>
        )}
        {error && <span className="docs-error">{error}</span>}
      </div>
    </li>
  );
}
