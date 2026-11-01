# Self-Hosting

Three shapes, one codebase. What differs is who serves the files and where the
vault lives.

## The one rule that explains the Vercel pipeline

`vendor/obsidian-mobile/` is Obsidian's own bundle. It is **gitignored** and
licensed separately — it cannot go into the repository. Every consequence below
follows from that:

- The build needs the bundle, so it downloads it at build time.
- Vercel's builders don't have it, so the build **cannot run on Vercel**.
- Therefore `.github/workflows/deploy.yml` builds on a GitHub runner and ships
  the finished artifact with `vercel deploy --prod`.

**Do not connect this repository to Vercel's Git integration.** A Git-connected
project builds on Vercel with no `vendor/` and deploys an empty site. The
project's Build Command must stay **empty** — that is required, not incidental.

```
push to main
   └─ GitHub Actions
        ├─ download Obsidian bundle (pinned version)
        ├─ npm ci && npm test
        ├─ npm run build           → public/
        ├─ verify the artifact     (fails the job rather than shipping nothing)
        └─ vercel deploy --prod    → uploads public/ as-is
```

## Vercel

Create the project once (or reuse one), then set three repository secrets:

| Secret | Where it comes from |
|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens |
| `VERCEL_ORG_ID` | `src/deployments/vercel/.vercel/project.json` locally |
| `VERCEL_PROJECT_ID` | same file |

Scope the token to that one team. It is long-lived — Vercel has no OIDC path
for the deploy step — so rotate it if it leaks.

Then read [Sync](Sync) to turn on cross-device sync, which needs a Postgres
database (`DATABASE_URL`) and an operator token (`SYNC_TOKEN`) in the project's
environment variables.

## Cloudflare

Worker + static assets, vaults in OPFS. Build with
`src/deployments/cloudflare/scripts/build-assets.sh` and deploy with
`wrangler`. No database, no server-side vault.

## Node server

Plain files on disk under a directory you choose. **No authentication** — see
[Installation](Installation). Use a reverse proxy or a tunnel.

## Which one has analytics

Only the Vercel deployment loads Vercel Web Analytics, and only if the project
has it enabled. The Cloudflare and Node builds serve no `/_vercel/*` route, so
the handle is absent there and the client does nothing. If page views aren't
appearing, [Troubleshooting](Troubleshooting#web-analytics-shows-no-data) has
the two checks that separate the possible causes.
