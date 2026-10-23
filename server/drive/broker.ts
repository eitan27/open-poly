// The Google Drive token broker behind /api/drive/*.
//
// It exists so the user signs in to Google ONCE per browser: the browser-only
// Google Identity flow hands out one-hour access tokens and no refresh token, so
// background autosave would need a fresh popup (and a user gesture) every hour.
// Here the OAuth code is exchanged server-side, the refresh token is kept
// encrypted in KV, and the browser holds only an httpOnly session cookie it
// trades for short-lived access tokens. Document bytes never pass through this
// code — the browser talks to Drive directly with those tokens.
//
// Routes (all under /api/drive/):
//   GET  config          → { enabled, mode, apiBase, connected, email }
//   GET  auth/start      → redirect to Google consent (popup or full-page)
//   GET  auth/callback   → code exchange, session cookie, tell the app
//   POST token           → { accessToken, expiresIn, email } for the session
//   POST disconnect      → forget this browser's session; {revoke:true} also
//                          revokes the grant at Google (every device)
// DRIVE_MODE=mock adds a fake Google (mock/consent, mock/approve, mock/revoke)
// so the whole flow runs locally with no Google project — see functions/README.
import {
  decryptString,
  encryptString,
  importAesKey,
  b64urlDecode,
  b64urlEncode,
  randomToken,
  sha256Hex,
} from "./crypto";
import type { KVLike } from "./kv";
import { DRIVE_FILE_SCOPE, googleProvider, mockCode, mockProvider, type OAuthProvider } from "./oauth";

export interface DriveEnv {
  /** "google" or "mock"; anything else (or unset) disables Drive sync. */
  DRIVE_MODE?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** base64 32-byte AES key that seals refresh tokens at rest. */
  DRIVE_TOKEN_KEY?: string;
  DRIVE_KV?: KVLike;
  /** "1" = derive the public origin from X-Forwarded-Host/Proto. ONLY for local
   *  dev behind the Vite proxy; in production request.url is already right. */
  DRIVE_TRUST_FORWARDED?: string;
  /** Mock mode: access-token lifetime in seconds (tests shorten it). */
  MOCK_TOKEN_TTL?: string;
}

export interface BrokerDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

const SESSION_COOKIE = "op_drive_sid";
const STATE_COOKIE = "op_drive_state";
const SESSION_TTL = 400 * 24 * 3600; // browsers cap cookie lifetime at 400 days
const STATE_TTL = 600;
// A fixed key for mock mode only, so `npm run dev:api` works with no secrets.
// Mock refresh tokens are fake; sealing them is just exercising the code path.
const MOCK_DEV_KEY = b64urlEncode(new Uint8Array(32).fill(7));

export const GOOGLE_API_BASE = "https://www.googleapis.com";
export const MOCK_API_BASE = "/api/mock-drive";

interface StoredUser {
  rt: string; // sealed refresh token
  email: string;
  updatedAt: number;
}
interface StoredSession {
  sub: string;
  email: string;
  createdAt: number;
}
interface AuthState {
  state: string;
  mode: "popup" | "redirect";
  returnTo: string;
  consentForced: boolean;
}

/** Outcome codes the app understands (shown as messages in the sync UI). */
export type AuthResult = "connected" | "denied" | "scope" | "failed";

