/**
 * run-sync.js — bidirectional sync orchestrator (the serverless-sync brief
 * §2/§3ד). Supersedes run-pull.js when present (boot.js prefers this runner),
 * but keeps the same entry shape: `run(vaultId, cfg)` → summary, plus
 * `getSyncConfig`/`setSyncConfig`/`getStatus`.
 *
 * Flow per run (mutex: a second run() while not idle → {skipped, reason:'busy'}):
 *
 *   listing     remote.manifestAll() — every page, or throw (never act on a
 *               truncated manifest: it would look like mass deletions)
 *   hashing     local-manifest (L) + hashStore.all() (S)
 *   deciding    plan-sync.js — pure classification of the path union
 *   downloading plan.downloads: blob → OPFS → hashStore.upsert
 *               (plus no-network bookkeeping: setSynced/forgetSynced/
 *               localDeletes)
 *   conflicting plan.conflicts: server wins at the ORIGINAL path, local
 *               content survives as `name.conflict-<stamp>.ext`
 *   pushing     pushOps(): read+re-hash each change, upload only hashes the
 *               server lacks, commit in ≤1000-op batches, apply `applied`
 *               to hashStore; a commit race (server CAS rejected us anyway)
 *               resolves through the same conflict path
 *   finish      summary {downloaded, pushed, deleted, conflicts, ...}
 *
 * Servers that predate push (501/404 on push endpoints — src/sync-server's
 * stubs-v2.js) turn a run into a pull-only sync: `.code === 'EPUSH'` is
 * caught, `pushSupported:false` is reported, everything else still applies.
 *
 * Config (brief §3ה): `localStorage['ow-sync:'+vaultId]` =
 * `{baseUrl, token, vault?}` — `vault` scopes the server query; unset → the
 * server's default vault. No config → boot.js never shows the button.
 *
 * Modes — `run(vaultId, cfg, mode)`:
 *   'both' (default)  the full cycle above (what the old single button ran)
 *   'pull'            downloads + bookkeeping + local conforms + conflict
 *                     resolution only; nothing is uploaded (push phase skipped)
 *   'push'            uploads + commits only: no downloads, no local deletes,
 *                     no conflict resolution — a CAS conflict is reported in
 *                     `summary.conflicts` and left for the next pull (its
 *                     local content is untouched, S unchanged → still latent)
 *
 * Browser-only — window-attached IIFE, no module system. Style: no `?.`/`??`.
 */
