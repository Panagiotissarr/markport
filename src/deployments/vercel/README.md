# Vercel deployment (client-only + bidirectional sync)

Runs the static app **and** the `/sync/v1` protocol as Vercel serverless
functions, with vault sync state in **Neon Postgres**. The app itself is the
same browser-only build the Cloudflare deployment ships (OPFS vaults, no
server-side file storage) — this deployment adds the piece Cloudflare's static
host doesn't have: a sync endpoint devices can **push to and pull from**.

| | |
|---|---|
| App | static, built into `public/` (`npm run build`) |
| Sync | `/sync/v1/*` functions in `api/` (`vercel.json` rewrites `/sync/v1/:path*` → `/api/sync/v1/:path*`) |
| Proxy | `POST /api/proxy-request` (same allow-listed GitHub/obsidian.md proxy as the Cloudflare Worker) |
| Storage | Neon Postgres (`DATABASE_URL`) — blobs, per-vault file table, revision cursor |
| Auth | `SYNC_TOKEN` (operator Bearer key) + per-vault password claims (`mpv1.*` scoped tokens); fail-closed: unset → every sync request answers 503 |

## Why chunking exists (Vercel's 4.5 MB body cap)

Vercel caps **both** request and response bodies at 4.5 MB, so:

- **Uploads** are chunked: `PUT /sync/v1/blob/:hash` sends
  `{index, total, size, data}` (base64) 2 MB at a time; the store assembles,
  verifies the sha-256 against the URL's hash, then materializes the blob.
- **Downloads** are windowed: a blob over 3 MiB answered an *un-ranged* GET
  with `413`, which `remote-client.js` reads as "come back with
  `?start=&end=`" and reassembles in 2 MB ranges (`206` + `Content-Range`).
- **Manifest pages** paginate (`?after=&limit=`, `hasMore` in the response)
  — 2000 paths per page, so a large vault never builds one giant response.

Small vaults never notice any of this; it's invisible below the client.

## Conflicts

The protocol is hash-based optimistic concurrency: every push carries
`baseHash` (what that device last synced for the path), and the server applies
an operation only if its current effective hash still matches — otherwise it
reports its state back and **nothing is overwritten**. The client then follows
one rule (`plan-sync.js` / `run-sync.js`):

> **The server wins at the original path; the local divergent content is
> preserved as `name.conflict-YYYYMMDDHHMMSS.ext`** (unpushed until the next
> sync, which pushes it as a new file).

A delete-vs-edit resolves the same way: the edit survives, the deletion is
abandoned (or, if the local side had newer content, it becomes the conflict
copy). See `src/client-mobile/sync/plan-sync.js`'s header for the full
decision table.

Older pull-only servers (`src/sync-server/` v1) answer `501` on push
endpoints; the client detects that and finishes the run as a pull-only sync
(`pushSupported:false`) instead of failing.

## Setup

```bash
# 1. a Neon database (free tier is fine), then:
cd src/deployments/vercel
npm install
DATABASE_URL=postgres://… npm run migrate   # idempotent; also applied lazily on first use

# 2. build locally (vendor/ exists only on your machine — see repo README setup)
npm run build        # -> public/

# 3. link, configure, ship
vercel link --yes --project <name>
vercel env add SYNC_TOKEN   production --value <long-random-token> --yes
vercel env add DATABASE_URL production --value <neon-pooled-url>    --yes
vercel deploy --prod        # uploads public/ + api/, runs no build remotely
```

