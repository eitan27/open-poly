// The token broker end to end, in-process: requests in, responses out, KV in
// memory. Mock mode is driven the way a browser would drive it (follow the
// redirects, carry the cookies); Google mode runs against a fake token
// endpoint, which is where the refresh-token edge cases live.
import { describe, expect, it } from "vitest";
import { handleDriveRequest, type DriveEnv } from "./broker";
import { memoryKV } from "./kv";
import { b64urlEncode } from "./crypto";
import { handleMockDrive } from "./mockDrive";

const ORIGIN = "http://localhost:5173";
const KEY = b64urlEncode(new Uint8Array(32).fill(1));

/** A cookie jar + request helper standing in for one browser profile. */
function browser(env: DriveEnv, deps: Parameters<typeof handleDriveRequest>[2] = {}) {
  const jar = new Map<string, string>();
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await handleDriveRequest(new Request(new URL(path, ORIGIN), { ...init, headers }), env, deps);
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (attrs.some((a) => a.trim() === "Max-Age=0")) jar.delete(k);
      else jar.set(k, v);
    }
    return res;
  };
  const post = (path: string, body: unknown = {}) =>
    send(path, {
      method: "POST",
      headers: { "x-openpoly": "1", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  /** auth/start → (provider pages) → callback, following same-origin redirects. */
  const connect = async (choose: (consentUrl: URL) => string) => {
    let res = await send("/api/drive/auth/start?mode=popup");
    for (let hops = 0; hops < 6; hops++) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      const next = new URL(loc, ORIGIN);
      const target = next.origin === ORIGIN && next.pathname.endsWith("/consent") ? choose(next) : next.toString();
      res = await send(target);
    }
    throw new Error("redirect loop");
  };
  return { jar, send, post, connect };
}

const mockEnv = (): DriveEnv => ({ DRIVE_MODE: "mock", DRIVE_KV: memoryKV() });

/** Pick "Allow" on the mock consent page, as the given account. */
const allow =
  (email = "a@example.com", drive = true) =>
  (consent: URL) => {
    const q = new URLSearchParams({
      state: consent.searchParams.get("state")!,
      redirect_uri: consent.searchParams.get("redirect_uri")!,
      email,
      decision: "allow",
    });
    if (drive) q.set("drive", "on");
    return `/api/drive/mock/approve?${q}`;
  };

describe("config", () => {
  it("is disabled without a mode, and with google mode missing secrets", async () => {
    const res = await handleDriveRequest(new Request(`${ORIGIN}/api/drive/config`), {});
    expect(await res.json()).toEqual({ enabled: false });
    const half = await handleDriveRequest(new Request(`${ORIGIN}/api/drive/config`), {
      DRIVE_MODE: "google",
      DRIVE_KV: memoryKV(),
      GOOGLE_CLIENT_ID: "x",
    });
    expect(await half.json()).toEqual({ enabled: false });
  });

  it("reports the mock API base and not-connected before sign-in", async () => {
    const b = browser(mockEnv());
    expect(await (await b.send("/api/drive/config")).json()).toEqual({
      enabled: true,
      mode: "mock",
      apiBase: "/api/mock-drive",
      connected: false,
      email: null,
    });
  });
});

describe("mock mode, full round trip", () => {
  it("connects, mints a token the mock Drive accepts, and disconnects", async () => {
    const env = mockEnv();
    const b = browser(env);
    const done = await b.connect(allow("a@example.com"));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('"result":"connected"');
    expect(b.jar.has("op_drive_sid")).toBe(true);
    expect(b.jar.has("op_drive_state")).toBe(false); // consumed

    const cfg = await (await b.send("/api/drive/config")).json();
    expect(cfg).toMatchObject({ connected: true, email: "a@example.com" });

    const tok = (await (await b.post("/api/drive/token")).json()) as { accessToken: string; email: string };
    expect(tok.email).toBe("a@example.com");
    const list = await handleMockDrive(
      new Request(`${ORIGIN}/api/mock-drive/drive/v3/files?q=trashed%3Dfalse`, {
        headers: { authorization: `Bearer ${tok.accessToken}` },
      }),
      env.DRIVE_KV!,
    );
    expect(list.status).toBe(200);

    expect((await b.post("/api/drive/disconnect")).status).toBe(200);
    expect(b.jar.has("op_drive_sid")).toBe(false);
    expect((await b.post("/api/drive/token")).status).toBe(401);
  });

  it("refresh tokens are sealed at rest, and sessions are stored by hash", async () => {
    const env = mockEnv();
    const b = browser(env);
    await b.connect(allow());
    const kv = (env.DRIVE_KV as ReturnType<typeof memoryKV>).data;
    const user = JSON.parse(kv.get("user:mock-a@example.com")!);
    expect(user.rt).not.toContain("mockrt");
    const sid = b.jar.get("op_drive_sid")!;
    expect([...kv.keys()].some((k) => k.includes(sid))).toBe(false);
  });

  it("reports a denial and an unticked Drive scope without creating a session", async () => {
    const b = browser(mockEnv());
    const denied = await b.connect((c) => allow()(c).replace("decision=allow", "decision=deny"));
    expect(await denied.text()).toContain('"result":"denied"');
    const noDrive = await b.connect(allow("a@example.com", false));
    expect(await noDrive.text()).toContain('"result":"scope"');
    expect(b.jar.has("op_drive_sid")).toBe(false);
  });

  it("a full-page flow redirects back to a same-site path only", async () => {
    const b = browser(mockEnv());
    let res = await b.send("/api/drive/auth/start?mode=redirect&return=%2F%2Fevil.example%2F");
    res = await b.send(allow()(new URL(res.headers.get("location")!, ORIGIN)));
    res = await b.send(res.headers.get("location")!);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?driveAuth=connected");
  });

  it("rejects a callback whose state doesn't match the cookie", async () => {
    const b = browser(mockEnv());
    await b.send("/api/drive/auth/start");
    const res = await b.send("/api/drive/auth/callback?state=forged&code=mockcode.x.drive");
    expect(await res.text()).toContain('"result":"failed"');
  });

  it("a revoked grant turns token requests into reauth, and reconnecting recovers", async () => {
    const env = mockEnv();
    const b = browser(env);
    await b.connect(allow());
    await b.send("/api/drive/mock/revoke?email=a%40example.com", { method: "POST" });
    const res = await b.post("/api/drive/token");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "reauth" });
    await b.connect(allow());
    expect((await b.post("/api/drive/token")).status).toBe(200);
  });

  it("token and disconnect demand the CSRF header and a same origin", async () => {
    const b = browser(mockEnv());
    await b.connect(allow());
    expect((await b.send("/api/drive/token", { method: "POST" })).status).toBe(403);
    const cross = await b.send("/api/drive/token", {
      method: "POST",
      headers: { "x-openpoly": "1", origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
  });

  it("disconnect with revoke ends every browser's session for that account", async () => {
    const env = mockEnv();
    const laptop = browser(env);
    const desktop = browser(env);
    await laptop.connect(allow());
    await desktop.connect(allow());
    await laptop.post("/api/drive/disconnect", { revoke: true });
    expect((await desktop.post("/api/drive/token")).status).toBe(401);
  });
});

describe("google mode", () => {
  /** A fake https://oauth2.googleapis.com that issues a refresh token only on
   *  the first consent — or on prompt=consent, as Google does. */
  function fakeGoogle() {
    const granted = new Set<string>();
    let forceNext = false;
    const calls: string[] = [];
    const idToken = (sub: string) =>
      `x.${b64urlEncode(new TextEncoder().encode(JSON.stringify({ sub, email: `${sub}@gmail.com` })))}.y`;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = new URLSearchParams(String(init?.body ?? ""));
      calls.push(`${url.pathname}:${body.get("grant_type") ?? ""}`);
      if (url.pathname === "/revoke") return new Response("{}");
      if (body.get("grant_type") === "authorization_code") {
        const sub = body.get("code")!;
        const first = !granted.has(sub) || forceNext;
        granted.add(sub);
        forceNext = false;
        return Response.json({
          access_token: "at",
          id_token: idToken(sub),
          scope: "openid email https://www.googleapis.com/auth/drive.file",
          ...(first ? { refresh_token: `rt-${sub}` } : {}),
        });
      }
      if (body.get("refresh_token") === "rt-dead") return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `at-for-${body.get("refresh_token")}`, expires_in: 3599 });
    }) as typeof fetch;
    return { fetchFn, calls, forceConsent: () => (forceNext = true) };
  }

  const googleEnv = (): DriveEnv => ({
    DRIVE_MODE: "google",
    DRIVE_KV: memoryKV(),
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "secret",
    DRIVE_TOKEN_KEY: KEY,
  });

  /** Drive the flow with Google "approving" as `sub`. */
  async function connectAs(b: ReturnType<typeof browser>, sub: string) {
    let res = await b.send("/api/drive/auth/start");
    const seen: string[] = [];
    for (let hops = 0; hops < 4; hops++) {
      const loc = new URL(res.headers.get("location")!);
      seen.push(loc.toString());
      if (loc.host !== "accounts.google.com") break;
      res = await b.send(`/api/drive/auth/callback?state=${loc.searchParams.get("state")}&code=${sub}`);
      if (res.status === 200) break;
    }
    return { res, seen };
  }

  it("asks for offline drive.file access and exchanges the code", async () => {
    const g = fakeGoogle();
    const b = browser(googleEnv(), { fetch: g.fetchFn });
    const { res, seen } = await connectAs(b, "u1");
    const auth = new URL(seen[0]);
    expect(auth.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.file");
    expect(auth.searchParams.get("access_type")).toBe("offline");
    expect(auth.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/drive/auth/callback`);
    expect(auth.searchParams.has("prompt")).toBe(false);
    expect(await res.text()).toContain('"result":"connected"');
    const tok = await (await b.post("/api/drive/token")).json();
    expect(tok).toMatchObject({ accessToken: "at-for-rt-u1", email: "u1@gmail.com" });
  });

  it("a second device reuses the stored refresh token when Google omits one", async () => {
    const g = fakeGoogle();
    const env = googleEnv();
    await connectAs(browser(env, { fetch: g.fetchFn }), "u1");
    const second = browser(env, { fetch: g.fetchFn });
    const { res, seen } = await connectAs(second, "u1");
    expect(seen).toHaveLength(1); // no prompt=consent round trip
    expect(await res.text()).toContain('"result":"connected"');
    expect(await (await second.post("/api/drive/token")).json()).toMatchObject({ accessToken: "at-for-rt-u1" });
  });

  it("re-asks with prompt=consent once when no refresh token exists anywhere", async () => {
    const g = fakeGoogle();
    const env = googleEnv();
    const kv = env.DRIVE_KV as ReturnType<typeof memoryKV>;
    await connectAs(browser(env, { fetch: g.fetchFn }), "u2");
    kv.data.delete("user:u2"); // our record is gone, but Google remembers the grant
    const b = browser(env, { fetch: g.fetchFn });
    let res = await b.send("/api/drive/auth/start");
    const loc = new URL(res.headers.get("location")!);
    res = await b.send(`/api/drive/auth/callback?state=${loc.searchParams.get("state")}&code=u2`);
    expect(res.status).toBe(302);
    const again = new URL(res.headers.get("location")!);
    expect(again.host).toBe("accounts.google.com");
    expect(again.searchParams.get("prompt")).toBe("consent");
    expect(again.searchParams.get("login_hint")).toBe("u2@gmail.com");
    // If Google STILL sends none, the broker gives up instead of looping…
    res = await b.send(`/api/drive/auth/callback?state=${again.searchParams.get("state")}&code=u2`);
    expect(await res.text()).toContain('"result":"failed"');
    // …and when prompt=consent does produce one, the user is connected.
    const c = browser(env, { fetch: g.fetchFn });
    res = await c.send("/api/drive/auth/start");
    const l1 = new URL(res.headers.get("location")!);
    res = await c.send(`/api/drive/auth/callback?state=${l1.searchParams.get("state")}&code=u2`);
    const l2 = new URL(res.headers.get("location")!);
    g.forceConsent();
    res = await c.send(`/api/drive/auth/callback?state=${l2.searchParams.get("state")}&code=u2`);
    expect(await res.text()).toContain('"result":"connected"');
  });

  it("an invalid_grant on refresh drops the record and answers reauth", async () => {
    const g = fakeGoogle();
    const env = googleEnv();
    const b = browser(env, { fetch: g.fetchFn });
    await connectAs(b, "dead"); // refresh token "rt-dead" fails refresh
    const res = await b.post("/api/drive/token");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "reauth" });
    expect((env.DRIVE_KV as ReturnType<typeof memoryKV>).data.has("user:dead")).toBe(false);
  });

  it("disconnect with revoke calls Google's revoke endpoint", async () => {
    const g = fakeGoogle();
    const b = browser(googleEnv(), { fetch: g.fetchFn });
    await connectAs(b, "u1");
    await b.post("/api/drive/disconnect", { revoke: true });
    expect(g.calls).toContain("/revoke:");
  });

  it("trusts X-Forwarded-Host only when told to", async () => {
    const env = { ...googleEnv(), DRIVE_TRUST_FORWARDED: "1" };
    const res = await handleDriveRequest(
      new Request("http://127.0.0.1:8788/api/drive/auth/start", {
        headers: { "x-forwarded-host": "localhost:5173", "x-forwarded-proto": "http" },
      }),
      env,
    );
    const auth = new URL(res.headers.get("location")!);
    expect(auth.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/drive/auth/callback");
    const untrusted = await handleDriveRequest(
      new Request("https://openpoly.dev/api/drive/auth/start", { headers: { "x-forwarded-host": "evil.example" } }),
      googleEnv(),
    );
    expect(new URL(untrusted.headers.get("location")!).searchParams.get("redirect_uri")).toBe(
      "https://openpoly.dev/api/drive/auth/callback",
    );
    expect(untrusted.headers.getSetCookie()[0]).toContain("Secure");
  });
});
