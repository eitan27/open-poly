# Cloud Storage & Sync — Design Plan

**Status:** proposal, nothing implemented. Written to be argued with.

Open Poly is local-first: documents live in the browser's IndexedDB and nothing
leaves the machine. This document plans how to add **optional, free, sign-in
backed sync** — "sign in with GitHub, your documents become files in your own
private repo" — without giving up the property that makes the app worth using.

---

## 0. Why bother, and what stays true

**Why.** Three concrete failures of local-only storage, in rough order of how
often they'll bite:

1. **Browser storage is not durable.** Safari evicts IndexedDB for sites not
   visited in 7 days. Chrome evicts under storage pressure. "Clear browsing
   data" takes everything. `navigator.storage.persist()` helps and should be
   requested regardless, but it is a request, not a guarantee. Today a user can
   lose every model they own by clicking the wrong button in a settings pane.
2. **One machine.** Model on the desktop, no way to open it on the laptop
   short of exporting a `.openpoly.json` and emailing it to yourself.
3. **No history.** `putDoc` is last-writer-wins over a single record. Delete a
   feature, autosave fires, close the tab — that state is the only state.

**What must stay true**, or this feature is a net loss:

- **The app works signed out, forever, with no degradation.** No login wall, no
  "sync required to save", no account nag on first load. Signing in is a thing
  you do on day thirty when you've decided you care.
- **IndexedDB stays the source of truth.** The cloud is a replica the app pushes
  to and pulls from. No request is ever on the critical path of an edit; the
  viewport never waits on a network.
- **Documents never transit a server we run.** They go browser → GitHub, or
  browser → Google, directly. See §2.
- **Free means free**, for the user and for whoever hosts a deployment. No
  paid tier, no per-seat storage bill, no credit card behind the "free" label.

**Explicit non-goals** (v1, and probably v2): real-time collaboration, shared
documents, folders/tags, comments, sync of cached meshes, end-to-end
encryption, a hosted Open Poly account system of our own.

---

## 1. The shape of the answer

```
   ┌────────────────────────── the browser ──────────────────────────┐
   │                                                                 │
   │   React app ── doc edits ──▶ IndexedDB  (source of truth)       │
   │                                  │                              │
   │                            src/sync/engine                      │
   │                                  │                              │
   │                          SyncProvider (iface)                   │
   │                          ╱                ╲                     │
   │                 GitHubProvider        DriveProvider             │
   └──────────────────────╱──────────────────────╲──────────────────┘
                         ╱  access token in memory ╲
                        ╱                           ╲
        ┌──────────────▼───────┐          ┌──────────▼─────────────┐
        │  api.github.com      │          │  googleapis.com/drive  │
        │  your private repo   │          │  your "Open Poly" dir  │
        └──────────────────────┘          └────────────────────────┘
                        ▲
                        │  tokens only, never documents
        ┌───────────────┴──────────────────┐
        │  auth broker  (~200 lines)       │
        │  Cloudflare Pages Function, or   │
        │  the Vite dev server locally     │
        └──────────────────────────────────┘
```

**The load-bearing decision: the server we run is an auth broker, never a data
path.** It exists because GitHub will not let a browser exchange an OAuth code
for a token (§2.1). It handles one request per sign-in and never sees a
document.

Three reasons this isn't just aesthetics:

- **Privacy is then structural, not promised.** Whoever deploys Open Poly
  _cannot_ read your models, because the bytes never route through them. That's
  a claim we can make in the README without a caveat.
- **The cost stays zero.** Cloudflare Pages Functions bill by invocation
  (100k/day free). Auth-only: a login is ~2 invocations, so the free tier
  covers roughly 50,000 sign-ins a day. Route document writes through it
  instead — at one push per minute per active user, 1,440/day each — and the
  free tier runs dry at about **69 concurrent users**. That single number
  decides the architecture.
- **Forks stay cheap.** Anyone can deploy Open Poly and only needs to stand up
  a stateless function with two secrets in it.

---

## 2. Auth

The two providers have almost exactly opposite constraints. This is worth
internalising before designing anything, because it drives where code runs.

