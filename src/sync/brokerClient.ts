// The browser side of the Drive token broker (server/drive/broker.ts): learn
// whether sync is available here, connect (one consent per browser), and trade
// the httpOnly session cookie for short-lived access tokens.
import { ReauthError } from "./engine";

export interface DriveConfig {
  enabled: boolean;
  mode?: "google" | "mock";
  apiBase?: string;
  connected?: boolean;
  email?: string | null;
}

export type AuthResult = "connected" | "denied" | "scope" | "failed" | "cancelled";

const AUTH_CHANNEL = "openpoly-drive-auth";

/** Sync's availability. Anything but a JSON answer — a static host without the
 *  Functions, the SPA fallback's HTML, a dev server with no API behind its
 *  proxy — means "not here", and the UI hides itself. */
export async function fetchDriveConfig(): Promise<DriveConfig> {
  try {
    const res = await fetch("/api/drive/config", { credentials: "same-origin" });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return { enabled: false };
    return (await res.json()) as DriveConfig;
  } catch {
    return { enabled: false };
  }
}

/** Access tokens, cached until five minutes before expiry. */
export function createTokenSource() {
  let cached: { token: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;
  return {
    async getToken(force = false): Promise<string> {
      if (!force && cached && Date.now() < cached.until) return cached.token;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const res = await fetch("/api/drive/token", {
            method: "POST",
            credentials: "same-origin",
            headers: { "x-openpoly": "1" },
          });
          if (res.status === 401) {
            cached = null;
            throw new ReauthError();
          }
          if (!res.ok) throw new Error(`Couldn't get a Google Drive token (${res.status})`);
          const out = (await res.json()) as { accessToken: string; expiresIn: number };
          cached = { token: out.accessToken, until: Date.now() + (out.expiresIn - 300) * 1000 };
          return out.accessToken;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    clear() {
      cached = null;
    },
  };
}

/** Run the consent flow in a popup and resolve its outcome. The popup reports
 *  back on a BroadcastChannel because Google's pages set COOP, which severs
 *  `window.opener` — and makes `popup.closed` read true while the popup is
 *  still open, so a closed popup can't be detected: the UI offers Cancel
 *  (`signal`) instead. If the popup is blocked, fall back to a full-page
 *  redirect (the page comes back with ?driveAuth=…). */
export function connectDrive(opts: { loginHint?: string; signal?: AbortSignal } = {}): Promise<AuthResult> {
  const q = new URLSearchParams({ mode: "popup" });
  if (opts.loginHint) q.set("login_hint", opts.loginHint);
  const w = 500;
  const h = 640;
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - h) / 3);
  const popup = window.open(
    `/api/drive/auth/start?${q}`,
    "openpoly-drive-auth",
    `popup,width=${w},height=${h},left=${left},top=${top}`,
  );
  if (!popup) {
    const r = new URLSearchParams({ mode: "redirect", return: location.pathname + location.search });
    if (opts.loginHint) r.set("login_hint", opts.loginHint);
    location.assign(`/api/drive/auth/start?${r}`);
    return Promise.resolve("cancelled");
  }
  return new Promise((resolve) => {
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(AUTH_CHANNEL) : null;
    let finished = false;
    const done = (result: AuthResult) => {
      if (finished) return;
      finished = true;
      channel?.close();
      window.removeEventListener("message", onMessage);
      opts.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      resolve(result);
    };
    const handle = (data: unknown) => {
      const d = data as { type?: string; result?: AuthResult } | null;
      if (d?.type === "openpoly-drive-auth" && d.result) done(d.result);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === location.origin) handle(e.data);
    };
    const onAbort = () => {
      try {
        popup.close();
      } catch {
        /* severed */
      }
      done("cancelled");
    };
    if (channel) channel.onmessage = (e) => handle(e.data);
    window.addEventListener("message", onMessage);
    opts.signal?.addEventListener("abort", onAbort);
    const timeout = setTimeout(() => done("cancelled"), 600_000);
  });
}

/** Forget this browser's session; `revoke` also withdraws Open Poly's access
 *  in the Google account itself, signing out every device. */
export async function disconnectDrive(revoke: boolean): Promise<void> {
  await fetch("/api/drive/disconnect", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-openpoly": "1", "content-type": "application/json" },
    body: JSON.stringify({ revoke }),
  });
}
