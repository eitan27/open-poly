# Cloudflare Pages Functions

Server-side endpoints deployed alongside the static site. Not compiled by
the app's own build (`tsconfig.app.json` only includes `src`) — Wrangler
compiles this directory separately with esbuild at deploy time.

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