|                                          | **GitHub**                                                                                                                        | **Google Drive**                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser can complete the OAuth exchange? | **No** — PKCE is supported (since Jul 2025) but the client secret is still required, and the token endpoint sends no CORS headers | **Yes** — the GIS token model (`initTokenClient`) hands a browser an access token with only a `client_id`                                                        |
| Server needed for sign-in?               | **Yes**                                                                                                                           | **No**                                                                                                                                                           |
| Token lifetime                           | 8 h (GitHub App user token) with a refresh token                                                                                  | **1 h, no refresh token** in the browser flow                                                                                                                    |
| Silent renewal?                          | Yes, via the broker                                                                                                               | No — needs a user gesture, or a broker + code flow                                                                                                               |
| Data API callable from a browser?        | Yes, `api.github.com` sends `Access-Control-Allow-Origin: *`                                                                      | Yes                                                                                                                                                              |
| Approval/verification cost               | None                                                                                                                              | None **if** we stay on the non-sensitive `drive.file` scope; the broad `drive` scope is _restricted_ and triggers an annual paid third-party security assessment |

So: **GitHub needs a server for auth but not for data. Google needs no server
for auth, and pays for it with an hourly reconnect.** Neither needs a server
for data, which is the part that matters.

### 2.1 GitHub — a GitHub App, not an OAuth App

**Decision: register a GitHub App, not an OAuth App**, with repository
permissions `contents: read & write` and `metadata: read`.

The reason is scope granularity. An OAuth App that wants to write to a _private_
repo must request the `repo` scope, which is **all repositories the user can
touch, read and write, forever**. Handing that to a hobby CAD app to store some
JSON is indefensible. A GitHub App is installed against **user-selected
repositories**, so the grant is literally "this one repo", the token expires,
and the user can see and revoke it per-repo.

The cost is two extra clicks at setup: GitHub Apps can't conjure a repo without
the heavyweight `administration: write` permission, so the setup flow is
"create a private repo (we'll link you, suggest the name `open-poly-documents`)
→ install Open Poly Sync on it". **This trade is worth it** and should not be
quietly reversed later for onboarding-funnel reasons.

Flow, with the broker:

```
GET  /api/auth/github/start
       → 302 to github.com/login/oauth/authorize
         with state + PKCE challenge; verifier & state in __Host- cookies
GET  /api/auth/github/callback?code&state
       → verify state cookie, exchange code (client_secret + verifier)
       → encrypt the refresh token, set it as an httpOnly cookie
       → 302 back into the app
GET  /api/auth/session
       → refresh-token-in-cookie → fresh access token in the JSON body
POST /api/auth/signout  → clear the cookie
```

**The broker is stateless — there is no database.** The session _is_ the
encrypted cookie (`__Host-op_sess`, httpOnly, Secure, SameSite=Lax, AES-GCM
under a Pages secret). Nothing to back up, nothing to leak, nothing to run.

**The access token lives in a JavaScript variable and nowhere else.** Not
localStorage, not IndexedDB. On reload the app calls `/api/auth/session` and
gets a new one. Be honest about what this buys: an XSS on the app's origin can
still read an in-memory token. The real mitigation is that the token can only
touch _one repository_, and revocation is one click on github.com.

### 2.2 Google — brokerless first

Use the GIS token model: `google.accounts.oauth2.initTokenClient({ client_id,
scope: "https://www.googleapis.com/auth/drive.file" })`. No secret, no broker,
no server. The client ID is public by design and can sit in the bundle.

`drive.file` grants access only to files **this app created** — it cannot see
the rest of the user's Drive, which is both the right permission and the reason
we dodge Google's restricted-scope security assessment. Do not widen it. If
some future feature seems to need `drive.readonly`, the feature is wrong.

The price is the hourly expiry with no refresh token. Handle it as UX, not as
an error: when the token dies, the sync chip goes to `☁ Reconnect` and the next
click re-authorises (usually without a consent prompt, since the grant already
exists). A broker-based code flow with a refresh token is the upgrade path if
that turns out to be annoying in practice — measure before building it.

**Open question, must be resolved before shipping S4:** an app in Google's
"Testing" publishing status is capped at 100 users. Publishing to Production
with only non-sensitive scopes should be a branding review rather than a
security assessment, but _verify this against current policy_ — if a public
Open Poly deployment can't get past a cap, the Drive provider becomes
self-host-only and that changes how we describe it.

