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
import { SyncEngine, type OnboardingChoice, type Resolution, type SyncSnapshot } from "./engine";

const EDIT_DELAY = 4000;
const POLL_INTERVAL = 60_000;
const AUTO_UPLOAD_KEY = "openpoly.drive.autoUpload";
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
export type DriveNotice = { kind: "info" | "error" | "warn"; text: string } | null;

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
  const [notice, setNotice] = useState<DriveNotice>(null);
  const [autoUpload, setAutoUploadState] = useState(() => readFlag(AUTO_UPLOAD_KEY, true));
  const autoUploadRef = useLatest(autoUpload);
  const abortRef = useRef<AbortController | null>(null);

  const refreshConfig = useCallback(async () => setConfig(await fetchDriveConfig()), []);

  // Availability, plus the outcome of a full-page (popup-blocked) connect,
  // which comes back as ?driveAuth=… — read once, then stripped from the URL.
  useEffect(() => {
    const url = new URL(location.href);
    const result = url.searchParams.get("driveAuth") as AuthResult | null;
    if (result) {
      url.searchParams.delete("driveAuth");
      history.replaceState(history.state, "", url.toString());
      if (result !== "connected" && result in AUTH_MESSAGES) {
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
  }, [account, apiBase, host, autoUploadRef]);

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

  // The first pass after connecting. A device with only an untouched starter
  // document opens the Drive document edited most recently in its place (the
  // starter, empty, is removed); either way, say where Drive's documents are.
  useEffect(() => {
    if (!engine || !snapshot || snapshot.lastSyncedAt === null || !sessionFlag()) return;
    sessionFlag(false);
    const starterId = host.current.getActiveId();
    const starterWasBlank = !!starterId && snapshot.docStates[starterId] === "blank";
    void (async () => {
      try {
        const latest = await engine.downloadLatestIfOnlyStarters();
        if (latest) {
          await host.current.openDocument(latest.id);
          if (starterWasBlank && starterId !== latest.id) await host.current.deleteDocument(starterId);
          const rest =
            latest.others > 0 ? ` ${latest.others === 1 ? "One more is" : `${latest.others} more are`} in Open…` : "";
          setNotice({
            kind: "info",
            text: `Opened “${latest.name}” from your Google Drive, the document you edited most recently.${rest}`,
          });
        } else if (snapshot.cloudOnly.length > 0) {
          const n = snapshot.cloudOnly.length;
          setNotice({
            kind: "info",
            text: `${n === 1 ? "One document" : `${n} documents`} from your Google Drive ${n === 1 ? "is" : "are"} in Open…, ready to open on this device.`,
          });
        }
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
    setNotice(null);
    try {
      await host.current.flushSave(); // a popup-blocked fallback navigates away
      sessionFlag(true);
      const result = await connectDrive({ loginHint: config?.email ?? undefined, signal: ctrl.signal });
      if (result === "connected") await refreshConfig();
      else {
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
    setNotice({
      kind: "warn",
      text: "Open Poly's access to your Google Drive ended (it was removed, or expired). Connect again to keep syncing — your documents are safe on this device.",
    });
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
    dismissNotice: () => setNotice(null),
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
