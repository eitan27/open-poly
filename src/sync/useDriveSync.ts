// Google Drive sync, as the app sees it: availability, the connect/disconnect
// flow, and a SyncEngine that runs while connected — on connect, a few seconds
// after each edit, every minute while the tab is visible, and on coming back
// online or to the tab. The engine owns every decision; this hook only decides
// WHEN to run it and hands it the working-document hooks.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoredDoc } from "../storage/db";
import { useLatest } from "../hooks/useLatest";
import {
  connectDrive,
  createTokenSource,
  disconnectDrive,
  fetchDriveConfig,
  type AuthResult,
  type DriveConfig,
} from "./brokerClient";
import { createDriveApi } from "./driveApi";
import { connectNotice, RECENT_ON_CONNECT } from "./connectNotice";
import { SyncEngine, type OnboardingChoice, type Resolution, type SyncSnapshot } from "./engine";

const EDIT_DELAY = 4000;
const POLL_INTERVAL = 60_000;
const AUTO_UPLOAD_KEY = "openpoly.drive.autoUpload";
// Set when Google access ends under a connected browser, cleared by a working
// reconnect, a disconnect, or dismissing the message: sync has stopped, and
// the reminder has to survive a reload, which is when nothing else says so.
const LAPSED_KEY = "openpoly.drive.lapsed";
const LAPSED_TEXT =
  "Open Poly's access to your Google Drive ended (it was removed, or expired). Connect again to keep syncing — your documents are safe on this device.";
const onboardedKey = (account: string) => `openpoly.drive.onboarded:${account}`;
// Set while a connect is in flight and until its first pass lands. In
// sessionStorage, not a ref, so it survives the full-page sign-in redirect
// (the fallback when a popup is blocked).
const JUST_CONNECTED_KEY = "openpoly.drive.justConnected";

