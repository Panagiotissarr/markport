# Markport Neon Sync (Obsidian plugin)

Bidirectional sync between **any Obsidian vault** (desktop or mobile) and a
Markport `/sync/v1` backend — the Vercel + Neon deployment (e.g.
`https://notes.sarris.dev`). Same protocol, same decision rules as the
browser client (`src/client-mobile/sync/`), so a browser vault and an
Obsidian vault can share one server-side vault and all sync through the
same CAS/conflict semantics.

- **One file.** `main.js` + `manifest.json` — no build step, no bundler.
- **Paste your claimed URL.** One settings field takes the link you use in the
  browser — `https://app/vault/<name>`, the short `https://app/<name>`, or a
  note deep link — and fills in **Server URL** + **Vault name** automatically
  (same parsing rules as the web app's starter screen).
- **Mobile-safe.** Only `require('obsidian')`, `app.requestUrl`, WebCrypto and
  Vault adapter APIs. No Node `fs`/`crypto`, no Electron.
- **Pull → conflict → push**, exactly like `run-sync.js`: server wins at the
  original path, the losing side is preserved as
  `name.conflict-YYYYMMDDHHMMSS.ext` and pushed as a new file next sync. A
  **Pull only** mode (command or settings button) downloads without touching
  the server.
- **Flaky-network safe.** Every request retries transient failures (transport
  errors, 429/5xx) up to 3× with exponential backoff + jitter — the same
  hardening as the browser client. Retries are safe: blobs are
  content-addressed (idempotent) and commits are CAS-guarded.
- **Web-app aware.** In the browser build a note can land in OPFS ahead of
  Obsidian's file index (the app's own sync writes behind the adapter).
  Since v0.2.2 that collision is handled — bytes go through the storage
  adapter, the notice asks for a **page reload**, and a stale index can
  never turn into a deletion pushed to the server.
- **The sync host must run the APP, not the dev server.** `sync.notes.sarris.dev`
  and `notes.sarris.dev` both need the Vercel project whose root directory is
  `src/deployments/vercel` (app + `/api/sync/v1/*`). A project rooted at
  `src/sync-server` deploys a `bun index.js` filesystem server and answers
  every request with 500.

## Install

### Download

Everything needed lives in this directory — `main.js` + `manifest.json` —
plus a ready-to-extract
[release/markport-neon-sync-0.2.4.zip](release/markport-neon-sync-0.2.4.zip)
committed alongside (rebuild any time with
`zip -j release/markport-neon-sync-0.2.4.zip main.js manifest.json README.md`).
On GitHub, open a file and use **Download raw file**; the `neon-sync-v*`
releases carry each version's changelog. If a release also has the loose
`main.js` / `manifest.json` attached as assets (`gh release upload
neon-sync-v0.2.4 src/neon-sync-plugin/main.js src/neon-sync-plugin/manifest.json`
from your own machine — the build sandbox can't reach GitHub's upload
endpoint), the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin can
install and update straight from it (*Add beta plugin* →
`Panagiotissarr/obby-v2`) — the easiest route on **mobile**.

### Desktop

1. Create the plugin folder in your vault:
   `<vault>/.obsidian/plugins/markport-neon-sync/`
2. Put `main.js` and `manifest.json` into it (extract the zip from
   `release/`, download the raw files from GitHub, or copy them from this
   directory after a checkout).
3. Obsidian → Settings → Community plugins → enable **Markport Neon Sync**.
   ("Restricted mode" must be off.)

### Mobile

