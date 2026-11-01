# /sync/v1 — security review

Scope: the sync implementation only — the Vercel functions under
`api/sync/v1/**`, their store layer (`lib/store*.js`, `lib/claims.js`,
`lib/auth.js`, `lib/validate.js`), the outbound proxy (`api/proxy-request.js`),
and the client that stores the credentials (`src/neon-sync-plugin`).

Verdict: **no SQL-injection, path-traversal, auth-bypass or cross-vault scope
hole was found in the request handling itself** — every query is
parameterized, every path is validated, every endpoint authenticates before
touching the store, and a vault-scoped token is refused on any other vault.
The problems were at the *boundaries* of that model: who may become a
credential holder, how much a client can make the server store, what a shared
cache is allowed to keep, and which client-declared facts the server believed.

Everything marked **Fixed** has a regression test in
`test/security.test.js` that fails against the previous code.

---

## Critical (fixed)

### C1. Any stranger could claim an unclaimed vault that already had content
`api/sync/v1/vaults/[name].js` — `POST /sync/v1/vaults/<name>`

A claim *is* the credential: the first caller to POST a password for a name
gets an `mpv1.*` token for that vault. That is correct for an empty vault
("name the vault I am about to fill"), but the route never checked whether the
vault was already populated.

**Attack** (verified end-to-end, see `test/security.test.js` →
*"a stranger cannot claim a vault that already has content"*):

1. Operator syncs vault `diary` with `SYNC_TOKEN` and no password claim
   (perfectly normal — the token is the documented operator key).
2. Attacker reads the name from a `/vault/diary` URL (or guesses it; `GET
   /sync/v1/vaults/<name>` confirms it exists).
3. `POST /sync/v1/vaults/diary {"password":"attacker-password"}` → `201` +
   token.
4. Attacker lists and downloads every note in `diary`, and can overwrite or
   delete them.

**Impact**: full read/write access to another vault — the exact
cross-vault escalation the design is supposed to prevent. Severity is
critical because it needs no secret at all.

**Fix**: a *new* claim is refused with `409` when the vault already holds
content, unless the caller presents the operator `SYNC_TOKEN` (checked with
the same constant-time comparison as everywhere else). Vaults whose names were
claimed before content existed — the normal flow — are unaffected, and the
operator can still attach a password to an existing vault.

---

## High (fixed)

### H1. Upload amplification: the declared `size` was only a label
`lib/store-pg.js` / `lib/store-memory.js` — `putBlobPart`

Parts were validated individually (`size` ≤ `SYNC_MAX_BLOB_BYTES`, each part ≤
`MAX_PART_BYTES`) but never against each other, and the declared `size` was
never compared with the bytes actually uploaded.

**Attack**: declare `size: 1048576` and upload `MAX_CHUNKS` (4096) parts of
3 MiB each — ~12 GiB accepted for one hash, then `Buffer.concat()` in the
function tries to allocate it (OOM/timeout) while the rows sit in the database
until the 24-hour sweep. Repeatable per hash. Verified with a probe that
accepted 4095 parts for a blob that could never assemble.

**Fix**: a part may not exceed the declared size, and the sum of all parts
held for a hash (excluding the index being replaced) may not exceed it either
— enforced with a `sum(octet_length(data))` query inside the same transaction
in Postgres, and in the memory store for parity. Bytes held per hash are now
bounded by `SYNC_MAX_BLOB_BYTES`.

### H2. Token-gated bytes were marked `cache-control: public`
`api/sync/v1/blob/[hash].js` — `GET /sync/v1/blob/:hash`

The response carried `public, max-age=31536000, immutable`. RFC 9111 §3.5
lets a shared cache store a response to a request that carried
`Authorization` **when the response says `public`** — so any CDN or caching
proxy in front of the deployment was licensed to hand vault content to the
next caller without a token.