(function () {
  'use strict';

  function normalizeMode(mode) {
    return (mode === 'pull' || mode === 'push') ? mode : 'both';
  }

  function configKeyFor(vaultId) { return 'ow-sync:' + vaultId; }

  // Identical to run-pull.js's helpers (kept in both files so either runner
  // works standalone; change them together).
  // SESSION-FIRST: password-claimed vaults keep their mpv1 token in
  // sessionStorage (boot.js's saveClaimedVault — "forget the password when
  // the page is closed"); manual operator configs (a raw SYNC_TOKEN typed
  // into localStorage, per the READMEs) keep working through the fallback.
  function getSyncConfig(vaultId) {
    try {
      var raw = null;
      try { raw = sessionStorage.getItem(configKeyFor(vaultId)); } catch (_) { }
      if (!raw) raw = localStorage.getItem(configKeyFor(vaultId));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.baseUrl || !parsed.token) return null;
      return { baseUrl: parsed.baseUrl, token: parsed.token, vault: parsed.vault || null };
    } catch (_) {
      return null;
    }
  }

  function setSyncConfig(vaultId, cfg) {
    localStorage.setItem(configKeyFor(vaultId), JSON.stringify({
      baseUrl: cfg.baseUrl,
      token: cfg.token,
      vault: cfg.vault || null,
    }));
  }

  var syncStatus = 'idle'; // idle → listing → hashing → deciding → downloading → conflicting → pushing → finish → idle
  function getStatus() { return syncStatus; }

  // Server's MAX_PATH_LENGTH is 1024; leave headroom for the conflict
  // suffix before deciding a copy can be pushed (a copy that cannot be
  // pushed still stays safely on disk — it syncs later if paths allow).
  var MAX_PUSHABLE_PATH = 1000;
  var COMMIT_BATCH = 1000;

  // ArrayBuffer/Uint8Array → base64, chunked (btoa blows the arg stack at
  // ~65k bytes — same as run-pull.js's private helper).
  function toBase64(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var CHUNK = 0x8000;
    var s = '';
    for (var i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function stampNow() {
    var d = new Date();
    return pad(d.getFullYear(), 4) + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) +
      pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
  }

  // 'dir/note.md' + stamp + n → 'dir/note.conflict-20260926101500[-n].md'
  function conflictCopyName(path, stamp, n) {
    var slash = path.lastIndexOf('/');
    var dir = slash === -1 ? '' : path.slice(0, slash + 1);
    var name = slash === -1 ? path : path.slice(slash + 1);
    var suffix = '.conflict-' + stamp + (n > 1 ? '-' + n : '');
    var dot = name.lastIndexOf('.');
    if (dot > 0) return dir + name.slice(0, dot) + suffix + name.slice(dot);
    return dir + name + suffix;
  }

  async function uniqueCopyPath(store, path, stamp) {
    for (var n = 1; n <= 99; n++) {
      var candidate = conflictCopyName(path, stamp, n);
      try {
        await store.stat({ path: candidate }); // exists → try next suffix
      } catch (_) {
        return candidate; // ENOENT → free
      }
    }
    return conflictCopyName(path, stamp, Date.now());
  }

  // Server state for `path` ({hash,size,deleted} — plan-sync's conflicts and
  // the commit endpoint's CAS conflicts share this shape). Preserves local
  // content as a conflict copy, then conforms the original path to the
  // server (brief §4: server wins at the original, nothing is lost).
  async function resolveConflict(ctx, path, server) {
    var localBytes = null;
    try {
      localBytes = await window.__owSyncLocalManifest.readRawBytes(ctx.vaultId, path);
    } catch (_) {
      localBytes = null; // we had deleted it — nothing of ours to keep
    }

    if (localBytes) {
      var copyPath = await uniqueCopyPath(ctx.store, path, ctx.stamp);
      await ctx.store.writeFile({ path: copyPath, data: toBase64(localBytes) });
      if (copyPath.length <= MAX_PUSHABLE_PATH) {
        var copyHash = await window.__owSyncLocalManifest.sha256Hex(localBytes);
        // The copy is a brand-new path on the server → pushed next round
        // (base null). Skipped entirely on pull-only servers (EPUSH later).
        ctx.copyChanges.push({ path: copyPath, hash: copyHash, size: localBytes.byteLength, baseHash: null });
      }
    }

    if (server.deleted || !server.hash) {
      try {
        await ctx.store.deleteFile({ path: path });
      } catch (_) { /* already gone — conforming is idempotent */ }
      await ctx.hashStore.remove(path);
    } else {
      var buf = await ctx.remote.blob(server.hash);
      await ctx.store.writeFile({ path: path, data: toBase64(buf) });
      await ctx.hashStore.upsert(path, server.hash);
    }

    ctx.summary.conflicts++;
    ctx.summary.conflictPaths.push(path);
  }

  // Upload + commit one set of push operations. Mutates hashStore and the
  // summary on success; CAS conflicts land in ctx.lateConflicts (resolved by
  // the caller — their copies need a SECOND push round, so they cannot be
  // resolved from inside this one). Throws EPUSH/EAUTH upward.
  async function pushOps(ctx, changes, deletions) {
    if (changes.length === 0 && deletions.length === 0) return;

    // Read + re-hash every change. The vault may have moved since the
    // scan (Obsidian editing mid-sync): a vanished or re-hashed file is
    // dropped from THIS round rather than pushing content we no longer vouch
    // for — the next sync picks it up with fresh facts.
    var ready = [];
    for (var i = 0; i < changes.length; i++) {
      var ch = changes[i];
      var bytes;
      try {
        bytes = await window.__owSyncLocalManifest.readRawBytes(ctx.vaultId, ch.path);
      } catch (_) {
        continue; // vanished mid-sync
      }
      var h = await window.__owSyncLocalManifest.sha256Hex(bytes);
      if (h !== ch.hash) continue; // changed since planning
      ready.push({ change: ch, hash: h, bytes: bytes });
    }

    // Upload only what the server is missing (renames/reverts/second device
    // joining a populated vault skip the bytes entirely).
    if (ready.length > 0) {
      var want = [];
      var seen = {};
      for (var r = 0; r < ready.length; r++) {
        if (!seen[ready[r].hash]) {
          seen[ready[r].hash] = true;
          want.push(ready[r].hash);
        }
      }
      var missing = await ctx.remote.missingBlobs(want); // may throw EPUSH
      var missingSet = {};
      for (var m = 0; m < missing.length; m++) missingSet[missing[m]] = true;
      // Upload what the server lacks, 3 at a time (putBlob is idempotent
      // per chunk and content-addressed, so parallel uploads of distinct
      // hashes are safe; duplicates within one push are skipped). Any
      // failure — after remote-client's own retries — throws and fails this
      // push phase: the commit below must be able to assume the bytes
      // arrived. (A rejected Promise.all leaves the sibling workers
      // finishing their idempotent uploads in the background — harmless.)
      var upQueue = [];
      var upSeen = {};
      for (var u = 0; u < ready.length; u++) {
        var uh = ready[u].hash;
        if (missingSet[uh] && !upSeen[uh]) { upSeen[uh] = true; upQueue.push(ready[u]); }
      }
      if (upQueue.length > 0) {
        var UP_CONCURRENCY = 3;
        async function uploadWorker() {
          for (;;) {
            var item = upQueue.shift();
            if (!item) return;
            await ctx.remote.putBlob(item.hash, item.bytes);
          }
        }
        var upWorkers = [];
        var upCount = Math.min(UP_CONCURRENCY, upQueue.length);
        for (var uw = 0; uw < upCount; uw++) upWorkers.push(uploadWorker());
        await Promise.all(upWorkers);
      }
    }

    var readyChanges = [];
    for (var q = 0; q < ready.length; q++) readyChanges.push(ready[q].change);

    var bytesByHash = {};
    for (var b = 0; b < ready.length; b++) bytesByHash[ready[b].hash] = ready[b].bytes;

    var deletedSet = {};
    for (var d = 0; d < deletions.length; d++) deletedSet[deletions[d].path] = true;
    var changedSet = {};
    for (var c = 0; c < readyChanges.length; c++) changedSet[readyChanges[c].path] = true;

    var idx = 0;
    while (idx < readyChanges.length || idx < deletions.length) {
      var batchChanges = readyChanges.slice(idx, idx + COMMIT_BATCH);
      var batchDeletions = deletions.slice(idx, idx + COMMIT_BATCH);
      idx += COMMIT_BATCH;

      var res;
      try {
        res = await ctx.remote.commit(batchChanges, batchDeletions);
      } catch (e) {
        if (e && e.code === 'EMISSING') {
          // A blob vanished between our missing-check and the commit (GC).
          // Upload those and retry once — the second failure means a race we
          // lost twice, and surfacing it beats a silent partial commit.
          for (var em = 0; em < e.hashes.length; em++) {
            var need = e.hashes[em];
            if (bytesByHash[need]) await ctx.remote.putBlob(need, bytesByHash[need]);
          }
          res = await ctx.remote.commit(batchChanges, batchDeletions);
        } else {
          throw e;
        }
      }

      for (var a = 0; a < (res.applied || []).length; a++) {
        var path = res.applied[a];
        if (changedSet[path]) {
          await ctx.hashStore.upsert(path, findHash(readyChanges, path));
          ctx.summary.pushed++;
        } else if (deletedSet[path]) {
          await ctx.hashStore.remove(path);
          ctx.summary.deleted++;
        }
      }
      for (var f = 0; f < (res.conflicts || []).length; f++) {
        ctx.lateConflicts.push(res.conflicts[f]);
      }
    }
  }

  function findHash(changes, path) {
    for (var i = 0; i < changes.length; i++) {
      if (changes[i].path === path) return changes[i].hash;
    }
    return null;
  }

  async function runSync(vaultId, cfg, mode) {
    if (syncStatus !== 'idle') return { skipped: true, reason: 'busy' };
    var m = normalizeMode(mode);
    var doPull = m !== 'push';
    var doPush = m !== 'pull';

    syncStatus = 'listing';
    try {
      var store = window.__owOpfsStore.makeStore(vaultId);
      var hashStore = window.__owSyncHashStore.makeStore(vaultId);
      var remote = window.__owSyncRemoteClient.RemoteClient({
        baseUrl: cfg.baseUrl,
        token: cfg.token,
        vault: cfg.vault || undefined,
      });

      var ctx = {
        vaultId: vaultId,
        store: store,
        hashStore: hashStore,
        remote: remote,
        stamp: stampNow(),
        copyChanges: [],
        lateConflicts: [],
        pushSupported: true,
        summary: {
          downloaded: 0,
          pushed: 0,
          deleted: 0,
          conflicts: 0,
          conflictPaths: [],
          skipped: 0,
          pushSupported: true,
        },
      };

      var remoteManifest = await remote.manifestAll(); // may throw {code:'EAUTH'}

      syncStatus = 'hashing';
      var localManifest = await window.__owSyncLocalManifest.buildLocalManifest(store, vaultId, hashStore);
      var syncedHashes = await hashStore.all();

      syncStatus = 'deciding';
      var plan = window.__owSyncPlanSync.planSync(remoteManifest.entries, localManifest, syncedHashes);

      // ── pull ────────────────────────────────────────────────────────────
      syncStatus = 'downloading';
      if (doPull && plan.downloads.length > 0) {
        // Downloads are the network-bound phase of a pull (and where a cold
        // serverless function used to time the whole run out on big vaults —
        // "sometimes it fails to pull"). A pool of 4 parallel workers cuts
        // the wall time ~4x on typical note-sized blobs; each worker applies
        // its own file (writeFile → hashStore.upsert) — safe concurrently:
        // distinct OPFS paths, and hash-store's IndexedDB transactions are
        // per-op. A failure (even after remote-client's retries) no longer
        // aborts the whole run: it is counted (summary.downloadErrors),
        // logged, and left for the next sync — the hashStore was only
        // updated for successes, so failed files are still "not downloaded"
        // next time. EAUTH still aborts immediately: every remaining
        // request would fail the same way.
        var dlQueue = plan.downloads.slice();
        var dlErrors = [];
        var DL_CONCURRENCY = 4;
        async function downloadWorker() {
          for (;;) {
            if (dlErrors.length > 0 && dlErrors[0].error && dlErrors[0].error.code === 'EAUTH') return;
            var dl = dlQueue.shift();
            if (!dl) return;
            try {
              var buf = await remote.blob(dl.hash);
              await store.writeFile({ path: dl.path, data: toBase64(buf) });
              await hashStore.upsert(dl.path, dl.hash);
              ctx.summary.downloaded++;
            } catch (e) {
              dlErrors.push({ path: dl.path, error: e });
            }
          }
        }
        var dlWorkers = [];
        var dlCount = Math.min(DL_CONCURRENCY, dlQueue.length);
        for (var dli = 0; dli < dlCount; dli++) dlWorkers.push(downloadWorker());
        await Promise.all(dlWorkers);
        if (dlErrors.length > 0) {
          if (dlErrors[0].error && dlErrors[0].error.code === 'EAUTH') throw dlErrors[0].error;
          ctx.summary.downloadErrors = dlErrors.length;
          ctx.summary.downloadErrorPaths = dlErrors.slice(0, 5).map(function (x) { return x.path; });
          console.warn('[ow-sync] ' + dlErrors.length + ' download(s) failed (left for the next sync):',
            dlErrors.slice(0, 5).map(function (x) {
              return x.path + ': ' + ((x.error && x.error.message) || x.error);
            }));
        }
      }

      // bookkeeping — no network needed
      for (var s = 0; s < plan.setSynced.length; s++) {
        await hashStore.upsert(plan.setSynced[s].path, plan.setSynced[s].hash);
      }
      for (var fs = 0; fs < plan.forgetSynced.length; fs++) {
        await hashStore.remove(plan.forgetSynced[fs]);
      }
      if (doPull) {
        for (var ld = 0; ld < plan.localDeletes.length; ld++) {
          try {
            await store.deleteFile({ path: plan.localDeletes[ld] });
          } catch (_) { /* already gone */ }
          await hashStore.remove(plan.localDeletes[ld]);
        }
      }
      ctx.summary.skipped = plan.inSync + plan.setSynced.length +
        plan.forgetSynced.length + (doPull ? plan.localDeletes.length : 0);

      // ── conflicts known before pushing (server state from the manifest) ─
      syncStatus = 'conflicting';
      if (doPull) {
        for (var pc = 0; pc < plan.conflicts.length; pc++) {
          await resolveConflict(ctx, plan.conflicts[pc].path, plan.conflicts[pc]);
        }
      }

      // ── push ────────────────────────────────────────────────────────────
      if (doPush) {
        syncStatus = 'pushing';
        try {
          await pushOps(ctx, plan.pushChanges, plan.pushDeletions);

          // A CAS conflict despite our pre-check means the server moved
          // between manifest and commit — resolve with the state it reported.
          // Push-only mode leaves them latent (counted below): resolving
          // would rewrite local files, which a PUSH must never do.
          for (var lc = 0; lc < ctx.lateConflicts.length; lc++) {
            if (doPull) {
              await resolveConflict(ctx, ctx.lateConflicts[lc].path, ctx.lateConflicts[lc]);
            } else {
              ctx.summary.conflicts++;
              ctx.summary.conflictPaths.push(ctx.lateConflicts[lc].path);
            }
          }

          if (ctx.pushSupported && ctx.copyChanges.length > 0) {
            await pushOps(ctx, ctx.copyChanges, []);
          }
        } catch (e) {
          if (e && e.code === 'EPUSH') {
            ctx.pushSupported = false; // old pull-only sync-server
          } else {
            throw e;
          }
        }
        ctx.summary.pushSupported = ctx.pushSupported;
      }
      // push-only never resolved plan.conflicts — their count is deliberately
      // absent from the summary (only lateConflicts, above, are reported).

      syncStatus = 'finish';
      return ctx.summary;
    } finally {
      syncStatus = 'idle';
    }
  }

  window.__owSyncRunSync = {
    run: runSync,
    getStatus: getStatus,
    getSyncConfig: getSyncConfig,
    setSyncConfig: setSyncConfig,
  };
})();
