# Sync

Optional. Without it, Oryn is a local app. With it, vaults move between devices
through a backend you run.

The protocol lives under `/sync/v1/*` and the security model is written up in
[SECURITY.md](https://github.com/Panagiotissarr/oryn/blob/main/src/deployments/vercel/SECURITY.md).
Read that before exposing a backend to the internet; this page is the
operator's summary.

## The pieces

| Piece | What it is |
|---|---|
| `SYNC_TOKEN` | The operator key for a backend. It opens every vault and keys the token HMAC. Treat it as the master key. |
| `mpv1.*` tokens | Vault-scoped bearer tokens, issued per vault. One vault, nothing else. |
| `ow-sync:<vaultId>` | Where a device keeps its backend URL + token in `localStorage`. |

## Claiming a vault

A vault addressed **by name** must be claimed before it holds anything:

```
POST /sync/v1/vaults/<name>
```

- An *empty* vault name is claimable by its first visitor by design.
- A name that already holds content can only be claimed with the operator
  `SYNC_TOKEN`; otherwise the backend answers **409**.

That rule is what stops a stranger from adopting a vault that already has your
notes in it.

## Pointing a device at a backend

The plugin's settings hold the backend URL and the token. Under the hood the
client stores them in `localStorage['ow-sync:<vaultId>']`:

```js
localStorage.setItem("ow-sync:<vaultId>", JSON.stringify({
  baseUrl: "https://your-deployment.example",
  token: "…"
}));
```

If sync silently does nothing, check that key exists for the vault you're in —
[Troubleshooting](Troubleshooting#sync-does-nothing).

## Fail-closed behaviours worth knowing

- **`SYNC_STORE=memory` is refused on a deployment.** It loses data on the next
  cold start. `SYNC_ALLOW_MEMORY_STORE=1` overrides it for local work only.
- **Commits fail with 422** when a referenced blob is missing, rather than
  writing a manifest that points at nothing.
- **Uploads are bounded** per part and cumulatively; blob size is measured, not
  trusted from the client.
- **`/sync/v1/*` is never cached.** A cached manifest makes a device decide
  against stale server state. The service worker passes those requests
  straight through.
