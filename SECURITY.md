# Security policy

## Reporting a vulnerability

Report it privately: on [`eitan27/open-poly`](https://github.com/eitan27/open-poly),
use **Security → Report a vulnerability**, which opens a thread visible only to
the maintainers. Please don't use a public issue, and don't use the in-app
"Report a bug" button — both file a public GitHub issue.

Include what you'd put in a bug report: what you did, what happened, and the
browser/commit you saw it on. A minimal reproduction (a `.openpoly.json`
document, a request, a patch) is worth more than a description.

There are no releases and no version branches — `main` and the build deployed
at <https://open-poly.pages.dev> are the only supported versions, and a fix
lands on `main` and is re-deployed.

## Scope

**In scope — the server-side endpoint.** [`functions/api/report.ts`](functions/api/report.ts)
is the one piece of Open Poly that runs on a server: a Cloudflare Pages
function that files GitHub issues with a server-side `GITHUB_ISSUES_TOKEN`,
optionally gated by Turnstile and optionally writing blobs to an R2 bucket. If
you can leak or abuse that token, bypass the Turnstile check, write to R2
outside `reports/`, or turn a report payload into something the endpoint
didn't intend, that's a real vulnerability — say so.

**In scope — importing files you didn't write.** Documents, DXF and STEP files
get shared around, so a crafted file that achieves code execution in the page,
rather than just failing to import, is worth reporting.

**Out of scope — everything else, which is a static app.** The rest of Open
Poly is client-side only: no backend, no accounts, no sessions, no server-side
storage. Documents live in the visitor's own browser IndexedDB and are never
uploaded. So there is nothing to authenticate to, no other user's data to
reach, and no privilege to escalate — findings that assume a server behind the
app (missing auth, IDOR, SQL injection, session fixation) don't apply here.
Neither do missing security headers on a static host, self-XSS you can only
perform in your own browser, or scanner output without a working repro.

**The MCP agent bridge** is local-only by construction: the hub binds
`127.0.0.1` and the in-app client auto-disables on deployed builds, so the
public site never dials it. It has no auth token yet — a documented v1 limit
(see [`mcp-server/README.md`](mcp-server/README.md)), not a finding. What _is_
a finding: a way for a remote web page to reach the local hub anyway, such as
DNS rebinding or a cross-origin WebSocket that the tab accepts.