function sessionFlag(value?: boolean): boolean {
  try {
    if (value === true) sessionStorage.setItem(JUST_CONNECTED_KEY, "1");
    else if (value === false) sessionStorage.removeItem(JUST_CONNECTED_KEY);
    return sessionStorage.getItem(JUST_CONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* best-effort */
  }
}

export interface UseDriveSyncParams {
  /** Change signals: a new value schedules a sync EDIT_DELAY later. */
  doc: unknown;
  docName: string;
  getActiveId: () => string | null;
  flushSave: () => Promise<void>;
  canReplaceActive: () => boolean;
  adoptExternalRecord: (record: StoredDoc) => void;
  openDocument: (id: string) => Promise<void>;
  renameDocument: (id: string, name: string) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
}

/** "error" = the outcome of something the user just did (the dialog opens for
 *  it); "warn" = something that happened in the background (only the button
 *  shows it — modelling is never interrupted). */
/** "success"/"info" just report; "warn"/"error" need the user (and offer
 *  Dismiss). `action: "showDocuments"` adds a button to the Documents list. */
export type DriveNotice = {
  kind: "success" | "info" | "error" | "warn";
  /** A short headline above `text` (the connect message has one). */
  title?: string;
  text?: string;
  action?: "showDocuments";
} | null;

export interface DriveSync {
  config: DriveConfig | null;
  snapshot: SyncSnapshot | null;
  /** The connect popup is open. */
  connecting: boolean;
  notice: DriveNotice;
  dismissNotice: () => void;
  autoUpload: boolean;
  setAutoUpload: (on: boolean) => void;
  connect: () => Promise<void>;
  cancelConnect: () => void;
  disconnect: (revoke: boolean) => Promise<void>;
  syncNow: () => void;
  engine: SyncEngine | null;
  resolve: (docId: string, r: Resolution) => Promise<void>;
  completeOnboarding: (choices: Record<string, OnboardingChoice>) => Promise<void>;
}

const AUTH_MESSAGES: Record<Exclude<AuthResult, "connected" | "cancelled">, string> = {
  denied: "Google Drive wasn't connected — access was declined.",
  scope:
    "Open Poly needs permission to the files it creates in your Drive. Connect again and leave the Drive box ticked.",
  failed: "Connecting Google Drive failed. Please try again.",
};

export function useDriveSync(p: UseDriveSyncParams): DriveSync {
  const host = useLatest(p);
  const [config, setConfig] = useState<DriveConfig | null>(null);
  const [snapshot, setSnapshot] = useState<SyncSnapshot | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState<DriveNotice>(() =>
    readFlag(LAPSED_KEY, false) ? { kind: "warn", text: LAPSED_TEXT } : null,
  );
  const [autoUpload, setAutoUploadState] = useState(() => readFlag(AUTO_UPLOAD_KEY, true));
  const autoUploadRef = useLatest(autoUpload);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped by every successful connect, so it always gets a fresh engine. The
  // account alone isn't enough: when Google's grant dies, the config read that
  // should report "not connected" can still see the old record (KV is
  // eventually consistent), the account never changes, and the old engine —
  // stuck in "reauth" — would outlive the reconnect that fixed it.
  const [connectEpoch, setConnectEpoch] = useState(0);

  const refreshConfig = useCallback(async () => setConfig(await fetchDriveConfig()), []);

  // Availability, plus the outcome of a full-page (popup-blocked) connect,
  // which comes back as ?driveAuth=… — read once, then stripped from the URL.
  useEffect(() => {
    const url = new URL(location.href);
    const result = url.searchParams.get("driveAuth") as AuthResult | null;
    if (result) {
      url.searchParams.delete("driveAuth");
      history.replaceState(history.state, "", url.toString());
      if (result === "connected") {
        writeFlag(LAPSED_KEY, false);
        setNotice(null);
      } else if (result in AUTH_MESSAGES) {
        setNotice({ kind: "error", text: AUTH_MESSAGES[result as keyof typeof AUTH_MESSAGES] });
      }
    }
    void refreshConfig();
  }, [refreshConfig]);

  const account = config?.enabled && config.connected && config.apiBase ? (config.email ?? null) : null;
  const apiBase = config?.apiBase;

  const engine = useMemo(() => {
    if (!account || !apiBase) return null;
    const tokens = createTokenSource();
    const api = createDriveApi({ apiBase, getToken: tokens.getToken });
    return new SyncEngine(
      api,
      account,
      {
        getActiveId: () => host.current.getActiveId(),
        flushActive: () => host.current.flushSave(),
        canReplaceActive: () => host.current.canReplaceActive(),
        activeReplaced: (r) => host.current.adoptExternalRecord(r),
        activeRenamed: (name) => {
          const id = host.current.getActiveId();
          if (id) void host.current.renameDocument(id, name);
        },
        deleteDocument: (id) => host.current.deleteDocument(id),
      },
      {
        autoUpload: () => autoUploadRef.current,
        isOnboarded: () => readFlag(onboardedKey(account), false),
        setOnboarded: () => writeFlag(onboardedKey(account), true),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connectEpoch only forces a rebuild
  }, [account, apiBase, host, autoUploadRef, connectEpoch]);

  // Scheduling. `syncSoon` collapses bursts: one pending timer at most.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncSoon = useCallback(
    (delay: number) => {
      if (!engine) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        engine.sync().catch(() => {}); // the snapshot carries the error
      }, delay);
    },
    [engine],
  );

  useEffect(() => {
    if (!engine) {
      setSnapshot(null);
      return;
    }
    setSnapshot(engine.snapshot);
    const unsub = engine.subscribe(setSnapshot);
    syncSoon(0);
    const onVisible = () => {
      if (document.visibilityState === "visible") syncSoon(500);
    };
    const onOnline = () => syncSoon(500);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") syncSoon(0);
    }, POLL_INTERVAL);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      unsub();
      clearInterval(interval);
      if (timerRef.current) clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [engine, syncSoon]);

  // Edits (and renames) schedule a pass; the engine flushes before reading.
  // Only a real edit does: when `syncSoon` itself changes (a new engine, at
  // connect) this would otherwise push the engine effect's immediate first
  // pass back by EDIT_DELAY.
  const lastEditRef = useRef({ doc: p.doc, name: p.docName });
  useEffect(() => {
    const last = lastEditRef.current;
    if (last.doc === p.doc && last.name === p.docName) return;
    lastEditRef.current = { doc: p.doc, name: p.docName };
    syncSoon(EDIT_DELAY);
  }, [p.doc, p.docName, syncSoon]);

  // The first pass after connecting: bring down the Drive documents edited most
  // recently (RECENT_ON_CONNECT). A device with only an untouched starter opens
  // the newest in its place (the starter, empty, is removed); a device with
  // work of its own keeps it open. Then say what happened (connectNotice.ts).
  useEffect(() => {
    if (!engine || !snapshot || snapshot.lastSyncedAt === null || !sessionFlag()) return;
    // A first-connect choice is pending: wait for it (the pass that follows
    // the user's answer comes back through here).
    if (snapshot.onboarding) return;
    sessionFlag(false);
    const starterId = host.current.getActiveId();
    const starterWasBlank = !!starterId && snapshot.docStates[starterId] === "blank";
    // Documents of this device's own that the first pass put in Drive.
    const hadLocalWork = Object.values(snapshot.docStates).some((st) => st === "synced" || st === "pending");
    void (async () => {
      try {
        const r = await engine.downloadRecent(RECENT_ON_CONNECT);
        const newest = r.downloaded[0];
        let opened: string | null = null;
        if (r.onlyStarters && newest) {
          await host.current.openDocument(newest.id);
          if (starterWasBlank && starterId !== newest.id) await host.current.deleteDocument(starterId);
          opened = newest.name;
        }
        setNotice(connectNotice({ inDrive: r.inDrive, downloaded: r.downloaded.length, opened, hadLocalWork }));
      } catch {
        /* the snapshot carries the error */
      }
    })();
  }, [engine, snapshot, host]);

  const connect = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setConnecting(true);
    // Keep the "access ended" reminder up until a connect actually works: a
    // cancelled popup leaves this browser exactly as disconnected as before.
    setNotice((n) => (n?.kind === "warn" ? n : null));
    try {
      await host.current.flushSave(); // a popup-blocked fallback navigates away
      sessionFlag(true);
      const result = await connectDrive({ loginHint: config?.email ?? undefined, signal: ctrl.signal });
      if (result === "connected") {
        writeFlag(LAPSED_KEY, false);
        setNotice(null);
        await refreshConfig();
        setConnectEpoch((n) => n + 1);
      } else {
        sessionFlag(false);
        if (result !== "cancelled") setNotice({ kind: "error", text: AUTH_MESSAGES[result] });
      }
    } catch (e) {
      sessionFlag(false);
      throw e;
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setConnecting(false);
    }
  }, [config?.email, host, refreshConfig]);

  const cancelConnect = useCallback(() => abortRef.current?.abort(), []);

  const disconnect = useCallback(
    async (revoke: boolean) => {
      await disconnectDrive(revoke);
      writeFlag(LAPSED_KEY, false); // stopping was the user's choice
      await refreshConfig();
      setNotice({
        kind: "info",
        text: revoke
          ? "Disconnected, and Open Poly's access to your Drive was removed. Your documents stay on this device and in Drive."
          : "Google Drive disconnected on this browser. Your documents stay on this device and in Drive.",
      });
    },
    [refreshConfig],
  );

  // A dead grant shows up as status "reauth": the session cookie is useless,
  // so re-read config (it reports not-connected) to put the Connect UI back.
  useEffect(() => {
    if (snapshot?.status !== "reauth") return;
    writeFlag(LAPSED_KEY, true);
    setNotice({ kind: "warn", text: LAPSED_TEXT });
    void refreshConfig();
  }, [snapshot?.status, refreshConfig]);

  const setAutoUpload = useCallback((on: boolean) => {
    writeFlag(AUTO_UPLOAD_KEY, on);
    setAutoUploadState(on);
  }, []);

  const resolve = useCallback(async (docId: string, r: Resolution) => engine?.resolve(docId, r), [engine]);
  const completeOnboarding = useCallback(
    async (choices: Record<string, OnboardingChoice>) => engine?.completeOnboarding(choices),
    [engine],
  );

  return {
    config,
    snapshot,
    connecting,
    notice,
    dismissNotice: () => {
      if (notice?.kind === "warn") writeFlag(LAPSED_KEY, false); // acknowledged
      setNotice(null);
    },
    autoUpload,
    setAutoUpload,
    connect,
    cancelConnect,
    disconnect,
    syncNow: () => syncSoon(0),
    engine,
    resolve,
    completeOnboarding,
  };
}
