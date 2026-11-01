# Oryn

**Obsidian in your browser, with syncing.**

Oryn runs Obsidian's own mobile bundle as a web app. Your vault stays where it
already is — a folder, browser storage, or OPFS — and sync is optional.

This wiki is the *operator's* view: how to put it somewhere, how to keep it
running, and what to check when it isn't. The authoritative reference for what
Oryn is and how it's built lives in the repository, and is linked from every
page here rather than copied into it.

## Start here

| If you want to… | Read |
|---|---|
| Just open it and poke around | [Installation](Installation) |
| Run it on your own server | [Installation](Installation) → Node server |
| Host it for other people | [Self-Hosting](Self-Hosting) |
| Sync a vault between devices | [Sync](Sync) |
| Install the sync plugin | [Plugins](Plugins) |
| Something is broken | [Troubleshooting](Troubleshooting) |

## The four deployment shapes

| Shape | Storage | Sync | Needs |
|---|---|---|---|
| Static, client-only | OPFS in the browser | no | any static host |
| Cloudflare (Worker + assets) | OPFS | optional | a Cloudflare account |
| Vercel | OPFS | optional (Neon Postgres) | a Vercel account |
| Node server | real files on disk | optional | Node ≥ 18 |

None of them store vault content on a server except the Node server, where the
files are *your* files in *your* directory.

## Two facts that save time

**Obsidian is pinned to 1.12.7.** 1.13+ does not boot as a web app. This is
deliberate and measured, not an oversight — reasoning in
[obsidian-version-support.md](https://github.com/Panagiotissarr/oryn/blob/main/docs/obsidian-version-support.md).

**`vendor/` is not in the repository.** It's Obsidian's own bundle, downloaded
at build time and gitignored. That single fact is why the deploy pipeline looks
the way it does in [Self-Hosting](Self-Hosting).

## Elsewhere

- [README](https://github.com/Panagiotissarr/oryn#readme) — what it is, features, compatibility
- [docs/install.md](https://github.com/Panagiotissarr/oryn/blob/main/docs/install.md) — installation detail
- [docs/architecture.md](https://github.com/Panagiotissarr/oryn/blob/main/docs/architecture.md) — runtime layers
- [SECURITY.md](https://github.com/Panagiotissarr/oryn/blob/main/src/deployments/vercel/SECURITY.md) — sync threat model
- [Releases](https://github.com/Panagiotissarr/oryn/releases) — plugin zips
