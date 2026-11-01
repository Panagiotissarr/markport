# Troubleshooting

Organised by symptom. Each entry says what to check and what the answer means,
because "it doesn't work" covers a lot of ground.

## The app looks stale after a deploy

A service worker caches the shell, keyed by build id. Open `/sw.js` and read
`const BUILD_ID = '…'`:

- Matches the deployment you expected → you are not on the old shell.
- Older number → the browser is still serving the previous build. Reload
  twice (the first reload installs the new worker, the second uses it), or
  unregister it in DevTools → Application → Service Workers.

`sw.js` itself is never cached, so this check is always truthful.

## The deploy failed at "Download the Obsidian mobile bundle"

This was a real failure mode, and the cause was a quota, not the code.

`scripts/update-obsidian-mobile.js` asks `api.github.com` for the release JSON.
Unauthenticated that's **60 requests/hour per IP**, and hosted CI runners share
IPs — so the same commit deploys fine at 09:00 and fails at 10:00.

The workflow now passes `GITHUB_TOKEN` to that step, which lifts the limit to
5,000/hour. If it ever reappears, check that the `env:` block is still on that
step in `.github/workflows/deploy.yml`.

## The site deployed, but it's empty / the old one

Confirm the project is **not** connected to Vercel's Git integration and that
its Build Command is empty. See
[Self-Hosting](Self-Hosting#the-one-rule-that-explains-the-vercel-pipeline).

## "Unsupported Obsidian version" screen

You're on a bundle newer than 1.12.7. That's the pin, and 1.13+ genuinely does
not boot as a web app — see
[obsidian-version-support.md](https://github.com/Panagiotissarr/oryn/blob/main/docs/obsidian-version-support.md).

## Sync does nothing

In order:

1. `localStorage['ow-sync:<vaultId>']` exists and points at the right backend
   (see [Sync](Sync#pointing-a-device-at-a-backend)).
2. The token is vault-scoped and belongs to *this* vault — a token for one
   vault gets `403` on another by design.
3. The backend isn't running with `SYNC_STORE=memory`. On a deployment that's
   refused outright; locally it means data vanishes on restart.
4. If you're claiming a vault by name and get **409**, the name already holds
   content and needs the operator `SYNC_TOKEN`.

## Web Analytics shows no data

Two checks in the browser console on the deployed page split the problem:

```js
window.__owAnalytics   // {src, sdkn, sdkv} — the handle the build injected
window.va              // a function — the SDK actually ran
```

| Result | Meaning |
|---|---|
| `__owAnalytics` undefined | the handle didn't ship, or you're on a cached page. Check the deploy's "Verify the artifact" step — it fails when the handle is missing. |
| handle present, `va` undefined | the SDK didn't load. Check `/_vercel/insights/script.js` returns 200 on your domain. |
| both present, still no data | beacons are fired but not landing. Content blockers are the usual cause; Vercel's own troubleshooting names them first. |

If the project has never had Web Analytics enabled, nothing above will help —
enable it once, then redeploy, in that order.

## Notes

- The build in `docs/wiki/` is the source for this wiki. Editing the wiki in
  the browser edits a separate repository, and the next publish overwrites it.
  Change it here instead.
- Nothing here is a substitute for reading the failing step's log. Most of the
  entries above exist because a log said exactly what was wrong.