const json = (status: number, data: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

export function driveMode(env: DriveEnv): "google" | "mock" | null {
  if (env.DRIVE_MODE === "mock" && env.DRIVE_KV) return "mock";
  if (
    env.DRIVE_MODE === "google" &&
    env.DRIVE_KV &&
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.DRIVE_TOKEN_KEY
  )
    return "google";
  return null;
}

export async function handleDriveRequest(request: Request, env: DriveEnv, deps: BrokerDeps = {}): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/drive\/?/, "");
  const mode = driveMode(env);

  if (path === "config" && request.method === "GET") {
    if (!mode) return json(200, { enabled: false });
    const session = await readSession(request, env.DRIVE_KV!);
    const user = session ? await env.DRIVE_KV!.get(`user:${session.sub}`) : null;
    return json(200, {
      enabled: true,
      mode,
      apiBase: mode === "mock" ? MOCK_API_BASE : GOOGLE_API_BASE,
      connected: !!(session && user),
      email: session && user ? session.email : null,
    });
  }
  if (!mode) return json(404, { error: "drive sync is not configured" });

  const kv = env.DRIVE_KV!;
  const now = deps.now ?? Date.now;
  const provider: OAuthProvider =
    mode === "mock"
      ? mockProvider(kv, { tokenTtl: Number(env.MOCK_TOKEN_TTL) || 3600, now })
      : googleProvider(env.GOOGLE_CLIENT_ID!, env.GOOGLE_CLIENT_SECRET!, deps.fetch);
  const key = await importAesKey(mode === "mock" ? (env.DRIVE_TOKEN_KEY ?? MOCK_DEV_KEY) : env.DRIVE_TOKEN_KEY!);
  const origin = publicOrigin(request, env);
  const secure = origin.startsWith("https:");
  const redirectUri = `${origin}/api/drive/auth/callback`;

  if (path === "auth/start" && request.method === "GET") {
    const state: AuthState = {
      state: randomToken(16),
      mode: url.searchParams.get("mode") === "redirect" ? "redirect" : "popup",
      returnTo: safeReturn(url.searchParams.get("return")),
      consentForced: false,
    };
    return startAuth(provider, state, redirectUri, secure, url.searchParams.get("login_hint") ?? undefined);
  }

  if (path === "auth/callback" && request.method === "GET") {
    const state = readStateCookie(request);
    if (!state || state.state !== url.searchParams.get("state")) {
      return finishAuth({ mode: "popup", returnTo: "/" }, "failed", secure, []);
    }
    const err = url.searchParams.get("error");
    if (err) return finishAuth(state, err === "access_denied" ? "denied" : "failed", secure, []);
    const code = url.searchParams.get("code");
    if (!code) return finishAuth(state, "failed", secure, []);

    let grant;
    try {
      grant = await provider.exchangeCode(code, redirectUri);
    } catch (e) {
      console.warn("drive: code exchange failed", e);
      return finishAuth(state, "failed", secure, []);
    }
    // Google's consent screen lets the user untick individual scopes.
    if (!grant.scope.split(" ").includes(DRIVE_FILE_SCOPE)) return finishAuth(state, "scope", secure, []);

    const userKey = `user:${grant.sub}`;
    let refreshToken = grant.refreshToken;
    if (!refreshToken) {
      // Google returns a refresh token only on the FIRST consent for a client.
      // A second device (or a reconnect) reuses the stored one; if we have none
      // (our record was deleted but Google remembers the grant), ask again with
      // prompt=consent — once, never in a loop.
      const prev = await kv.get(userKey);
      if (prev) {
        try {
          refreshToken = await decryptString(key, (JSON.parse(prev) as StoredUser).rt);
        } catch {
          refreshToken = undefined;
        }
      }
      if (!refreshToken) {
        if (state.consentForced) return finishAuth(state, "failed", secure, []);
        return startAuth(
          provider,
          { ...state, state: randomToken(16), consentForced: true },
          redirectUri,
          secure,
          grant.email,
          true,
        );
      }
    }
    const user: StoredUser = { rt: await encryptString(key, refreshToken), email: grant.email, updatedAt: now() };
    await kv.put(userKey, JSON.stringify(user));

    const sid = randomToken(32);
    const session: StoredSession = { sub: grant.sub, email: grant.email, createdAt: now() };
    await kv.put(`sess:${await sha256Hex(sid)}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
    return finishAuth(state, "connected", secure, [
      cookie(SESSION_COOKIE, sid, { path: "/api/drive", maxAge: SESSION_TTL, secure }),
    ]);
  }

  if (path === "token" && request.method === "POST") {
    const csrf = checkCsrf(request, origin);
    if (csrf) return csrf;
    const session = await readSession(request, kv);
    if (!session) return json(401, { error: "not_connected" });
    const userRaw = await kv.get(`user:${session.sub}`);
    if (!userRaw) return json(401, { error: "reauth" });
    let refreshToken: string;
    try {
      refreshToken = await decryptString(key, (JSON.parse(userRaw) as StoredUser).rt);
    } catch {
      await kv.delete(`user:${session.sub}`);
      return json(401, { error: "reauth" });
    }
    let grant;
    try {
      grant = await provider.refresh(refreshToken);
    } catch (e) {
      console.warn("drive: refresh failed", e);
      return json(502, { error: "upstream" });
    }
    if (grant === "invalid_grant") {
      // Revoked from the user's Google account, or expired. The record is
      // useless now; dropping it makes the next connect re-ask for consent.
      await kv.delete(`user:${session.sub}`);
      return json(401, { error: "reauth" });
    }
    return json(200, { accessToken: grant.accessToken, expiresIn: grant.expiresIn, email: session.email });
  }

  if (path === "disconnect" && request.method === "POST") {
    const csrf = checkCsrf(request, origin);
    if (csrf) return csrf;
    const body = (await request.json().catch(() => ({}))) as { revoke?: boolean };
    const sid = readCookie(request, SESSION_COOKIE);
    const session = await readSession(request, kv);
    if (sid) await kv.delete(`sess:${await sha256Hex(sid)}`);
    if (session && body.revoke) {
      const userRaw = await kv.get(`user:${session.sub}`);
      if (userRaw) {
        try {
          await provider.revoke(await decryptString(key, (JSON.parse(userRaw) as StoredUser).rt));
        } catch (e) {
          console.warn("drive: revoke failed", e);
        }
      }
      await kv.delete(`user:${session.sub}`);
    }
    return json(
      200,
      { ok: true },
      { "set-cookie": cookie(SESSION_COOKIE, "", { path: "/api/drive", maxAge: 0, secure }) },
    );
  }

  // --- Mock Google (DRIVE_MODE=mock only) -----------------------------------
  if (mode === "mock" && path === "mock/consent" && request.method === "GET") {
    return mockConsentPage(url.searchParams);
  }
  if (mode === "mock" && path === "mock/approve" && request.method === "GET") {
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    if (new URL(redirect, origin).pathname !== "/api/drive/auth/callback") return json(400, { error: "bad redirect" });
    const q = new URLSearchParams({ state: url.searchParams.get("state") ?? "" });
    if (url.searchParams.get("decision") === "deny") q.set("error", "access_denied");
    else q.set("code", mockCode(url.searchParams.get("email") || "tester@example.com", url.searchParams.has("drive")));
    return redirectTo(`${redirect}?${q}`);
  }
  if (mode === "mock" && path === "mock/revoke" && request.method === "POST") {
    // Test hook: "the user removed Open Poly from their Google account".
    const email = url.searchParams.get("email") ?? "";
    await kv.put(`mock:revoked:${email}`, "1");
    return json(200, { ok: true });
  }

  return json(404, { error: "not found" });
}

// --- helpers ----------------------------------------------------------------

function startAuth(
  provider: OAuthProvider,
  state: AuthState,
  redirectUri: string,
  secure: boolean,
  loginHint?: string,
  forceConsent = false,
): Response {
  const location = provider.authUrl({ redirectUri, state: state.state, loginHint, forceConsent });
  const headers = new Headers({ location, "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    cookie(STATE_COOKIE, b64urlEncode(new TextEncoder().encode(JSON.stringify(state))), {
      path: "/api/drive/auth",
      maxAge: STATE_TTL,
      secure,
    }),
  );
  return new Response(null, { status: 302, headers });
}

/** End of the OAuth round trip. A popup announces the result to the app on a
 *  BroadcastChannel (window.opener is unreliable: Google's pages set COOP, which
 *  severs it) and closes; a full-page flow redirects back with ?driveAuth=. */
function finishAuth(
  state: Pick<AuthState, "mode" | "returnTo">,
  result: AuthResult,
  secure: boolean,
  cookies: string[],
): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  headers.append("set-cookie", cookie(STATE_COOKIE, "", { path: "/api/drive/auth", maxAge: 0, secure }));
  if (state.mode === "redirect") {
    const sep = state.returnTo.includes("?") ? "&" : "?";
    headers.set("location", `${state.returnTo}${sep}driveAuth=${result}`);
    return new Response(null, { status: 302, headers });
  }
  headers.set("content-type", "text/html; charset=utf-8");
  const message =
    result === "connected"
      ? "Google Drive is connected. You can close this window."
      : result === "denied"
        ? "Google Drive access was not granted. You can close this window."
        : result === "scope"
          ? "Open Poly needs access to the files it creates in your Drive. Close this window and try again, leaving the Drive box ticked."
          : "Connecting Google Drive failed. Close this window and try again.";
  const payload = JSON.stringify({ type: "openpoly-drive-auth", result });
  const html = `<!doctype html><meta charset="utf-8"><title>Open Poly</title>
<body style="font:15px system-ui;padding:32px;color:#222">
<p>${message}</p>
<script>
try { const c = new BroadcastChannel("openpoly-drive-auth"); c.postMessage(${payload}); c.close(); } catch {}
try { window.opener && window.opener.postMessage(${payload}, location.origin); } catch {}
setTimeout(() => window.close(), ${result === "connected" ? 150 : 2500});
</script></body>`;
  return new Response(html, { status: 200, headers });
}

function mockConsentPage(params: URLSearchParams): Response {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const hidden = (name: string) => `<input type="hidden" name="${name}" value="${esc(params.get(name) ?? "")}">`;
  const html = `<!doctype html><meta charset="utf-8"><title>Mock Google sign-in</title>
<body style="font:15px system-ui;padding:32px;max-width:420px">
<h2>Mock Google</h2>
<p>Local development stand-in for Google's consent screen.${params.get("prompt") === "consent" ? " <em>(prompt=consent)</em>" : ""}</p>
<form action="/api/drive/mock/approve" method="get">
${hidden("state")}${hidden("redirect_uri")}
<p><label>Account <input name="email" id="mock-email" value="${esc(params.get("login_hint") ?? "tester@example.com")}"></label></p>
<p><label><input type="checkbox" name="drive" id="mock-drive" checked> See, edit, create and delete only the specific Google Drive files you use with this app</label></p>
<p><button name="decision" value="allow" id="mock-allow">Allow</button>
<button name="decision" value="deny" id="mock-deny">Cancel</button></p>
</form></body>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function publicOrigin(request: Request, env: DriveEnv): string {
  const fwdHost = request.headers.get("x-forwarded-host");
  if (env.DRIVE_TRUST_FORWARDED === "1" && fwdHost) {
    const proto = request.headers.get("x-forwarded-proto") ?? "http";
    return `${proto.split(",")[0].trim()}://${fwdHost.split(",")[0].trim()}`;
  }
  return new URL(request.url).origin;
}

/** Only same-site paths — never an absolute or protocol-relative URL, which
 *  would make the callback an open redirect. */
function safeReturn(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

/** Token and disconnect are cookie-authenticated POSTs. The session cookie is
 *  SameSite=Lax (no cross-site POSTs), and the custom header forces a CORS
 *  preflight this endpoint never answers — two independent locks. */
function checkCsrf(request: Request, origin: string): Response | null {
  if (request.headers.get("x-openpoly") !== "1") return json(403, { error: "missing x-openpoly header" });
  const o = request.headers.get("origin");
  if (o && o !== origin) return json(403, { error: "cross-origin" });
  return null;
}

function cookie(name: string, value: string, o: { path: string; maxAge: number; secure: boolean }): string {
  return `${name}=${value}; Path=${o.path}; Max-Age=${o.maxAge}; HttpOnly; SameSite=Lax${o.secure ? "; Secure" : ""}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function readStateCookie(request: Request): AuthState | null {
  const raw = readCookie(request, STATE_COOKIE);
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(raw))) as AuthState;
  } catch {
    return null;
  }
}

async function readSession(request: Request, kv: KVLike): Promise<StoredSession | null> {
  const sid = readCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  const raw = await kv.get(`sess:${await sha256Hex(sid)}`);
  return raw ? (JSON.parse(raw) as StoredSession) : null;
}