**Fix**: `private, max-age=31536000, immutable` (the browser cache keeps the
benefit; shared caches must not store it), plus `x-content-type-options:
nosniff` since vault content is arbitrary user data.

---

## Medium (fixed)

### M1. The server believed the client about file size
`lib/store-pg.js` / `lib/store-memory.js` — `commit`

`changes[].size` is chosen by the client (bounded only by
`SYNC_MAX_BLOB_BYTES`) and was written straight into `files.size`, i.e. into
every other device's manifest. Probe: a 4-byte blob recorded as 67,108,864
bytes.

**Impact**: clients cache hashes by `mtime + size`; a wrong size can make a
device skip re-hashing a file that really changed (silent divergence), and
misreports vault size. **Fix**: sizes come from the `blobs` row.

### M2. A blob could disappear between the commit pre-check and the write
`api/sync/v1/commit.js` + stores

The route verified blob presence, then called `commit()` in a separate
transaction. The blob GC (unreferenced content older than 1 h) could delete
the blob in between, leaving a `files` row pointing at content that no longer
exists — a path that 404s on every later pull and that no client can repair.
**Fix**: `commit(..., { checkBlobs: true })` re-verifies inside the
transaction and answers `422 {hashes}` so the client re-uploads.

### M3. Rate limiting keyed on a client-controlled value
`api/sync/v1/vaults/[name].js`, `api/proxy-request.js`

Both limiters read `x-forwarded-for.split(',')[0]` — the *left-most* entry,
which is whatever the caller typed. Sending a random `X-Forwarded-For` per
request gave every request a fresh bucket, defeating the limit. **Fix**:
shared `lib/client-ip.js` — platform headers first (`x-vercel-forwarded-for`,
`x-real-ip`), and only then the *last* forwarded hop (the one our edge
appended), never the first.

### M4. The vault password was written to `data.json` in plaintext
`src/neon-sync-plugin/main.js`

`data.json` lives in `<vault>/.obsidian/plugins/markport-neon-sync/`, i.e.
inside the vault. Vaults get copied: cloud backups, iCloud/Syncthing, other
sync tools — and the web build's own sync pushes dot-paths, so the file (and
the password in it) could reach the sync server itself. **Fix**: new
`Remember password` setting, **off by default**. The password stays in memory
for the session; the stored `token` (expiring, single-vault) keeps sync
working across restarts. A password already on disk keeps working for that
session and is removed from disk on the next save. Opt in for unattended
refresh.

---

## Low (fixed)

- **L1. `/changes`, `/deletions`, `/live` answered without authentication**
  (they are 501 stubs, so nothing leaked but the endpoint list). All three now
  call `requireAuth` first, like every implemented route.
- **L2. `SYNC_STORE=memory` on a deployment silently loses data.** `getStore()`
  now refuses with `503` when `VERCEL` is set, unless
  `SYNC_ALLOW_MEMORY_STORE=1` (explicit override for `vercel dev`).

---

## Verified as already sound (no change)

