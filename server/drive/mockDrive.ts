// A stand-in for the slice of the Google Drive v3 REST API that the app's sync
// uses, served at /api/mock-drive in DRIVE_MODE=mock and used directly as a
// `fetch` in unit tests. Paths mirror Google's exactly below the base
// (`/drive/v3/files…`, `/upload/drive/v3/files…`), so the client is identical
// for both — only its base URL changes.
//
// Deliberately narrow: the `q` grammar is only the clauses the client sends,
// every response carries every field regardless of `fields=`, and a user's files
// are keyed by the email inside the mock access token (see oauth.ts). Anything
// outside that slice is a 400, so a client change that starts relying on more of
// Drive fails loudly here rather than passing locally and breaking on Google.
import { parseMockAccessToken } from "./oauth";
import { listAll, type KVLike } from "./kv";
import { randomToken } from "./crypto";

export interface MockFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  trashed: boolean;
  version: string;
  createdTime: string;
  modifiedTime: string;
  size?: string;
  content?: string;
  /** The contentHints thumbnail, served back at `thumbnailLink`. */
  thumbnail?: { image: string; mimeType: string };
}

interface Meta {
  name?: string;
  mimeType?: string;
  parents?: string[];
  appProperties?: Record<string, string | null>;
  trashed?: boolean;
  contentHints?: { thumbnail?: { image: string; mimeType: string } };
}

const error = (code: number, message: string, reason = "error") =>
  new Response(JSON.stringify({ error: { code, message, errors: [{ reason, message }] } }), {
    status: code,
    headers: { "content-type": "application/json" },
  });
const ok = (data: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...headers } });

