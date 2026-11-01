# Oryn

**Obsidian in your browser, with syncing.**

Oryn runs Obsidian's own renderer in a standard browser tab — no Electron, no native app, no
install. Your notes live in the browser (or in a folder you pick), and with the optional sync
backend they follow you between desktop, mobile, and a real Obsidian vault.

> **Name history.** This project started as `obsidian-web`, became `Markport`, was briefly
> published as `Noto`, and is now **Oryn**. Only display strings changed along the way: internal
> identifiers deliberately keep their original spelling — storage keys, plugin ids, the wire
> protocol and database tables are unchanged — so existing vaults, settings and installed plugins
> keep working exactly as they did. See [Compatibility](#compatibility).
>
> **Independent project.** Oryn is unaffiliated with any other product, company or AI project
> that happens to use the same or a similar name.

[View the wiki](https://github.com/Panagiotissarr/oryn/wiki)

**Not a hosted service.** There is no sign-up and nothing to join: you run your own copy. Hosting
Oryn for the public means serving Obsidian's own application code to strangers, which is
Obsidian's call to make — so this repository doesn't ship their bundle either. The setup scripts
download it from Obsidian straight onto your machine.

---

## Supported Obsidian version

**Obsidian 1.12.7 — pass it explicitly.** Obsidian 1.13 added a startup check that Oryn
deliberately does not satisfy, so 1.13+ will not load; you get an explanatory screen instead of
the app. This is a decision, not an outstanding bug:

```bash
node scripts/update-obsidian-mobile.js --version 1.12.7
```

The updater defaults to the latest release, which **will not boot**. The full explanation and
measurements are in [`docs/obsidian-version-support.md`](docs/obsidian-version-support.md).

---

## Quick start

You need **Node 18+** (or Bun for two of the packages) and a copy of Obsidian's renderer. Every
option below starts with the same two steps:

```bash
git clone https://github.com/Panagiotissarr/oryn
cd oryn
node scripts/update-obsidian-mobile.js --version 1.12.7 && node scripts/patch-obsidian-mobile.js
```

That downloads Obsidian's official Android APK and unpacks its `assets/public/` tree into
`vendor/obsidian-mobile/` (gitignored). Nothing is modified — the extracted bundle is
byte-for-byte identical to Obsidian's own — and the download goes from Obsidian to your machine,
never through this repository. The patch step exists as infrastructure for a future Obsidian
version; today its patch list is empty.

### 1. Node server (fastest way to try it)

Vaults are real files on disk, served over `/api/fs`, with live updates over WebSocket.

```bash
cd src/runtime-server/server
npm install
npm run dev          # or: npm start
```

Open `http://127.0.0.1:3000`. Set `VAULT_PATH` to point it at an existing vault.

### 2. Static, client-only (no server, no storage anywhere)

Vaults live in the browser via [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
with no server-side storage of any kind.

```bash
cd src/deployments/cloudflare
npm install
npm run build        # builds into .tmp/deployments/cloudflare/public
npm run dev          # local emulation — publishes nothing
npm run deploy       # publish, needs CF_PAGES_PROJECT in your environment
```

### 3. Vercel, client-only **plus sync**

The same browser app, with `/sync/v1` as serverless functions and Neon Postgres holding the
shared sync state — so several devices push to and pull from one vault.

```bash
cd src/deployments/vercel
npm install
npm run build
npm run migrate      # create the schema in your Neon database
npm run dev          # local server with real handlers + a printed dev token
```

Two environment variables are required:

| Variable | Purpose |
|---|---|
| `SYNC_TOKEN` | operator token; **unset means every sync request answers 503** (fail-closed on purpose) |
| `DATABASE_URL` | pooled Neon connection string |

Builds are local-only because `vendor/` is never uploaded, so the Vercel project's **Build
Command must stay empty** — `vercel deploy --prod` ships the prebuilt `public/` as-is. The
GitHub Actions workflow does that build and deploy for `main`; see
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

---

## What works

- Full Markdown editing and preview (CodeMirror + Obsidian's renderer)
- File tree, tabs, split panes, graph view, backlinks, search, command palette
- Core plugins: file explorer, tags, bookmarks, outgoing links, and the rest
- RTL and Unicode
- **Automatic sync** on the Vercel deployment: a startup sync runs before Obsidian loads (pulled
  notes appear immediately, no reload), edits auto-push about 20 s after you stop typing, every
  request retries with backoff on flaky networks and cold functions, and pulls download four
  blobs in parallel. Manual **Pull** / **Push** stay as a fallback.
- Real-time updates across tabs via WebSocket — **Node server mode only** (`/api/watch`). The
  client-only deployments have no server to push events from.

**Browser support.** OPFS needs a secure context (`https://` or `localhost`); over plain HTTP on a
bare IP `navigator.storage.getDirectory` is `undefined` and vault creation fails silently. Folder
vaults (`showDirectoryPicker`) are Chromium-only; Firefox and Safari fall back to OPFS.

---

## Sync between devices

Vaults are addressed by **name + password**, not by a token you copy around: open `/vault/<name>`
(or just `/<name>` — short links redirect) and type the password. The first password **claims**
an unclaimed name; later ones must match. A successful unlock stores an `mpv1.*` vault-scoped
token (90 days) in **sessionStorage**, so closing the tab forgets it and the next visit asks
again. Unlock then runs a startup sync before Obsidian loads.

**A real Obsidian vault can join the same server.** [`src/neon-sync-plugin/`](src/neon-sync-plugin)
is a single-file Obsidian plugin (desktop **and** mobile) speaking the same `/sync/v1` protocol:
paste your claimed `/vault/<name>` URL, press **Connect**, done. Install it by copying
`main.js` + `manifest.json` into `<vault>/.obsidian/plugins/markport-neon-sync/` or use the
committed zip at `src/neon-sync-plugin/release/`. Releases are tagged `neon-sync-v*`.

**Conflict rule:** the server wins at the original path; the losing side is preserved as
`name.conflict-YYYYMMDDHHMMSS.ext` and pushed as a new file next sync. Nothing is ever silently
overwritten. Full setup, claim flow, Vercel's 4.5 MB chunking and the conflict rules:
[`src/deployments/vercel/README.md`](src/deployments/vercel/README.md).

---

## Architecture

Oryn loads Obsidian's original renderer (`app.js`) **unmodified** — byte-for-byte identical to
Obsidian's own Android bundle, zero build-time patches. Instead of forking Obsidian, it replaces
the Capacitor / Node.js / Electron APIs the bundle expects with lightweight browser shims, and
adjusts platform behaviour (mobile vs. desktop layout) at runtime by intercepting
`Object.defineProperty` in `client-mobile/platform-bridge.js`.

```
Browser
  ├─ vault storage: OPFS or a folder you picked (never leaves the device)
  └─ HTTP ─┬─ /api/fs, /api/bootstrap, /api/watch   → Node server (real filesystem)
           ├─ /sync/v1/*                           → sync backend (Vercel + Neon)
           └─ static assets                        → CDN (Cloudflare / Vercel)
```

Design principles, the shim layer and the sync protocol are documented in
[`docs/architecture.md`](docs/architecture.md).

---

## Repo layout

```
src/
├── client-mobile/          the runtime, served at / (also /mobile)
│   ├── sync/               /sync/v1 client: plan, pull, push, conflicts
│   └── shims/              browser replacements for Capacitor/Electron/Node APIs
├── runtime-server/server/  Node.js HTTP/WS backend (real filesystem)
├── sync-server/            optional pull-only sync server — reference implementation of
│                           /sync/v1; you run it yourself (bun)
├── neon-sync-plugin/       Obsidian plugin (desktop + mobile) for the same protocol
├── plugins/                system plugin overlay (layout switcher)
└── deployments/
    ├── cloudflare/         static, client-only (OPFS) + a small edge Worker
    └── vercel/             same app + /sync/v1 serverless functions on Neon Postgres

site/                       the documentation site (Astro)
docs/                       architecture, install, Obsidian version notes (EN + HE)
docs/wiki/                  source for the GitHub wiki — edit here, then
                            scripts/publish-wiki.sh mirrors it out
scripts/                    updater / patcher for Obsidian's bundle
vendor/                     extracted Obsidian bundles — gitignored, downloaded locally
user-data/                  shipped demo vault + runtime vault registry
```

---

## Configuration

Node server environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address |
| `VAULT_PATH` | `user-data/demo-vault` | Vault directory to serve |
| `VAULT_REGISTRY` | `user-data/registry.json` | Recent-vaults registry |

Bootstrap preloading is tunable via `BOOTSTRAP_DISABLED`, `BOOTSTRAP_MAX_FILE_KB` and
`BOOTSTRAP_MAX_TOTAL_MB` (read in `src/runtime-server/server/config.js`). Sync deployments use
`SYNC_TOKEN` and `DATABASE_URL` as above.

---

## Tests

```bash
cd src/client-mobile                 && npm test   # node --test
cd src/runtime-server/server         && npm test   # node --test
cd src/deployments/vercel            && npm test   # node --test: protocol, stores, proxy, security
cd src/neon-sync-plugin              && node --test "test/*.test.js"   # plugin: plan, url, http, settings, web vault
cd src/deployments/cloudflare        && npm test   # bun test
cd src/sync-server                   && npm test   # bun test
```

The Vercel suite includes 19 security regression tests covering the claim gate, upload bounds,
cache/authz hardening and the memory-store guard; nine Postgres-backed cases skip unless
`DATABASE_URL` is set.

---

## Security

The sync backend's threat model, severity table, fixes and residual risks are written up in
[`src/deployments/vercel/SECURITY.md`](src/deployments/vercel/SECURITY.md). In short: the claim
flow refuses to attach a password to a vault that already holds content (409 unless you present
the operator token), uploads are bounded per part and cumulatively, blob size is measured rather
than trusted, commits fail closed with 422 when a blob is missing, and `SYNC_STORE=memory` on a
deployment is refused.

Point not to miss when self-hosting: **the Node server has no authentication.** Put it behind a
reverse proxy or tunnel; never expose it directly to the internet.

### Privacy and page-view analytics

Vault content stays where it already was: browser or folder storage on the Node server, OPFS in
the client-only deployments. The Vercel deployment also loads
[Vercel Web Analytics](https://vercel.com/docs/analytics) — a cookieless page-view counter served
from your own domain (`/_vercel/insights/script.js`), loaded by `boot.js` once the vault route is
settled. It sees the URL you visited, not your notes: no vault content, no file names, no
passwords, and nothing is sent anywhere in the Cloudflare or Node builds, which have no such
endpoint.

Building locally? `OW_ANALYTICS=off npm run build` in `src/deployments/vercel` leaves the tag out.

---

## Compatibility

Renaming the project changed nothing that existing installations depend on:

| Kept as-is | Why |
|---|---|
| Plugin id `markport-neon-sync`, folder `<vault>/.obsidian/plugins/markport-neon-sync/` | Renaming it would orphan every installed plugin and its `data.json` (server URL, token) |
| Plugin id `obsidian-web-layout` | Referenced by the build profiles and seeded system plugins |
| `ow-*` localStorage / sessionStorage keys | Otherwise every returning user is logged out and loses vault registration |
| `window.__owConfig`, `window.__owPlatform`, `data-ow-injected` | Documented feature-detection API for system plugins |
| `/sync/v1/*` routes and the `mpv1` token format | Wire protocol shared by the browser client, the plugin and the reference server |
| Database tables (`blobs`, `blob_parts`, `files`, `vault_meta`, `vault_claims`) | Live data; renaming them would be a migration for zero benefit |

Only display strings changed: app title, PWA manifest name, starter-screen wordmark, settings
panes, demo content and the plugin's visible name.

---

## Disclaimer

Oryn is an **independent educational proof-of-concept** exploring how Electron-based apps can run
in a standard browser. It is **not affiliated with, endorsed by, or associated with**
[Obsidian](https://obsidian.md) or Dynalist Inc., nor with any other project or company using the
name Oryn or a similar name.

This repository does **not** include or redistribute Obsidian's source code. The `vendor/`
directories are gitignored; the setup scripts download Obsidian's renderer to **your** machine at
install time. Obsidian's code remains the property of Dynalist Inc. under their
[Terms of Service](https://obsidian.md/terms).

If the Obsidian team has concerns about this project, please
[open an issue](https://github.com/Panagiotissarr/oryn/issues) and it will be addressed promptly.

---

## License

[GNU General Public License v3.0](LICENSE) — `GPL-3.0-only`.

This covers **Oryn's own code only**: everything under `src/` and `scripts/`. You may use, study,
modify and redistribute it; a modified version you distribute must also be GPL-3.0 and its source
must be available.

It does **not** cover Obsidian itself. `vendor/` holds Obsidian's proprietary bundle, is
gitignored, and remains governed solely by Dynalist Inc.'s Terms of Service — nothing here grants
any rights over Obsidian's code.

## Credits

Built by [MusiCode1](https://github.com/MusiCode1) with
[Claude Code](https://claude.ai/code) — the original `obsidian-web` / Markport codebase, of which
this is a renamed and extended continuation.
