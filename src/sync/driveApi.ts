// A thin client for the few Google Drive v3 calls sync needs. The base URL is
// the only thing that differs between Google (https://www.googleapis.com) and
// the local mock (/api/mock-drive — server/drive/mockDrive.ts), which mirrors
// Google's paths below it.
//
// Files are found by `appProperties` (app-private key/values), never by folder
// or name: the user can move or rename them in Drive and they're still ours.
// With the drive.file scope the app only ever sees files it created anyway.

export const DOC_SUFFIX = ".openpoly.json";
const KIND = "openpolyKind";
const DOC_ID = "openpolyDocId";
const FOLDER_NAME = "Open Poly";
const FIELDS = "id,name,version,modifiedTime,appProperties,size";
// Google's simple multipart upload tops out at 5 MB; STEP imports can push a
// document past that, so larger bodies go through a resumable session.
const MULTIPART_MAX = 4 * 1024 * 1024;

/** A document file in Drive, as listed. `name` is the display name (suffix
 *  stripped); `docId` is the Open Poly id it was uploaded under. */
export interface RemoteDoc {
  fileId: string;
  name: string;
  version: string;
  modifiedTime: string;
  docId?: string;
}

export class DriveError extends Error {
  /** HTTP status, or 0 for "never reached Drive" (offline, DNS, CORS). */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DriveApiOptions {
  apiBase: string;
  /** An access token; `force` = the last one was rejected, mint a new one. */
  getToken: (force?: boolean) => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export type DriveApi = ReturnType<typeof createDriveApi>;

interface RawFile {
  id: string;
  name: string;
  version: string;
  modifiedTime: string;
  appProperties?: Record<string, string>;
}

export function displayName(fileName: string): string {
  if (fileName.endsWith(DOC_SUFFIX)) return fileName.slice(0, -DOC_SUFFIX.length);
  if (fileName.endsWith(".json")) return fileName.slice(0, -5);
  return fileName;
}

function toRemote(f: RawFile): RemoteDoc {
  return {
    fileId: f.id,
    name: displayName(f.name),
    version: String(f.version),
    modifiedTime: f.modifiedTime,
    docId: f.appProperties?.[DOC_ID],
  };
}

export function createDriveApi(opts: DriveApiOptions) {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 5;
  const base = opts.apiBase.replace(/\/$/, "");
  let folderId: string | null = null;

  /** One Drive call: bearer auth, one re-mint on 401, exponential backoff on
   *  rate limits and server errors (Google's documented retry policy). */
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let forceToken = false;
    for (let attempt = 0; ; attempt++) {
      const token = await opts.getToken(forceToken);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      let res: Response;
      try {
        res = await doFetch(url, { ...init, headers });
      } catch (e) {
        throw new DriveError(0, `Couldn't reach Google Drive (${(e as Error).message})`);
      }
      if (res.ok) return res;
      if (res.status === 401 && !forceToken) {
        forceToken = true;
        continue;
      }
      const body = await res.text().catch(() => "");
      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body));
      if (retryable && attempt < maxRetries) {
        await sleep(Math.min(32_000, 500 * 2 ** attempt) + Math.random() * 250);
        continue;
      }
      let message = `Google Drive error ${res.status}`;
      try {
        message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new DriveError(res.status, message);
    }
  }

  async function list(q: string): Promise<RawFile[]> {
    const out: RawFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: "1000" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await request(`${base}/drive/v3/files?${params}`);
      const page = (await res.json()) as { files: RawFile[]; nextPageToken?: string };
      out.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** The visible "Open Poly" folder new documents are created in — found by
   *  its appProperty (so a rename in Drive doesn't orphan it), else created. */
  async function ensureFolder(): Promise<string> {
    if (folderId) return folderId;
    const found = await list(`appProperties has { key='${KIND}' and value='folder' } and trashed = false`);
    if (found.length) return (folderId = found[0].id);
    const res = await request(`${base}/drive/v3/files?fields=${FIELDS}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: FOLDER_NAME,
        mimeType: "application/vnd.google-apps.folder",
        appProperties: { [KIND]: "folder" },
      }),
    });
    return (folderId = ((await res.json()) as RawFile).id);
  }

  /** Create (no fileId) or replace (fileId) a document's content + metadata. */
  async function upload(fileId: string | null, meta: Record<string, unknown>, content: string): Promise<RemoteDoc> {
    const path = fileId ? `/upload/drive/v3/files/${fileId}` : "/upload/drive/v3/files";
    const method = fileId ? "PATCH" : "POST";
    if (new TextEncoder().encode(content).length <= MULTIPART_MAX) {
      const boundary = `openpoly-${Math.random().toString(36).slice(2)}`;
      const body =
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\ncontent-type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
      const res = await request(`${base}${path}?uploadType=multipart&fields=${FIELDS}`, {
        method,
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      });
      return toRemote((await res.json()) as RawFile);
    }
    const start = await request(`${base}${path}?uploadType=resumable&fields=${FIELDS}`, {
      method,
      headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": "application/json" },
      body: JSON.stringify(meta),
    });
    const session = start.headers.get("location");
    if (!session) throw new DriveError(500, "Drive didn't return an upload session");
    // The mock answers with an origin-relative URL; resolve it against an
    // absolute base (tests) and leave it relative in the page.
    const sessionUrl = session.startsWith("/") && /^https?:/.test(base) ? new URL(session, base).toString() : session;
    const res = await request(sessionUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: content,
    });
    return toRemote((await res.json()) as RawFile);
  }

  return {
    ensureFolder,

    /** Every Open Poly document file in the user's Drive (not trashed). */
    async listDocs(): Promise<RemoteDoc[]> {
      return (await list(`appProperties has { key='${KIND}' and value='doc' } and trashed = false`)).map(toRemote);
    },

    /** One file's current metadata, or null if it's gone or trashed. */
    async getDoc(fileId: string): Promise<RemoteDoc | null> {
      try {
        const res = await request(`${base}/drive/v3/files/${fileId}?fields=${FIELDS},trashed`);
        const f = (await res.json()) as RawFile & { trashed?: boolean };
        return f.trashed ? null : toRemote(f);
      } catch (e) {
        if (e instanceof DriveError && e.status === 404) return null;
        throw e;
      }
    },

    async download(fileId: string): Promise<string> {
      const res = await request(`${base}/drive/v3/files/${fileId}?alt=media`);
      return res.text();
    },

    async createDoc(p: { name: string; docId: string; content: string }): Promise<RemoteDoc> {
      const parent = await ensureFolder();
      return upload(
        null,
        {
          name: `${p.name}${DOC_SUFFIX}`,
          mimeType: "application/json",
          parents: [parent],
          appProperties: { [KIND]: "doc", [DOC_ID]: p.docId },
        },
        p.content,
      );
    },

    async updateDoc(fileId: string, p: { name: string; docId: string; content: string }): Promise<RemoteDoc> {
      return upload(
        fileId,
        { name: `${p.name}${DOC_SUFFIX}`, appProperties: { [KIND]: "doc", [DOC_ID]: p.docId } },
        p.content,
      );
    },

    /** Move to Drive's trash (recoverable there for 30 days), never delete. */
    async trash(fileId: string): Promise<void> {
      await request(`${base}/drive/v3/files/${fileId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trashed: true }),
      });
    },
  };
}