1. Get the same two files into `<vault>/.obsidian/plugins/markport-neon-sync/`
   — via **BRAT** (needs the release assets attached — see above), a
   cloud-synced vault, cable copy, or the files app
   (Android; on iOS the vault must live in the Files app, e.g. "On My
   iPhone"), **or** install once on desktop and sync the vault over first.
2. Open Obsidian → Settings → Community plugins → enable **Markport Neon
   Sync**. `manifest.json` declares `isDesktopOnly: false`, so it loads on
   Android/iOS too.

## Settings

| Setting | Meaning |
|---|---|
| **Vault URL** | Paste your claimed link — `https://app/vault/<name>`, the short `https://app/<name>`, a note deep link, or a bare `<name>` — and **Server URL** + **Vault name** fill in automatically (a bare/relative name fills only the vault name). Scheme-less hosts are assumed `https://`, except local/dev hosts (`localhost`, `127.*`, `192.168.*`, `10.*`, `172.16–31.*`, `*.local`) which are assumed `http://` — dev servers don't speak TLS |
| **Server URL** | Origin of the deployment, e.g. `https://notes.sarris.dev` (no trailing path) |
| **Vault name** | The vault id on the server — the same name used in `/vault/<name>` links (`a-z 0-9 . _ -`, ≤ 64 chars) |
| **Password** | Claim/unlock password for that vault. Stored in the plugin's `data.json` so the token can refresh itself |
| **Token** | Advanced: paste a bearer token directly (an `mpv1.*` vault token or the operator's `SYNC_TOKEN`). **Connect** overwrites it |
| **Status** | Live state line: the configured vault/server + what to do next ("no token — press Connect") |
| **Connect / Check / Sync now / Pull only** | One settings row per action, each with a single button (a shared row of buttons can clip off-screen on mobile): **Connect** exchanges the password for a fresh token (claims the vault if unclaimed), **Check** reads `GET /sync/v1/vaults/<name>`, **Sync now** runs one bidirectional sync, **Pull** is download-only. All three main actions are also in the command palette: *Connect / unlock vault*, *Sync now*, *Pull only* |
| **Auto-sync interval** | Minutes between automatic syncs; `0` = manual only (command palette `Sync now` / `Pull only`, ribbon icon, or the settings buttons) |

### First run

1. Paste your **claimed URL** into *Vault URL* (or fill **Server URL** +
   **Vault name** manually), enter the **Password**, press **Connect**.
   - If the vault name is *unclaimed*, your password **claims** it (first one
     wins; pick something ≥ 8 characters).
   - If it's already claimed, the password must *match* — otherwise 401.
2. Press **Sync now**. New files go up, new files come down; later syncs only
   transfer what changed (mtime + size cache, then sha-256). **Pull** (or the
   `Pull only` command) downloads server changes without pushing anything.

The same claim/unlock endpoint backs the browser's `/vault/<name>` password
gate — a password set in Obsidian unlocks the same vault in the browser and
vice versa.

## How it talks to the server

```
POST /sync/v1/vaults/<name>   {password} → 200/201 {token}   (claim / unlock)
GET  /sync/v1/manifest        paginated listing (all pages or fail)
GET  /sync/v1/blob/<hash>     download (auto-ranges on 413)
POST /sync/v1/blobs/missing   which blobs the server lacks
PUT  /sync/v1/blob/<hash>     chunked upload (2 MB pieces, base64)
POST /sync/v1/commit          {changes, deletions} with baseHash CAS
```

- The exchanged token is an `mpv1.<name>.<expMs>.<sig>` vault token: valid
  **90 days**, usable **only** for that vault (403 on any other). The plugin
  reuses it until it's within 60 s of expiry, then silently re-unlocks with
  the stored password. If the server ever answers 401 on a stored token, it's
  discarded and re-obtained next sync.
- A manually pasted token works too: an `mpv1.*` token, or the operator's
  global `SYNC_TOKEN` (all vaults, no expiry — treat it like a root key).
- Every request goes through a retry wrapper: transient failures (transport
  errors, 429/5xx) are retried up to 3× with exponential backoff + jitter
  (400 ms → 800 ms). Safe by construction: blob GET/PUT are
  content-addressed (idempotent) and commits are CAS-guarded (a re-run after
  an applied-but-lost response just 409s into the normal conflict path).
- `planSync` in `main.js` is a **verbatim copy** of
  `src/client-mobile/sync/plan-sync.js`; `test/plan.test.js` runs the same
  decision-table vectors as the browser suite so the two can't drift.

## Conflicts

Hash-based optimistic concurrency — every push carries `baseHash` (what this
vault last synced for the path). The server applies a change only if nothing
moved under it; otherwise it reports its state and **nothing is overwritten**.
Both clients then follow one rule:

> Server wins at the original path; the local divergent content is preserved
> as `name.conflict-YYYYMMDDHHMMSS.ext` (or `-2`, `-3`, … if that name is
> taken) and pushed as a new file on the same sync's second push round.

Delete-vs-edit resolves the same way: the edit survives; a deletion of a file
the server still has unchanged is simply re-downloaded.

## Notes & limits

- Files under `.obsidian/`, `.trash/` and any dot-folder/dot-file are never
  synced (same filter as the browser client).
- Rate limit: the claim/unlock endpoint allows **10 attempts per minute per
  IP** (429 after that — the plugin reports it as "wait a minute").
- Server-side limits apply: 64 MiB per file (configurable), 1000 ops per
  commit batch (batches are automatic), 4.5 MB request bodies (chunked
  around).
- Against an older **pull-only** server (`src/sync-server/`), push endpoints
  answer `501`; the run finishes as a pull-only sync
  (`(server is pull-only)` in the notice) instead of failing.
- Conflict summary: after each sync a notice shows `↓ downloaded ↑ pushed
  deletions N · conflicts M`.

## Troubleshooting

- **"Press Connect" but no button / no plugin settings** — the two files must
  sit directly in `<vault>/.obsidian/plugins/<folder>/` (extracting the zip at
  the vault root installs nothing — a giveaway is `README.md` showing up as a
  note in your vault). Restricted mode must be off and the plugin toggled on
  under Community plugins; its settings page is at the very bottom of the
  Settings sidebar (or the gear icon next to the plugin). Since v0.2.1 every
  action has its **own settings row** (four buttons sharing one row could
  clip off-screen, especially on mobile) and Connect/Sync/Pull are also in
  the **command palette**.
- **`ERR_SSL_VERSION_OR_CIPHER_MISMATCH` (or another SSL/cert error)** — the
  plugin attempted an HTTPS handshake against a plain-HTTP server. The local
  dev servers (runtime-server, `npm run dev`) listen on
  `http://localhost:3000`: use `http://`. Since v0.2.1 local hosts
  (`localhost`, `127.*`, `192.168.*`, `10.*`, `172.16–31.*`, `*.local`) are
  assumed `http://` automatically — but an explicit `https://` in Server URL
  / data.json always wins, so fix it there. (Against a real deployment like
  `https://<app>.vercel.app` this error instead means the hostname doesn't
  serve TLS — check it for typos.)
- **`Error: File already exists.` (or the settings page half-empty, with
  `t.setInputType is not a function` in the console)** — both are fixed in
  v0.2.2; upgrade. The first came from the **web app build**: its own sync
  writes into OPFS *behind* Obsidian's file index, so a note can exist on
  disk while the plugin's existence check still says "absent" — the
  exclusive create then threw and aborted the whole sync. v0.2.2 catches
  that, overwrites through the storage adapter and tells you to **reload the
  page** (the notice ends with `reload the page to see N file(s)`); synced
  state for those files is deliberately not recorded, so they are re-pulled
  (idempotently) until the index catches up — and a stale index can never
  turn into a *deletion pushed to the server*. The second was an older
  mobile bundle without `setInputType` on the password field: the call threw
  and the settings tab stopped rendering below the Password row.
- **`SyntaxError: Unexpected token '/', "/* …" is not valid JSON` at
  `httpOnce` / `blob`** — fixed in v0.2.3. Obsidian's response object
  exposes `json` as a **getter that throws** on any non-JSON body, and a
  blob GET returns raw note bytes (a CSS snippet starts with `/* */`), so
  every pull died on the first non-JSON note. The plugin now reads
  `text` / `json` / `arrayBuffer` defensively — a body-format mismatch can
  never abort a sync again.
- **`manifest: HTTP 500 … the deployment crashed before answering`** — the
  host answers, but the deployed code cannot serve `/sync/v1/*`. Typically
  the Vercel project deploys a **server that isn't this protocol** (e.g.
  the filesystem `src/sync-server`, which only works when you run
  `bun index.js` yourself with `VAULT_PATH` + `SYNC_TOKEN` and a writable
  disk — none of which exist in a serverless function). Point the plugin at
  the deployment that actually runs the app + API (for this repo:
  `https://notes.sarris.dev`). Since v0.2.3 the error also prints the
  response body's first 140 chars, which is what identifies this.
- **Where is my password stored?** — In memory, for the session, by default.
  `data.json` only gets it if you turn on **Remember password**; without that,
  the file holds the vault token (which expires and only opens this one vault)
  plus sync state. `data.json` sits inside the vault, and vaults get copied —
  cloud backups, other sync tools, and the web build's own sync — so a
  plaintext password there travels with them. A password written by an older
  version keeps working for the current session and is removed from disk on
  the next save. To claim a vault that already has content, enter its
  password or paste the operator `SYNC_TOKEN` into **Token** (the server
  answers `409` otherwise).
- **Hand-edited `data.json`** — lives at
  `<vault>/.obsidian/plugins/markport-neon-sync/data.json`; shape:
  `{"baseUrl":"http://localhost:3000","vault":"myvault","password":"…","token":"","intervalMinutes":0,"synced":{},"mirror":{}}`.
  Settings load at plugin startup: reload Obsidian (or toggle the plugin
  off/on) after editing. Since v0.2.1 a missing scheme or trailing slashes in
  `baseUrl` normalize on load instead of failing deep inside the request.

## Tests

```bash
cd src/neon-sync-plugin
node --test "test/*.test.js"     # 62 tests: decision table + helpers + URL parsing + settings render + web-vault writes + HTTP transport + credential-at-rest
```

The pure functions are attached to the exported class as statics so they run
under plain Node — `require('obsidian')` is guarded and falls back to stubs
outside Obsidian. `test/settings.test.js` goes further: it hooks
`Module._load` with faithful Obsidian API stubs and actually renders the
settings tab, so a missing/clipped button fails the suite.
`test/web-vault.test.js` models the web build's split between the Obsidian
index and the bytes on disk (OPFS) and pins the 0.2.2 behaviour: index-blind
collisions go through the adapter instead of throwing, they never record
`synced` state (no phantom deletions), and a file still present on disk is
never deleted on the server.