export async function handleMockDrive(
  request: Request,
  kv: KVLike,
  opts: { base?: string; now?: () => number } = {},
): Promise<Response> {
  const base = opts.base ?? "/api/mock-drive";
  const now = opts.now ?? Date.now;
  const url = new URL(request.url);
  const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;

  // Test hook (no auth): make the next `count` requests for `email` fail with
  // `status` — how the backoff and offline paths get exercised end to end.
  if (path === "/__fail" && request.method === "POST") {
    const email = url.searchParams.get("email") ?? "";
    await kv.put(
      `mockdrive-fail:${email}`,
      JSON.stringify({
        status: Number(url.searchParams.get("status") ?? 503),
        count: Number(url.searchParams.get("count") ?? 1),
      }),
    );
    return ok({ ok: true });
  }

  // A file's thumbnailLink. Like Google's, it's a plain URL an <img> can load
  // without a bearer token (Google's are short-lived and unguessable; this is
  // a local mock).
  const thumbMatch = path.match(/^\/thumbnail\/([^/]+)\/([^/]+)$/);
  if (thumbMatch && request.method === "GET") {
    const raw = await kv.get(`mockdrive:${decodeURIComponent(thumbMatch[1])}:${thumbMatch[2]}`);
    const thumb = raw ? (JSON.parse(raw) as MockFile).thumbnail : undefined;
    if (!thumb) return error(404, "No thumbnail", "notFound");
    const b64 = thumb.image.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Response(bytes, { status: 200, headers: { "content-type": thumb.mimeType } });
  }

  const auth = request.headers.get("authorization") ?? "";
  const user = auth.startsWith("Bearer ") ? parseMockAccessToken(auth.slice(7), now()) : null;
  if (!user) return error(401, "Invalid Credentials", "authError");
  // Like Google, revoking the grant kills outstanding access tokens too.
  if (await kv.get(`mock:revoked:${user}`)) return error(401, "Invalid Credentials", "authError");

  const failRaw = await kv.get(`mockdrive-fail:${user}`);
  if (failRaw) {
    const fail = JSON.parse(failRaw) as { status: number; count: number };
    if (fail.count <= 1) await kv.delete(`mockdrive-fail:${user}`);
    else await kv.put(`mockdrive-fail:${user}`, JSON.stringify({ ...fail, count: fail.count - 1 }));
    return error(fail.status, "Injected failure", fail.status === 429 ? "rateLimitExceeded" : "backendError");
  }

  const prefix = `mockdrive:${user}:`;
  const load = async (id: string) => {
    const raw = await kv.get(prefix + id);
    return raw ? (JSON.parse(raw) as MockFile) : null;
  };
  const save = (f: MockFile) => kv.put(prefix + f.id, JSON.stringify(f));
  const publicView = (f: MockFile) => {
    const { content: _content, thumbnail, ...rest } = f;
    return thumbnail ? { ...rest, thumbnailLink: `${base}/thumbnail/${encodeURIComponent(user)}/${f.id}` } : rest;
  };
  const stamp = () => new Date(now()).toISOString();

  const create = async (meta: Meta, content?: string): Promise<MockFile> => {
    const f: MockFile = {
      id: randomToken(12),
      name: meta.name ?? "Untitled",
      mimeType: meta.mimeType ?? "application/octet-stream",
      parents: meta.parents ?? [],
      appProperties: cleanProps(meta.appProperties ?? {}),
      trashed: false,
      version: "1",
      createdTime: stamp(),
      modifiedTime: stamp(),
    };
    if (meta.contentHints?.thumbnail) f.thumbnail = meta.contentHints.thumbnail;
    if (content !== undefined) {
      f.content = content;
      f.size = String(new TextEncoder().encode(content).length);
    }
    await save(f);
    return f;
  };
  const update = async (f: MockFile, meta: Meta, content?: string): Promise<MockFile> => {
    if (meta.name !== undefined) f.name = meta.name;
    if (meta.mimeType !== undefined) f.mimeType = meta.mimeType;
    if (meta.trashed !== undefined) f.trashed = meta.trashed;
    if (meta.appProperties) f.appProperties = cleanProps({ ...f.appProperties, ...meta.appProperties });
    if (meta.contentHints?.thumbnail) f.thumbnail = meta.contentHints.thumbnail;
    if (content !== undefined) {
      f.content = content;
      f.size = String(new TextEncoder().encode(content).length);
    }
    f.version = String(Number(f.version) + 1);
    f.modifiedTime = stamp();
    await save(f);
    return f;
  };

  const filesMatch = path.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
  const uploadMatch = path.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/);

  if (filesMatch) {
    const id = filesMatch[1];
    if (!id && request.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      let pred: (f: MockFile) => boolean;
      try {
        pred = parseQuery(q);
      } catch (e) {
        return error(400, `Invalid Value: q (${(e as Error).message})`, "invalid");
      }
      const keys = await listAll(kv, prefix);
      const files: MockFile[] = [];
      for (const k of keys) {
        const raw = await kv.get(k);
        if (raw) files.push(JSON.parse(raw) as MockFile);
      }
      const pageSize = Math.min(Number(url.searchParams.get("pageSize") ?? 100), 1000);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const matched = files
        .filter(pred)
        .sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id));
      const page = matched.slice(start, start + pageSize);
      const next = start + pageSize < matched.length ? String(start + pageSize) : undefined;
      return ok({ files: page.map(publicView), ...(next ? { nextPageToken: next } : {}) });
    }
    if (!id && request.method === "POST") {
      const f = await create((await request.json()) as Meta);
      return ok(publicView(f));
    }
    if (!id) return error(405, "Method not allowed");
    const f = await load(id);
    if (!f) return error(404, `File not found: ${id}.`, "notFound");
    if (request.method === "GET") {
      if (url.searchParams.get("alt") === "media") {
        return new Response(f.content ?? "", { status: 200, headers: { "content-type": f.mimeType } });
      }
      return ok(publicView(f));
    }
    if (request.method === "PATCH") return ok(publicView(await update(f, (await request.json()) as Meta)));
    if (request.method === "DELETE") {
      await kv.delete(prefix + id);
      return new Response(null, { status: 204 });
    }
    return error(405, "Method not allowed");
  }

  if (uploadMatch) {
    const id = uploadMatch[1];
    const uploadType = url.searchParams.get("uploadType");
    const existing = id ? await load(id) : null;
    if (id && !existing) return error(404, `File not found: ${id}.`, "notFound");

    if (uploadType === "multipart" && (request.method === "POST" || request.method === "PATCH")) {
      const parsed = parseMultipart(request.headers.get("content-type") ?? "", await request.text());
      if (!parsed) return error(400, "Malformed multipart body", "badContent");
      const f = existing
        ? await update(existing, parsed.meta, parsed.content)
        : await create(parsed.meta, parsed.content);
      return ok(publicView(f));
    }
    if (uploadType === "resumable") {
      const uploadId = url.searchParams.get("upload_id");
      if (!uploadId && (request.method === "POST" || request.method === "PATCH")) {
        // Session start: remember the metadata, hand back the upload URL.
        const meta = (await request.json().catch(() => ({}))) as Meta;
        const newId = randomToken(12);
        await kv.put(`mockdrive-upload:${user}:${newId}`, JSON.stringify({ meta, fileId: id ?? null }));
        // Origin-relative, unlike Google's absolute URL: behind the dev proxy
        // request.url carries wrangler's port, which the page can't fetch.
        const params = new URLSearchParams(url.searchParams);
        params.set("upload_id", newId);
        return new Response(null, { status: 200, headers: { location: `${base}${path}?${params}` } });
      }
      if (uploadId && request.method === "PUT") {
        const raw = await kv.get(`mockdrive-upload:${user}:${uploadId}`);
        if (!raw) return error(404, "Upload session not found", "notFound");
        await kv.delete(`mockdrive-upload:${user}:${uploadId}`);
        const session = JSON.parse(raw) as { meta: Meta; fileId: string | null };
        const content = await request.text();
        const target = session.fileId ? await load(session.fileId) : null;
        if (session.fileId && !target) return error(404, "File not found", "notFound");
        const f = target ? await update(target, session.meta, content) : await create(session.meta, content);
        return ok(publicView(f));
      }
    }
    return error(400, `Unsupported upload: ${request.method} uploadType=${uploadType}`, "badRequest");
  }

  return error(404, `Mock Drive has no route for ${request.method} ${path}`, "notFound");
}

