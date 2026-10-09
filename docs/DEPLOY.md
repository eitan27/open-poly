# Deploying Open Poly

**Maintainer notes for the public deployment.** You do not need any of this to use
or develop Open Poly — see the README for that. This exists because the hosting has
a handful of traps that cost real time to find, and the fixes are not guessable.

The app is fully static and client-side, so any static host will serve it. The
public build runs on **Cloudflare Pages** at <https://openpoly.dev>.

## Deploying

Deploys are **direct uploads**: only the built `dist/` is sent, so Cloudflare has
no access to the repository and no git integration is configured.

```bash
npm run build
npx wrangler pages deploy dist --project-name open-poly
```

One-time, per machine:

```bash
npx wrangler login    # browser OAuth
```

Git integration is deliberately NOT used. Cloudflare builds on push and does not
wait for GitHub Actions, so connecting it would deploy whether or not the tests
passed. If this is ever automated, do it from Actions with `cloudflare/wrangler-action`
and `needs:` the CI job, which keeps the gate.

## Verifying a deploy

- **Use a cache-buster.** The production alias can serve a stale `version.json`
  from an edge cache for a moment after a deploy, `Cache-Control: no-cache`
  notwithstanding — so a plain `curl` can show the _previous_ build and look
  exactly like a deploy that landed in the wrong environment. It is not.

  ```bash
  curl "https://openpoly.dev/version.json?cb=$RANDOM"      # the truth
  npx wrangler pages deployment list --project-name open-poly   # which environment
  ```

- **Check an asset's content type, not just its status.** `public/_redirects`
  sends unknown paths to `index.html`, so a wrong or stale asset path returns
  **200 with `text/html`** rather than 404. A typo looks like success until you
  look at the type.

## Hostnames

`openpoly.dev` is canonical. `open-poly.pages.dev` 301s to it via an account-level
Bulk Redirect (the only mechanism that works: `_redirects` matches paths, not
hosts, and a zone Redirect Rule cannot see `pages.dev`, which is not in the zone).

**"Include subdomains" is deliberately OFF on that redirect**, against Cloudflare's
own documented steps. With it on, every `<hash>.open-poly.pages.dev` preview
redirects to production — so you would be testing the live build while believing
you were testing a preview. Previews must stay reachable on their own URLs.

A POST to the old host returns the 301 and browsers do not re-POST across a
redirect. Harmless here, because the app only ever posts to its own origin.

## Turnstile

The spam check in front of `/api/report` is enforced **only when
`TURNSTILE_SECRET` is set** as a Pages secret. Without it the endpoint is open and
files GitHub issues under `GITHUB_ISSUES_TOKEN`.

Re-check it without filing anything — `POST /api/report` with a description and no
token returns `403 failed spam check`, which is unreachable unless the secret is
set:

```bash
curl -s -X POST https://openpoly.dev/api/report \
  -H 'content-type: application/json' -d '{"description":"probe"}'
```

Two things that probe does **not** tell you:

- **Whether the secret is correct.** `verifyTurnstile` returns early on a missing
  token, so the request never reaches Cloudflare's siteverify endpoint and a wrong
  secret would 403 identically. Only a real report filed through the UI proves it.
- The same early return is why the Turnstile dashboard may warn that _"siteverify
  isn't being called"_. With few real reports there is nothing to call it with. It
  is a false positive — do not let the dashboard's one-click "fix" rewrite a
  working integration on the strength of it.

Production hostnames are listed in `PRODUCTION_HOSTS` (`src/ui/turnstile.ts`) **and**
on the widget in the Cloudflare dashboard; both must agree. Every other host —
localhost, a fork, and every preview deployment — gets Cloudflare's always-passes
dummy key on purpose, so a report filed from a preview is correctly rejected.