### 2.3 The token-paste path (and why it ships first)

Settings → Advanced → "Sync with a GitHub token": paste a **fine-grained PAT**
scoped to a single repository with contents write. Stored in IndexedDB with a
plain-language warning.

This is worse security than OAuth (it persists across reloads, so XSS reaches
it) and worse UX. It ships first anyway, for three reasons: it needs **zero
auth infrastructure**, so the entire sync engine can be built and tested
against the real GitHub API before a line of OAuth exists; it's the only option
for an air-gapped or oddly-hosted self-host; and it keeps the provider
interface honest about tokens coming from somewhere other than a broker.

### 2.4 Threat model, stated plainly

| Risk                                    | Mitigation                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment operator reads your models   | Structurally impossible — documents never touch our server                                                                                               |
| Stolen broker secrets                   | Broker holds no user data; rotate the Pages secrets, all sessions die                                                                                    |
| XSS on the app origin                   | Strict CSP, no third-party scripts (already true — the site is static), in-memory tokens, one-repo / `drive.file` scope, one-click revocation            |
| Provider outage / rate limit            | Local-first: everything keeps working, sync queues and retries                                                                                           |
| The MCP agent pushing junk to your repo | Agent edits flow through the same pipeline, so yes, an agent can commit. It's git — `git revert`. Document this behaviour where the bridge is documented |
| We lose your data                       | We never have it. The failure mode is "sync stopped", never "data gone"                                                                                  |

The README's "nothing leaves your machine" becomes: _"Nothing leaves your
machine unless you sign in — and then it goes to your GitHub or your Drive, not
to us."_

---

## 3. Where the code runs

One handler module, three mounts. `functions/lib/authBroker.ts` exports a
runtime-agnostic `handle(request, env)`; everything else is a thin adapter.

| Environment               | Auth broker                                                                                                     | Notes                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run dev` (127.0.0.1) | A ~30-line Vite plugin mounts `handle()` as dev middleware, reading `.dev.vars`                                 | GitHub sign-in works locally; register `http://localhost:5173` as a callback URL on a dev GitHub App |
| Cloudflare Pages          | `functions/api/auth/[[route]].ts` calls `handle()`; secrets via `wrangler pages secret put`                     | Same pattern the existing `/api/report` function already established                                 |
| Self-host anywhere        | Deploy the function, or set `VITE_AUTH_BROKER_URL` at another origin, or use the PAT path with no broker at all |                                                                                                      |
| Fork of the project       | Needs its own GitHub App + Google client ID (both providers pin redirect URIs/origins)                          | Documented in `functions/README.md`                                                                  |

Config surface, all optional — absent values just disable that provider's
sign-in button, exactly like `GITHUB_ISSUES_TOKEN` disables bug reporting today:

```
VITE_GITHUB_APP_SLUG     # for the install link
VITE_GITHUB_CLIENT_ID
VITE_GOOGLE_CLIENT_ID
VITE_AUTH_BROKER_URL     # default: same-origin /api
GITHUB_CLIENT_SECRET     # broker secret
SESSION_KEY              # broker secret, AES-GCM key for the cookie
```

**Design call that binds: no provider is ever hard-required.** A build with none
of these set is exactly today's app, with no dead UI.

---

## 4. What gets stored, and what never does

### 4.1 What syncs

Only the `.openpoly.json` envelope that `src/storage/docFile.ts` already
produces: `{ format, version, name, doc }`, pretty-printed with two-space
indent. That last detail is not cosmetic — it's what makes a diff on github.com
readable, which is half the appeal of the GitHub backend.

**Never synced:**

- **`meshes`** — the tessellation cache. Megabytes, regenerable, and already
  excluded from the file format. Syncing it would be the single worst decision
  available here.
- **`meta.thumb`** — regenerate locally on first regen. Committing PNGs bloats
  git history permanently for a picker nicety.
- **`sectionView`** — per-device view state. Arguably it should follow you, but
  it changes constantly and would generate commits that touch no geometry. Punt.
- **Settings.** Device-local.

### 4.2 GitHub layout