> **The Vercel project's Build Command must be empty** (Settings → Build
> Command, or `vercel project update <name> --build-command ""`). The build is
> local-only on purpose: `vendor/` (Obsidian's bundle) is gitignored, so it
> never exists on Vercel's builder and `npm run build` fails there by design —
> same rule as the Cloudflare deployment: build the artifact on your machine,
> ship the artifact. `vercel.json` therefore carries no `buildCommand` either.
>
> Because of that, **do not connect this repository in Vercel Project Settings →
> Git** — a Git-connected build would run on Vercel with no `vendor/` and deploy
> an empty site. Automatic deploys come from `.github/workflows/deploy.yml`
> instead: it performs the vendor download that Vercel's builder cannot do, then
> builds and runs `vercel deploy --prod`. It needs three repository secrets
> (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`); the IDs are in
> `src/deployments/vercel/.vercel/project.json`. Vercel does not support OIDC for
> the deploy step itself, so `VERCEL_TOKEN` is a long-lived token — scope it to
> this team. The manual flow below keeps working and remains the local path.

Environment variables (Vercel → Project → Settings → Environment Variables):

| Var | Required | Meaning |
|---|---|---|
| `SYNC_TOKEN` | **yes** | Bearer token devices present. Unset → every `/sync/v1` request gets 503 (fail-closed on purpose) |
| `DATABASE_URL` | **yes** | Neon **pooled** connection string (`-pooler` host, `sslmode=require`) |
| `SYNC_STORE` | no | `postgres` (default) \| `memory` (local dev only — data dies with the process) |
| `SYNC_MAX_BLOB_BYTES` | no | largest single file, default 64 MiB |
| `SYNC_BLOB_FULL_GET_LIMIT` | no | un-ranged GET cap, default 3 MiB |
| `SYNC_PG_SSL_NO_VERIFY` | no | `1` → skip TLS verification (TLS-intercepting proxies only) |

## Vault names and password claims

A vault's **name is its id** and its **password is the credential** — nothing
per-device to copy around:

| | |
|---|---|
| `GET /sync/v1/vaults/:name` | public status → `{name, claimed}` (`no-store` — the web gate needs it before any password is known) |
| `POST /sync/v1/vaults/:name` `{password}` | unclaimed → **claim** it (201) · claimed → **unlock** (200) · wrong password → 401 · bad request → 400 · 10 attempts/min/IP → 429 |
| Name rule | `^[A-Za-z0-9._-]{1,64}$` — the same id used in `?vault=` and in `/vault/<name>` links |
| Password rule | 8–1024 characters; scrypt-hashed with a random 16-byte salt, constant-time compare |
| Token issued | `mpv1.<b64url(name)>.<expMs>.<hmac-sha256>` — 90-day TTL, HMAC keyed by `SYNC_TOKEN` |

Claims fail closed with everything else: `SYNC_TOKEN` unset (or unset at
claim time) → 503, because that key *is* the HMAC key. Two kinds of Bearer
token are then accepted by `requireAuth`:

- **`mpv1.*` vault tokens** — scoped to their one vault; any other `?vault=`
  value answers `403` ("this token is only valid for vault …"). Scope is
  enforced centrally in `getVaultOrThrow`, so manifest/blob/commit/blobs-missing
  all inherit it.
- **The global `SYNC_TOKEN`** — the operator key: every vault, no expiry.
  Also the recovery route (there is no password reset in v1: a name stays
  claimed to whoever first claimed it).

### The browser flow

1. Open `/vault/<name>` — or just `/<name>`: a single-segment short link 302s
   to `/vault/<name>` (`vercel.json` has the redirect; `scripts/dev.js` and
   boot.js mirror it). During boot the client fetches the vault's status and
   renders a **password gate** instead of the usual "no backend" error.
2. Unclaimed: the typed password **claims** the vault. Claimed: it must
   **unlock** it (wrong password → stay on the gate with an error).
3. Success stores the config **in `sessionStorage`** — the vault password is
   *session-only*: it survives reloads and in-tab navigation, but closing the
   tab/browser forgets it and the next visit asks for the password again. A
   non-secret `localStorage['ow-sync-claimed:<name>']` marker remembers the
   vault was claimed here, so returning visitors get a prefilled **Unlock**
   prompt instead of a claim screen (one-time migration moves any pre-session
   `localStorage['ow-sync:<name>']` config into sessionStorage). The client
   reads session storage first and falls back to the manual
   `localStorage['ow-sync:<vaultId>']` operator config, which still works.
4. Unlock flows straight into a **startup sync**: pull+push runs *before*
   Obsidian loads (pulled notes are visible immediately — no reload
   round-trip), then edits **auto-push** in the background (~20 s debounce,
   best-effort flush when the tab hides, retries with backoff). The manual
   Push/Pull buttons stay in the file explorer.
5. `/starter` is a **minimal "Enter URL" screen**: one input — type a vault
   URL or name and go. A bare name opens `/vault/<name>` (gate/claim as
   above; when this server has no claim endpoint, a same-name local vault can
   be created inline). The Obsidian bundle never loads on `/starter`.

### The Obsidian plugin

`src/neon-sync-plugin/` speaks this same protocol from desktop **and** mobile
Obsidian: paste the claimed `/vault/<name>` URL into its **Vault URL** field,
enter the password and press **Connect** (the same claim/unlock endpoint — a
password set in one client unlocks the vault in the other), then **Sync now**
(pull + push) or **Pull** (download-only). Prebuilt zip:
`src/neon-sync-plugin/release/`; changelog: the repo's GitHub releases
(`neon-sync-v*`). See its README for install options (including BRAT on
mobile).

## Domains

Every hostname that should reach the API must be attached to **this**
Vercel project (root directory `src/deployments/vercel`) — that is what makes
`/sync/v1/*` exist, and every hostname attached here shares the same
`DATABASE_URL`, so a vault claimed through one is visible through the others.
A project rooted at `src/sync-server` looks similar in the dashboard and
answers `500` on every request (it is a `bun index.js` filesystem server —
see that directory's README); the Obsidian plugin reports that as
`manifest: HTTP 500 — the deployment crashed before answering`. Adding a
hostname here needs no code change: Vercel issues the certificate through
`http-01` as long as DNS points at Vercel (Cloudflare: **DNS only**, grey
cloud).

## Point a device at it

The easiest path needs no code: open `/vault/<name>`, type the password (or
use the Obsidian plugin). For a manual setup — e.g. pointing a device straight
at the operator's `SYNC_TOKEN` — the same localStorage config as the
pull-sync protocol still works:

```js
localStorage.setItem('ow-sync:<vaultId>', JSON.stringify({
  baseUrl: 'https://your-app.vercel.app',
  token: 'the-SYNC_TOKEN-value',
  vault: 'home',          // optional — omits to the server's default vault
}));
```

Two buttons appear in the file explorer (local OPFS vaults only, only when
this config exists — no config means no buttons and no network at all):

- **Push** (cloud-upload) — upload local changes and commit them (`baseHash`
  CAS); never rewrites or deletes a local file. CAS conflicts are reported
  and resolved by the next Pull.
- **Pull** (cloud-download) — download server changes, resolve conflicts
  (server wins at the original path, local content preserved as a
  `name.conflict-<stamp>.ext` copy) and conform local deletions. Prompts
  first ("the page will refresh after pulling"), then reloads the page on
  success — the sync writes OPFS outside Obsidian's adapter, so the file
  explorer only shows pulled notes after a reload. Push never touches local
  files and never reloads.

On top of the manual buttons, a claimed vault **syncs automatically**: the
startup pull+push (see "The browser flow"), an auto-push ~20 s after the last
edit, and a best-effort flush when the tab hides. Auto-pushes are silent;
repeated failures surface as a throttled Notice. Pulling is never automatic
while the app is running — OPFS writes outside Obsidian's adapter only show
up after a reload, which would disrupt your work (that's what the startup
sync is for). Every sync request retries transient failures (network errors,
429/5xx) with exponential backoff + jitter, downloads run 4 blobs in
parallel, and a partial pull keeps what arrived instead of failing the whole
sync.

Every click shows exactly one Notice with the result (or the failure's own
message for 10 s); each request times out after 30 s so a stalled connection
can never leave the spinner running. Every device using the same `vault`
value shares one server-side vault; the local `<vaultId>`s don't have to
match each other.

## Scripts

```bash
npm run build      # scripts/build-assets.js -> public/  (same copies/markers as the Cloudflare build)
npm run dev        # local server: public/ + real /sync/v1 handlers + proxy (SYNC_STORE=memory, prints a dev token)
npm run migrate    # apply lib/schema.sql (idempotent)
npm test           # node --test — protocol, stores, proxy, adapter, fixture build
```

`npm run build` is a **Node port of the Cloudflare `scripts/build-assets.sh`**
— same sources, same markers, same cache-busting, deliberately kept in sync.
Differences: output is this package's `public/`, and there is no `_worker.js`
or `_headers` (functions live in `api/`, headers in `vercel.json`).

## Key files

| File | Purpose |
|------|---------|
| `vercel.json` | rewrites: `/sync/v1/*` → functions, `/starter` + `/vault/*` → SPA fallback; redirects: `/{VAULT_NAME}` short links → `/vault/{VAULT_NAME}` |
| `lib/adapter.js` | Vercel `(req,res)` ⇄ web-standard `(Request)=>Response` bridge |
| `lib/auth.js` | Bearer token check (sha-256 + constant-time compare, fail-closed); sets `request.vaultScope` for `mpv1.*` tokens |
| `lib/claims.js` | password hashing (scrypt) + `mpv1.*` token issue/verify |
| `lib/http.js` | `getVaultOrThrow` — vault resolution **and** the central scope check (403) |
| `lib/commit-rules.js` | the CAS/conflict rules — one implementation shared by both stores |
| `lib/store-pg.js` | Postgres store: batched SQL (≤5 round-trips per commit), lazy schema, GC |
| `lib/store-memory.js` | reference store (dev + tests) |
| `api/sync/v1/manifest.js` | paginated manifest + ETag cursor |
| `api/sync/v1/blob/[hash].js` | chunked upload / immutable download / byte ranges |
| `api/sync/v1/commit.js` | push: apply-or-conflict, `422 {hashes}` retry contract |
| `api/sync/v1/blobs/missing.js` | "which of these don't you have?" (skip re-uploads) |
| `api/sync/v1/vaults/[name].js` | vault status / claim / unlock (password is the credential) |
| `api/sync/v1/{changes,live,deletions}.js` | `501` stubs (not needed by this client) |
| `api/proxy-request.js` | port of the Cloudflare `proxy-worker.js` (no Cache API) |
| `scripts/build-assets.js` | static build (port of the Cloudflare build script) |
| `scripts/dev.js` | local dev server, Vercel-shaped routing |

## Tests

```bash
npm test
```

- protocol: auth (fail-closed, empty-body 401), manifest pagination/ETag,
  blob chunking/ranges/`413`, commit CAS + conflict + `422`, validation limits
- vault claims: scrypt claim/unlock round-trips, wrong password, scoped-token
  403 matrix, per-IP rate limit (429), name validation (`test/claims.test.js`,
  `test/vaults.test.js`)
- `lib/store-memory.js` — the contract `lib/store-pg.js` must match
  (the PG store itself is exercised against a real database when
  `DATABASE_URL` points at one — it's opt-in, never runs against production
  config by accident)
- `api/proxy-request.js` — allow-list, SSRF/redirect guard, per-IP rate limit
  (outbound `fetch` is stubbed; no network in tests)
- `test/build-assets.test.js` — full fixture build in a temp dir (this repo
  ships without `vendor/`, so the test provides a stand-in)

## Keeping things in sync (on purpose)

- `scripts/build-assets.js` ⇄ `src/deployments/cloudflare/scripts/build-assets.sh`
  — same copy list and index.html markers; change both.
- `api/proxy-request.js` ⇄ `src/deployments/cloudflare/proxy-worker.js` ⇄
  `src/runtime-server/server/api/proxy.js` — one allow-list, three runtimes.
- The protocol surface mirrors `src/sync-server/` (the reference implementation):
  same auth, same manifest/blob shapes, same empty-body 401s — a client that
  works against one works against the other (pull-only `src/sync-server/`
  simply 501s the push endpoints, which the client treats as
  "no push support").
- `src/neon-sync-plugin/main.js` copies `planSync` **verbatim** from
  `src/client-mobile/sync/plan-sync.js`; both test suites run the same
  decision-table vectors — change both files together.
