// The two OAuth back ends the broker can talk to: Google itself, and a mock
// that stands in for it in local development and tests (DRIVE_MODE=mock). Both
// speak the same small interface, so the broker never branches on the mode
// except to pick one.
import { b64urlDecode, b64urlEncode, decodeJwtClaims } from "./crypto";
import type { KVLike } from "./kv";

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SCOPES = ["openid", "email", DRIVE_FILE_SCOPE].join(" ");

export interface CodeGrant {
  /** Absent when Google skips it (the user already granted this client offline
   *  access) — the broker then reuses the one it stored, or re-asks with
   *  prompt=consent. */
  refreshToken?: string;
  /** Space-separated scopes actually granted. Google's consent screen lets the
   *  user untick Drive, so this can lack DRIVE_FILE_SCOPE. */
  scope: string;
  sub: string;
  email: string;
}

export interface AccessGrant {
  accessToken: string;
  expiresIn: number;
}

export interface OAuthProvider {
  authUrl(p: { redirectUri: string; state: string; loginHint?: string; forceConsent: boolean }): string;
  exchangeCode(code: string, redirectUri: string): Promise<CodeGrant>;
  /** "invalid_grant" = the refresh token is dead (revoked, expired, or the
   *  user removed the app); anything else unexpected throws. */
  refresh(refreshToken: string): Promise<AccessGrant | "invalid_grant">;
  revoke(refreshToken: string): Promise<void>;
}

// --- Google -----------------------------------------------------------------

export function googleProvider(clientId: string, clientSecret: string, fetchFn: typeof fetch = fetch): OAuthProvider {
  return {
    authUrl({ redirectUri, state, loginHint, forceConsent }) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        include_granted_scopes: "true",
        state,
      });
      if (loginHint) q.set("login_hint", loginHint);
      if (forceConsent) q.set("prompt", "consent");
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },
    async exchangeCode(code, redirectUri) {
      const res = await fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      const out = (await res.json()) as {
        refresh_token?: string;
        scope?: string;
        id_token?: string;
        error?: string;
      };
      if (!res.ok || !out.id_token) throw new Error(`token exchange failed: ${out.error ?? res.status}`);
      const claims = decodeJwtClaims(out.id_token);
      return {
        refreshToken: out.refresh_token,
        scope: out.scope ?? "",
        sub: String(claims.sub),
        email: String(claims.email ?? ""),
      };
    },
    async refresh(refreshToken) {
      const res = await fetchFn("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
        }),
      });
      const out = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
      if (out.error === "invalid_grant") return "invalid_grant";
      if (!res.ok || !out.access_token) throw new Error(`token refresh failed: ${out.error ?? res.status}`);
      return { accessToken: out.access_token, expiresIn: out.expires_in ?? 3600 };
    },
    async revoke(refreshToken) {
      await fetchFn(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    },
  };
}

// --- Mock -------------------------------------------------------------------
// Codes, refresh tokens and access tokens are all readable strings carrying the
// email, so the mock needs no state except a revocation flag per account (which
// lets tests simulate "the user removed Open Poly from their Google account").
// Access tokens are `mock.<b64url(email)>.<expiry seconds>`; the mock Drive
// (mockDrive.ts) parses the same format to decide whose files a request sees.

export const MOCK_CODE_PREFIX = "mockcode.";
const MOCK_RT_PREFIX = "mockrt.";

export function mockProvider(kv: KVLike, opts: { tokenTtl?: number; now?: () => number } = {}): OAuthProvider {
  const ttl = opts.tokenTtl ?? 3600;
  const now = opts.now ?? Date.now;
  return {
    authUrl({ redirectUri, state, loginHint, forceConsent }) {
      const q = new URLSearchParams({ redirect_uri: redirectUri, state });
      if (loginHint) q.set("login_hint", loginHint);
      if (forceConsent) q.set("prompt", "consent");
      return `/api/drive/mock/consent?${q}`;
    },
    async exchangeCode(code) {
      if (!code.startsWith(MOCK_CODE_PREFIX)) throw new Error("token exchange failed: invalid_grant");
      // mockcode.<b64url(email)>.<"drive" | "nodrive">
      const [, emailPart, grant] = code.split(".");
      const email = new TextDecoder().decode(b64urlDecode(emailPart));
      await kv.delete(`mock:revoked:${email}`);
      const drive = grant !== "nodrive";
      return {
        refreshToken: `${MOCK_RT_PREFIX}${emailPart}`,
        scope: drive ? SCOPES : "openid email",
        sub: `mock-${email}`,
        email,
      };
    },
    async refresh(refreshToken) {
      if (!refreshToken.startsWith(MOCK_RT_PREFIX)) return "invalid_grant";
      const emailPart = refreshToken.slice(MOCK_RT_PREFIX.length);
      const email = new TextDecoder().decode(b64urlDecode(emailPart));
      if (await kv.get(`mock:revoked:${email}`)) return "invalid_grant";
      return { accessToken: mockAccessToken(email, Math.floor(now() / 1000) + ttl), expiresIn: ttl };
    },
    async revoke(refreshToken) {
      const emailPart = refreshToken.slice(MOCK_RT_PREFIX.length);
      const email = new TextDecoder().decode(b64urlDecode(emailPart));
      await kv.put(`mock:revoked:${email}`, "1");
    },
  };
}

export function mockCode(email: string, grantDrive: boolean): string {
  return `${MOCK_CODE_PREFIX}${b64urlEncode(new TextEncoder().encode(email))}.${grantDrive ? "drive" : "nodrive"}`;
}

export function mockAccessToken(email: string, expSeconds: number): string {
  return `mock.${b64urlEncode(new TextEncoder().encode(email))}.${expSeconds}`;
}

/** The email a mock access token belongs to, or null if malformed/expired. */
export function parseMockAccessToken(token: string, nowMs: number): string | null {
  const [tag, emailPart, exp] = token.split(".");
  if (tag !== "mock" || !emailPart || !exp) return null;
  if (Number(exp) * 1000 <= nowMs) return null;
  try {
    return new TextDecoder().decode(b64urlDecode(emailPart));
  } catch {
    return null;
  }
}
