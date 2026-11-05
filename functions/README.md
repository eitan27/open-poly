# Cloudflare Pages Functions

Server-side endpoints deployed alongside the static site. Wrangler bundles
this directory with esbuild at deploy time; `npm run typecheck` checks it
(and `server/`, which holds the logic these files adapt) with the app.

## `api/report.ts` — in-app bug report → GitHub issue

Backs the app's "Report a bug" flow: the client POSTs a description (plus
optionally the current document and a screenshot) to `/api/report`, and
this function files it as a GitHub issue on `eitan27/open-poly` using a
server-side token that's never exposed to the browser.

### Required

| Env var               | Purpose                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_ISSUES_TOKEN` | GitHub token with `issues:write` on this repo. Without it the endpoint returns `500` and the feature is effectively disabled. |

Set it with:

```bash
npx wrangler pages secret put GITHUB_ISSUES_TOKEN --project-name open-poly
```

### Optional

| Env var            | Purpose                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TURNSTILE_SECRET` | Enables Cloudflare Turnstile verification on submitted reports (spam protection). Omit to skip verification entirely.                                                              |
| `REPORTS`          | An R2 bucket binding. When set together with `PUBLIC_R2_BASE`, attached documents/screenshots are uploaded to R2 and linked from the issue instead of inlined into the issue body. |
| `PUBLIC_R2_BASE`   | Public base URL for the `REPORTS` bucket (e.g. a custom domain or `r2.dev` URL), used to build the links above.                                                                    |

Without `REPORTS`/`PUBLIC_R2_BASE`, documents are inlined directly into the
issue body (up to ~55 KB) and screenshots are dropped.

### Local development

Wrangler reads secrets/bindings from `.dev.vars` and `wrangler.toml` for
local runs (`.dev.vars` is gitignored — never commit real tokens there).
Without `GITHUB_ISSUES_TOKEN` set, the endpoint responds `500` and the rest
of the app works normally; the "Report a bug" dialog is the only thing
that needs it.

## `api/drive/[[path]].ts` — Google Drive sync token broker

Backs "sync your documents with Google Drive". The logic is in
`server/drive/broker.ts`; the app side is `src/sync/`. The browser talks to
Drive directly — this endpoint only holds each user's Google **refresh token**
(encrypted, in KV) and trades an httpOnly session cookie for one-hour access
tokens, so a user consents once per browser instead of once an hour. Document
contents never pass through it.

Scope is `drive.file` only: Open Poly sees just the files it created, and the
scope is non-sensitive, so no Google security assessment and no user cap.

| Route                | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `GET  config`        | `{ enabled, mode, apiBase, connected, email }` — the app hides Drive when disabled |
| `GET  auth/start`    | redirect to Google's consent screen (popup, or full page if blocked)               |
| `GET  auth/callback` | code exchange → session cookie → tells the app over a BroadcastChannel             |
| `POST token`         | access token for the session (`x-openpoly: 1` header required)                     |
| `POST disconnect`    | forget this browser; `{ "revoke": true }` also revokes at Google                   |

### Configuration

| Env var                 | Purpose                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `DRIVE_MODE`            | `google` (production), `mock` (local fake Google — see below). Unset = Drive sync disabled.     |
| `DRIVE_KV`              | KV namespace binding: sealed refresh tokens (`user:<sub>`) and hashed sessions (`sess:<hash>`). |
| `GOOGLE_CLIENT_ID`      | OAuth client (type "Web application").                                                          |
| `GOOGLE_CLIENT_SECRET`  | Its secret. **Secret.**                                                                         |
| `DRIVE_TOKEN_KEY`       | 32 random bytes, base64 — seals refresh tokens at rest. **Secret.** `openssl rand -base64 32`   |
| `DRIVE_TRUST_FORWARDED` | `1` only behind the local Vite proxy. Never in production.                                      |

Google mode is enabled only when all of `DRIVE_KV`, the client id/secret and the
key are present.

Google Cloud console, once:

1. Enable the **Google Drive API** for the project.
2. OAuth consent screen: app name, support email, homepage + privacy policy
   URLs, authorized domain `openpoly.dev`; scopes `openid`, `email`,
   `.../auth/drive.file`. **Publish to Production** — in Testing, refresh
   tokens expire after 7 days and only listed test users can sign in.
3. Credentials → OAuth client ID → Web application. Authorized redirect URIs:
   `https://openpoly.dev/api/drive/auth/callback`, plus
   `http://localhost:5173/api/drive/auth/callback` for local testing.

Cloudflare, once:

```bash
npx wrangler kv namespace create DRIVE_KV      # then bind it to the Pages project as DRIVE_KV
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name open-poly
npx wrangler pages secret put DRIVE_TOKEN_KEY --project-name open-poly
# and plain vars DRIVE_MODE=google, GOOGLE_CLIENT_ID=… in the dashboard
```

### Local development — no Google account needed

```bash
npm run dev:api   # this directory on :8788, DRIVE_MODE=mock, local KV
npm run dev       # the app on :5173, proxying /api to :8788
```

Mock mode adds a fake Google: `auth/start` leads to a local consent page
(pick any email, untick Drive to test a refused scope, or Cancel), and
`/api/mock-drive/*` is a fake Drive API with Google's paths (it answers only in
mock mode). Test hooks, mock mode only:

- `POST /api/drive/mock/revoke?email=…` — "the user removed Open Poly from
  their Google account" (the next token request answers `reauth`).
- `POST /api/mock-drive/__fail?email=…&status=429&count=3` — fail the next
  N Drive calls, to exercise backoff.

State persists in `.wrangler/state`; use a new email for a clean Drive.
`node scripts/verify-drive-sync.mjs` runs the whole flow across two simulated
devices. Unit tests: `server/drive/*.test.ts`, `src/sync/*.test.ts`.

### Local development against real Google

Put the secrets in `.dev.vars` (gitignored):

```
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
DRIVE_TOKEN_KEY=…
```

then `npm run dev:api:google` with `npm run dev` on port 5173 (the registered
localhost redirect URI).