```
open-poly-documents/                 (private, user-owned)
├── README.md                        written once: what this repo is, and that
│                                    it's safe to edit/delete files by hand
├── documents/
│   ├── bracket-4f2a91.openpoly.json
│   └── gear-plate-91c7d3.openpoly.json
└── .open-poly/
    └── tombstones.json
```

Filenames are `<slug(name)>-<short id>.openpoly.json`. The id makes the path
unique and stable (names are user-editable and duplicable); the slug makes the
repo browsable, which is the point. A rename moves the file within a single
commit via the Git Data API, so history follows it. The alternative —
`<id>.openpoly.json`, never renamed — is simpler but turns the repo into a wall
of hex, and "browse my CAD files on GitHub" stops being a feature.

**Writes use the Contents API's `sha` parameter, which is free optimistic
concurrency**: `PUT /repos/{o}/{r}/contents/{path}` with the blob sha we last
saw. A mismatch returns 409, which is precisely the conflict signal §5 needs —
no lock, no coordination, no extra request. The Contents API caps around 1 MB;
a document that exceeds it (which would be an extraordinary feature tree) falls
back to the Git Data API blob→tree→commit path, which is also what multi-file
atomic writes (rename, or doc + tombstone) use.

`tombstones.json` is `{ "<docId>": { deletedAt, name } }` — see §5.4.

### 4.3 Drive layout

A visible `Open Poly/` folder in My Drive with `<Name>.openpoly.json` files.
Visible, not the hidden `appDataFolder`: users should be able to see, back up,
and share their own files, and `drive.appdata` would need a separate scope for
the privilege of hiding them.

Identity rides in `appProperties` (private to the app, invisible to the user,
queryable): `{ openPolyDocId, contentHash, schema }`. So Drive needs no index
file and no filename encoding — query by `appProperties has {key='openPolyDocId'
and value='…'}`.

Deletes go to Drive's trash, which is a real, recoverable delete signal that the
`changes` API reports. **Drive therefore needs no tombstones file**; GitHub
does, because a git tree only tells you what exists.

**Known gap:** Drive v3's `files.update` has no documented compare-and-swap
(no `If-Match`). Conflict detection there is read-version-then-write, which
leaves a narrow race. Confirm current API behaviour during S4; if there's
genuinely no precondition support, accept the race — the loser's content is
still recoverable from Drive's own revision history, and the window is
sub-second against a sync cadence measured in tens of seconds.

---

## 5. Sync semantics

The part that's actually hard. Everything above is plumbing.

### 5.1 State, per document

DB v3 adds a `sync` object store:

```ts
interface SyncRecord {
  docId: string;
  provider: "github" | "gdrive";
  remoteId: string; // path (GitHub) | fileId (Drive)
  remoteVersion: string; // blob sha | version
  syncedHash: string; // hash of the content both sides last agreed on
  lastSyncedAt: number;
  state: "synced" | "pending" | "conflict" | "error";
  error?: string;
}
```

`hash` is SHA-256 of the serialized doc file (`crypto.subtle`, ~instant for
tens of KB). Comparing the two sides is then a three-value check:

| local hash vs `syncedHash` | remote version vs `remoteVersion` | action              |
| -------------------------- | --------------------------------- | ------------------- |
| same                       | same                              | nothing             |
| **changed**                | same                              | **push**            |
| same                       | **changed**                       | **pull**            |
| **changed**                | **changed**                       | **conflict** (§5.3) |

Hashing content rather than trusting `updatedAt` matters: undo/redo back to a
previous state produces a byte-identical file, and shouldn't generate a commit.
Treat the hash strictly as an optimisation, though — correctness comes from the
remote version compare, because nothing guarantees key ordering survives a
future `migrateDocument`.

### 5.2 Cadence — decoupled from autosave

Autosave is a 600 ms debounce to IndexedDB. **Pushing on that cadence would be
a disaster**: GitHub allows 5,000 requests/hour, and a repo with 40,000 commits
titled "Update Bracket" is not version history, it's noise.

Push is scheduled at `max(20 s idle, 60 s since last push for this doc)`, and
flushed immediately on:

- document switch (the existing `flushSave` already marks this boundary),
- `visibilitychange → hidden`,
- explicit **Sync now**,
- sign-out.