function cleanProps(p: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) if (v !== null) out[k] = v;
  return out;
}

/** The `q` clauses the client sends, joined by ` and `:
 *    trashed = false | true
 *    mimeType = '…'
 *    '<id>' in parents
 *    appProperties has { key='K' and value='V' }  */
function parseQuery(q: string): (f: MockFile) => boolean {
  const preds: ((f: MockFile) => boolean)[] = [];
  let rest = q.trim();
  while (rest) {
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^appProperties has \{\s*key\s*=\s*'([^']*)'\s+and\s+value\s*=\s*'([^']*)'\s*\}/))) {
      const [, k, v] = m;
      preds.push((f) => f.appProperties[k] === v);
    } else if ((m = rest.match(/^trashed\s*=\s*(true|false)/))) {
      const want = m[1] === "true";
      preds.push((f) => f.trashed === want);
    } else if ((m = rest.match(/^mimeType\s*=\s*'([^']*)'/))) {
      const want = m[1];
      preds.push((f) => f.mimeType === want);
    } else if ((m = rest.match(/^'([^']*)'\s+in\s+parents/))) {
      const want = m[1];
      preds.push((f) => f.parents.includes(want));
    } else {
      throw new Error(`unsupported clause near "${rest.slice(0, 30)}"`);
    }
    rest = rest.slice(m[0].length).trim();
    if (rest.startsWith("and ")) rest = rest.slice(4).trim();
    else if (rest) throw new Error(`expected "and" near "${rest.slice(0, 30)}"`);
  }
  return (f) => preds.every((p) => p(f));
}

/** A two-part multipart/related body: JSON metadata, then the content. */
function parseMultipart(contentType: string, body: string): { meta: Meta; content: string } | null {
  const boundary = contentType.match(/boundary="?([^";]+)"?/)?.[1];
  if (!boundary) return null;
  const parts = body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => {
      const sep = p.indexOf("\r\n\r\n");
      return sep < 0 ? null : p.slice(sep + 4).replace(/\r\n$/, "");
    });
  if (parts.length !== 2 || parts[0] === null || parts[1] === null) return null;
  try {
    return { meta: JSON.parse(parts[0]) as Meta, content: parts[1] };
  } catch {
    return null;
  }
}
