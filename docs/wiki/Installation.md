# Installation

There are two things you can install: **Oryn itself** (the web app) and the
**sync plugin** (optional, inside Obsidian). This page covers the first;
[Plugins](Plugins) covers the second.

The full reference is
[docs/install.md](https://github.com/Panagiotissarr/oryn/blob/main/docs/install.md)
— this page is the short version and the decisions behind it.

## Fastest look: the Node server

```bash
git clone https://github.com/Panagiotissarr/oryn
cd oryn/src/runtime-server/server
npm install
npm start
```

Then open the URL it prints. You get a vault backed by a directory on disk —
the only deployment shape where your notes are plain files you can open with
any editor.

> **The Node server has no authentication.** It's a local tool. Put it behind a
> reverse proxy or a tunnel, never directly on the internet. This is not a
> hardening gap to be fixed later; it's the design.

## Static, no server at all

Build the static client and drop it on any host:

```bash
cd src/deployments/cloudflare   # or use the Vercel build output
npm install
npm run build
```

The result is a folder of static files. Vaults live in the browser's OPFS
storage. There is no backend, so there is nothing to sync against unless you
add one of the sync deployments.

## Vercel, with optional sync

See [Self-Hosting → Vercel](Self-Hosting#vercel). Short version: the build
cannot run on Vercel's builders (no `vendor/`), so GitHub Actions builds and
`vercel deploy` ships the result.

## What you need either way

- A browser with **OPFS** support (current Chrome, Edge, Firefox, Safari) for
  the client-only shapes.
- **Node ≥ 18** to build or to run the Node server.
- Nothing else. No account, no key, no container.

## Choosing

| You want | Pick |
|---|---|
| To read your notes on a phone | any static host |
| Your notes as files on disk | Node server |
| Two devices in sync, free tier | Vercel + the sync plugin |
| No third-party hosting at all | Cloudflare or Node on your own box |