There is deliberately **no `beforeunload` push**. It can't await a fetch, and
`sendBeacon` can't set an `Authorization` header, so it would be theatre. The
last ≤20 s of edits may exist only locally until the app is next opened — which
is _fine_, and is exactly the property local-first buys: the local copy is not
a cache of the remote, it's the original.

Pull runs on boot, on window focus, every 5 minutes while visible, and on
explicit refresh. It's cheap: on GitHub, one conditional `GET` of the
`documents/` tree with an `If-None-Match` ETag — **304s don't count against the
rate limit** — and on Drive, `changes.list` with a stored `pageToken`. No
webhooks in v1; they'd need a public endpoint and turn the broker into
infrastructure.

**Only one tab syncs.** Elect a leader with the Web Locks API
(`navigator.locks.request("openpoly-sync", …)`, held for the tab's lifetime);
followers render status received over the existing `openpoly-docs`
BroadcastChannel. Without this, N tabs race each other into conflicts of their
own making.

### 5.3 Conflicts — never auto-merge

**Design call that binds: an Open Poly document is never merged automatically,
by us or by git.**

The reason is specific to CAD, not general caution. A `Document` is a graph of
features referencing each other and referencing topology by id. Textually
merging two feature arrays can yield a tree that references a face deleted on
the other branch, or duplicates an id, or reorders operations so a fillet
precedes the extrude it fillets. The result parses, saves, and _regenerates into
silent garbage_ — the worst possible failure for a modeling tool. A conflict the
user resolves by looking at two models is strictly better than a merge nobody
inspected.

So, on conflict:

1. **Remote keeps the canonical path.** It's what other devices already agree
   on.
2. **The local version is preserved as a new document**: `Bracket (conflict from
this device, 14:02)`, a fresh id, immediately visible in the Documents
   dialog. Nothing is ever overwritten or discarded.
3. **On GitHub, the loser is also pushed to a branch** —
   `conflict/<docId>/<timestamp>` — so it's recoverable from any device and
   diffable on github.com. This is the moment the git backend earns its keep.
4. **The user is told once**, non-modally: a banner in the Documents dialog and
   a `⚠` on the row. Never a modal — they might be mid-drag on a gizmo.

Auto-resolve exactly one case: if the conflicting contents hash equal, it isn't
a conflict — record the new version and move on.

### 5.4 Deletes — absence is never a delete signal

The catastrophic bug in every naive sync: browser storage is cleared, the
client sees zero local documents, concludes they were all deleted, and
propagates that to the server. **A document missing locally means nothing.**
Only an explicit user delete deletes.

- Delete locally → write a tombstone (GitHub: `.open-poly/tombstones.json`, in
  the same commit that removes the file; Drive: move to trash) → other devices
  see a tombstone newer than their copy and remove their local record.
- Recovery is always available: git history on GitHub, trash on Drive. Deletes
  are never destructive at the storage layer, and the delete confirmation
  should say so once the doc is synced ("also removed from your repo —
  recoverable from history").
- Tombstones are garbage-collected after 90 days.
- A file deleted **by hand** in the repo (no tombstone) is treated as a
  deliberate remote delete on next pull, because the user did it in the user's
  own repo. Confirm before removing local copies.

### 5.5 Offline

Sync failures are never modal and never block. Failed pushes stay `pending`
with exponential backoff (2 s → 5 min cap), resume on `online` and on focus.
The chip reads `⚡ Offline — 3 pending`. Rate-limit responses are surfaced with
their reset time (`GitHub is throttling — retrying in 4 min`), never as a
generic error, and never silently.

---

## 6. UX

### 6.1 Signing in

Entry points: an avatar/cloud slot at the right of the topbar (beside the
existing status chip and Agent badge), and a "Sync documents" row in the
Documents dialog header. Nothing on first load. No interstitial, ever.

First-run, after choosing GitHub:

1. **A plain-language panel before any redirect** — what will happen, what
   we'll be able to touch, what we won't. Literally: _"Open Poly will create a
   file per document in one private repository you choose. It can't see your
   other repositories."_
2. GitHub consent → repo picker (this is GitHub's install UI, which is more
   trustworthy than anything we'd draw).
3. **The first sync is confirmed, with counts**: _"Upload 12 documents to
   `you/open-poly-documents`?"_ — because "sign in" implying "upload everything
   I've ever made" is a surprise, once, and a bad one.
4. Then a progress line, then done.

Default after connecting: **sync everything.** Per-document opt-out exists but
isn't the first choice; an opt-in-per-doc default produces users who think
they're backed up and aren't.

### 6.2 Status, permanently visible

One chip, next to the document title. States, and nothing else:

|                          |                                                                 |
| ------------------------ | --------------------------------------------------------------- |
| `☁ Synced · 2m ago`      | idle, everything pushed                                         |
| `⟳ Syncing…`             | in flight                                                       |
| `⚡ Offline · 3 pending` | queued                                                          |
| `⚠ Conflict`             | needs a decision — click opens the Documents dialog at that row |
| `☁ Reconnect`            | token expired (the Google hourly case)                          |
| _(absent)_               | signed out — no nag, no placeholder                             |

Hovering shows the remote location. The Documents dialog gets a per-row badge
using the same vocabulary, plus a **link to the file on github.com / Drive**.
Transparency is the trust mechanism here: the user should be able to click
through and see their own JSON sitting in their own repo, and to check the
commit history when they want to know what changed.

### 6.3 Remote documents in the picker

The dialog merges local `meta` rows with remote entries. A document that exists
remotely but not locally (new device, new browser) renders greyed with a
`↓ Open` action; content is fetched **on open**, not on list, so a fresh device
shows its whole library instantly and pays only for what it opens. Names and
dates come from the cheap listing.

### 6.4 Signing out

Ask once: **"Keep local copies? (recommended)"**, default yes. Signing out
never deletes local data — the app returns to exactly its signed-out behaviour
and the documents are still there. Also link the provider's revocation page,
because "how do I actually un-permission this thing" should not require a
search.

### 6.5 Messages, when things break

Every sync error names the cause and the next step. `Couldn't reach GitHub —
your work is saved locally and will sync when you're back online.` The second
clause is the entire point; without it a red icon reads as data loss.

---

## 7. Code shape

Mirrors the `Kernel` facade philosophy in `PLAN.md §0`: **own a thin interface,
keep provider SDKs out of app code.**

```
src/sync/
  types.ts          SyncRecord, RemoteEntry, SyncState
  hash.ts           content hashing                        (pure, tested)
  plan.ts           (local, remote, record) → Action        (pure, tested)
  engine.ts         scheduling, queue, backoff, leader election
  providers/
    provider.ts     the SyncProvider interface
    github.ts       Contents + Git Data API
    gdrive.ts       Drive v3
    memory.ts       in-memory fake                          (tests)
  auth/
    session.ts      broker client, in-memory token, renewal
    pat.ts          the paste-a-token path
functions/
  lib/authBroker.ts  runtime-agnostic handler
  api/auth/[[route]].ts
```

```ts
export interface SyncProvider {
  readonly id: "github" | "gdrive";
  list(): Promise<RemoteEntry[]>;
  read(remoteId: string): Promise<{ text: string; version: string }>;
  write(req: {
    remoteId?: string;
    docId: string;
    name: string;
    text: string;
    expectedVersion?: string;
  }): Promise<{ ok: true; remoteId: string; version: string } | { ok: false; conflict: string }>;
  remove(remoteId: string, docId: string): Promise<void>;
  /** Cheap "did anything change?" — ETag / pageToken. */
  poll(cursor?: string): Promise<{ changed: boolean; cursor?: string }>;
}
```

**`plan.ts` is where the thinking lives and it must be a pure function** —
`(localHash, syncedRecord, remoteEntry) → "noop" | "push" | "pull" | "conflict"
| "delete-local" | "delete-remote"`. Every semantic in §5 becomes a table-driven
unit test with no network and no IndexedDB, which is how the rest of this
codebase already tests its hard parts (`db.test.ts`, `docFile.test.ts`,
`sketch/inference.test.ts`). The engine and providers are then mechanical.

`MemoryProvider` plus `fake-indexeddb` (already a dev dependency) lets the full
engine — conflicts, tombstones, offline queue, two simulated devices — run in
Vitest with zero network.

App integration is deliberately small: the autosave effect gains one call to
`sync.noteLocalChange(docId)`, and the Documents dialog gains status props.
Nothing in the geometry, kernel, or document layers changes at all.

---

## 8. Budgets

|                                           | Free allowance       | Our use                            | Headroom                           |
| ----------------------------------------- | -------------------- | ---------------------------------- | ---------------------------------- |
| GitHub API                                | 5,000 req/h          | ≤60 pushes/h/doc, polls mostly 304 | ~100×                              |
| GitHub private repos                      | unlimited            | 1                                  | —                                  |
| Drive storage                             | 15 GB                | tens of KB per document            | ~500,000 docs                      |
| Pages Functions                           | 100k invocations/day | ~2 per sign-in                     | ~50k sign-ins/day                  |
| Pages Functions, _if_ it were a data path | same                 | ~1,440/user/day                    | **69 users** ← the reason it isn't |

A typical `.openpoly.json` is single-digit to low tens of KB. Storage is not a
constraint in any scenario; request _rate_ is the only budget that binds, and
the 20 s/60 s cadence keeps it two orders of magnitude clear.

---

## 9. Risks and open questions

|     | Risk                                                                        | Handling                                                                                                                                          |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Google's 100-user testing cap / verification** for a published deployment | Resolve before S4. Worst case: Drive is self-host-only, GitHub is the public path                                                                 |
| 2   | **Drive has no documented compare-and-swap**                                | Verify in S4; fall back to read-then-write with a narrow race, mitigated by Drive revision history                                                |
| 3   | **GitHub App install friction** loses users at setup                        | Accept. The alternative is `repo` scope on every repository they own, which is not a trade we should make                                         |
| 4   | **Commit noise** — one commit per push                                      | Accept for v1; it's a documents repo, not a codebase, and the history is genuinely useful. Revisit only if a real repo gets unpleasant to browse  |
| 5   | Broker becomes a dependency for a "local-first" app                         | It's optional, stateless, ~200 lines, and the PAT path bypasses it entirely                                                                       |
| 6   | Sync bugs eat someone's model                                               | Nothing overwrites: conflicts fork, deletes tombstone, git keeps history. The engine's pure core is table-tested before it ever touches a network |
| 7   | The README's privacy claim gets weaker                                      | Rewrite it precisely (§2.4) rather than letting it quietly drift                                                                                  |

---

## 10. Delivery

Each phase is independently useful and independently revertible.

|        | Phase               | Ships                                                                                                       | Why here                                                                          |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **S0** | Sync core           | `src/sync/` types, `hash.ts`, `plan.ts`, `MemoryProvider`, full test table. No UI, no network               | The semantics get proven while they're still cheap to change                      |
| **S1** | GitHub via PAT      | `GitHubProvider`, DB v3 `sync` store, Settings pane, per-doc status, push + pull-on-boot                    | Exercises the real API against real rate limits with **zero auth infrastructure** |
| **S2** | Real multi-device   | Conflicts + conflict branches, tombstones, offline queue, backoff, leader election, status chip             | Turns "backup" into "sync" — the phase where the semantics actually get tested    |
| **S3** | Sign in with GitHub | GitHub App, `functions/lib/authBroker.ts`, Pages Function, Vite dev plugin, session/renewal                 | The thing the plan is named after; deliberately last of the GitHub work           |
| **S4** | Google Drive        | `DriveProvider`, GIS token model, folder + `appProperties`, reconnect UX                                    | A second provider is also the test that the interface is real                     |
| **S5** | Polish              | Remote-only rows in the picker, open-from-cloud, conflict resolution UI, history links, `storage.persist()` |                                                                                   |

**S0→S1 is the whole bet.** If the pure planner and a PAT-driven GitHub
provider don't make multi-device feel obviously right, nothing downstream fixes
it, and we've spent no auth infrastructure finding out.

---

## 11. What would make us abandon this

Worth writing down while it's cheap to walk away:

- If GitHub's rate limits or the commit-per-save model make a real repo
  unpleasant after a month of actual use.
- If Google's verification puts a cap on a public deployment _and_ the GitHub
  path also proves awkward — at which point plain "export to a folder" via the
  File System Access API is a smaller, dumber, possibly better answer.
- If conflicts turn out to be common rather than rare in single-user
  multi-device usage. That would mean the cadence model is wrong, and would
  need rethinking before more surface gets built on it.