| Area | Evidence |
|---|---|
| **SQL injection** | Every statement is parameterized; the one bulk insert uses `jsonb_to_recordset($2::jsonb)` with `JSON.stringify`; no user input is ever concatenated into SQL. Vault ids and paths are regex-validated *before* any query, and are parameters even then. |
| **Path traversal (serverless)** | `lib/validate.js` rejects `..`, `.`, absolute paths, backslashes, empty segments, control chars, and enforces `MAX_PATH_LENGTH`. Blobs are addressed only by a 64-char lowercase hex sha-256 — never by path. |
| **Path traversal (fs server)** | `src/sync-server/resolve-safe.js` re-checks every index entry against `VAULT_PATH` before `sendFile`; covered by its own tests. |
| **Auth** | Constant-time comparison on sha-256 digests (no length leak); fail-closed `503` when `SYNC_TOKEN` is unset; `401` bodies are empty; Bearer scheme only (token in query/cookie rejected). |
| **Token validation** | `mpv1.<name>.<exp>.<hmac>` — HMAC-SHA256 over the payload, `timingSafeEqual`, expiry checked, name re-validated against the vault-name regex after decoding. Forgery without the key is not feasible. |
| **Cross-vault scope** | `getVaultOrThrow` compares the token scope with `?vault=` on every endpoint (tests cover manifest, commit, blob, blobs/missing, and the default-vault case). |
| **Password storage** | scrypt with a per-vault 16-byte salt, `timingSafeEqual` verification, 8–1024 char bounds; the password is never stored in clear, never logged, never echoed in a response. |
| **CSRF / CORS** | Credentials are `Authorization` headers only (no cookies), and no CORS response headers are sent, so another origin cannot read responses. |
| **SSRF (proxy)** | Host allowlist, redirect target re-validated, framing/hop-by-hop headers stripped, `Authorization`/`Cookie` dropped on cross-host redirects. |
| **Error hygiene** | Handlers return `{error}` with no stack traces or filesystem paths; `console.error` logs method + URL (the token is a header, never in the URL). |

---

## Residual risks (deliberately not changed)

These are design consequences, not bugs; each is a decision to make rather
than a line to patch.

1. **Blobs are global and content-addressed.** A token scoped to vault A can
   `GET /sync/v1/blob/<hash>` for content belonging to vault B if it knows the
   hash, and `POST /blobs/missing` confirms whether a hash exists anywhere.
   Cross-vault *dedupe* is the design (one row per identical file). Fixing it
   means per-vault blob rows — real storage cost, no protocol change.
2. **Tokens cannot be revoked and live 90 days.** No `jti`/revocation table,
   and no rotation on password change (there is no reset path at all). A
   leaked token is valid for its full TTL — acceptable at 90 days? Consider
   shortening, or a `token_version` column bumped on password change.
3. **`SYNC_TOKEN` is both the operator key and the token HMAC key.** Leaking
   it means every vault, and rotating it invalidates every issued token.
   A separate `SYNC_TOKEN_HMAC_KEY` would decouple the two.
4. **Brute force is only IP-limited, per instance.** Vercel functions share no
   memory, so the limiter is a damper, not a quota; the real cost is scrypt
   (N=16384 ≈ tens of ms and 16 MB per attempt). A durable counter in
   `vault_claims` (with exponential backoff rather than hard lockout) is the
   next step if a vault name becomes public.
5. **Dot-paths are accepted by the server.** The plugin skips them when
   scanning; the browser client does not, so `.obsidian/**` can be synced.
   That is how plugin config travels between devices — but it also means
   synced vaults can plant plugin files, and it is what made M4 exploitable.
   An explicit allow/deny list is worth a product decision.
6. **`SYNC_PG_SSL_NO_VERIFY=1`** disables certificate verification (escape
   hatch for TLS-intercepting proxies). Keep it unset in production.
7. **`GET /sync/v1/vaults/<name>` reports whether a name is claimed** — by
   design (the gate needs it before a password exists), but it is an
   enumeration oracle for names.
8. **No per-request rate limit on `commit`/`blob PUT`.** A stolen token can
   grow a vault (3000 paths/commit) and store up to `SYNC_MAX_BLOB_BYTES` per
   blob until quota; unreferenced blobs are reclaimed after one hour.

## Next steps, in priority order

1. Run the new migration-free guards against the **real** Neon database
   (the pg store's tests skip without `DATABASE_URL`).
2. Claim a password for every vault the operator addresses by name (C1 makes
   this safe, but claiming first is still the right habit).
3. Durable rate limiting for claim/unlock (residual 4) — the only remaining
   unbounded guessing channel.
4. Decide the dot-path policy (residual 5), then either allow-list
   `.obsidian/plugins/<id>/{main.js,manifest.json,styles.css}` or exclude
   `.obsidian` entirely in both clients.
5. Rotate `SYNC_TOKEN` and consider splitting the HMAC key (residual 3).
