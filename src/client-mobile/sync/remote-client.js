/**
 * remote-client.js — thin HTTP client over the `/sync/v1` protocol (the
 * pull-sync brief §2/§3א; Vercel serverless implementation lives in
 * `src/deployments/vercel/`, the reference Node server in
 * `src/sync-server/`).
 *
 * API:
 *   manifest()      → one page {cursor, entries:[{path,size,hash}], hasMore}
 *   manifestAll()   → every page concatenated {cursor, entries}; throws if any
 *                     page fails, so callers never act on a truncated manifest
 *                     (a partial listing would look like mass deletions)
 *   blob(hash)      → ArrayBuffer. Falls back to ranged assembly when the
 *                     server answers 413 (Vercel caps a response at 4.5 MB,
 *                     so big blobs must be fetched in 2 MB windows)
 *   putBlob(hash, bytes) → chunked upload (2 MB JSON/base64 chunks — the same
 *                     4.5 MB cap applies to requests), idempotent per chunk
 *   missingBlobs(h) → {missing:[hash…]} — which hashes the server lacks
 *   commit(changes, deletions) → {rev, applied, conflicts}
 *
 * Error codes surfaced to callers:
 *   EAUTH      401 — bad token; caller shows "authentication failed"
 *   EPUSH      501/404 on a push endpoint — old pull-only sync-server;
 *              run-sync.js then finishes as a pull-only sync
 *   EMISSING   422 on commit — `.hashes` lists blobs to upload before retrying
 *
 * `opts.vault` scopes every request with `?vault=<id>` (multi-vault servers);
 * omitted → the server's default vault, and the query string is byte-identical
 * to the original pull-only client (old servers ignore it either way).
 *
 * Browser-only (fetch) — window-attached IIFE, no module system (mirrors
 * opfs-store.js / folder-handle-store.js). Style: no `?.`/`??` (brief §3ו) —
 * otherwise free to use async/await/const/arrow like its siblings.
 */
(function () {
  'use strict';

  function joinUrl(baseUrl, path) {
    var base = String(baseUrl || '').replace(/\/+$/, '');
    return base + path;
  }

  // 401 is surfaced with a stable `.code === 'EAUTH'` so callers (run-pull.js)
  // can show "אימות נכשל" without a retry-loop (brief §3ה) instead of a
  // generic network-error message.
  function authError(message) {
    var e = new Error(message);
    e.code = 'EAUTH';
    return e;
  }

  // Push endpoint answered 501/404 — a pull-only sync-server (v1, brief §2
  // "stubs ל-v2"). run-sync.js catches `.code === 'EPUSH'` and reports the
  // run as pull-only instead of failing it.
  function pushUnsupported(message) {
    var e = new Error(message);
    e.code = 'EPUSH';
    return e;
  }

  // Uint8Array → base64, chunked (btoa blows the arg stack at ~65k bytes —
  // same limit as run-pull.js's arrayBufferToBase64; uploads are 2 MB, far
  // past that threshold).
  function bytesToBase64(u8) {
    var CHUNK = 0x8000;
    var s = '';
    for (var i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  // Vercel caps a response at 4.5 MB: the server answers 413 to an
  // un-ranged GET over this size, and the client windows the rest. Keep the
  // window well under the server's full-GET threshold (3 MiB — see
  // deployments/vercel lib/config or the blob handler).
  var RANGE_WINDOW = 2 * 1024 * 1024;
  var UPLOAD_CHUNK = 2 * 1024 * 1024;
  var COMMIT_MAX_OPS = 1000; // client batch size, well under the server's 3000

  // Every request carries a 30s deadline: a stalled connection (cold Vercel
  // function, dead network) must fail loudly instead of leaving the sync
  // spinner turning forever. AbortSignal.timeout is widely available; where
  // it isn't, fetch proceeds unbounded (status quo) rather than break.
  var REQ_TIMEOUT_MS = 30000;
  function fetchOnce(url, opts) {
    var o = opts ? Object.assign({}, opts) : {};
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout && !o.signal) {
      // Fresh signal PER ATTEMPT — a reused opts object would otherwise
      // carry an already-aborted signal into every retry (instant failure).
      o.signal = AbortSignal.timeout(REQ_TIMEOUT_MS);
    }
    return fetch(url, o).catch(function (e) {
      if (e && (e.name === 'AbortError' || e.code === 20)) {
        var t = new Error('request timed out after ' + Math.round(REQ_TIMEOUT_MS / 1000) + 's');
        t.code = 'ETIMEOUT';
        throw t;
      }
      throw e;
    });
  }

  // ── retries with exponential backoff ("sync sometimes fails" fix) ────────
  // Transient failures get up to MAX_ATTEMPTS tries: network-level fetch
  // rejections (TypeError — DNS, connection reset, offline blips, cold
  // serverless functions), timeouts (ETIMEOUT), and 429/5xx responses.
  // Deterministic 4xx (401 auth, 404, 409 hash-mismatch, 422 missing-blobs)
  // are NOT retried — the callers below branch on exactly those statuses.
  // The LAST attempt's response is returned as-is, so every status-handling
  // branch in the protocol functions stays unchanged. Retries are safe:
  // bodies are plain JSON strings (re-sendable), blob PUTs are idempotent
  // per chunk (content-addressed), and commit is CAS-guarded server-side
  // (a replayed commit either applies once or reports conflicts — never
  // corrupts).
  var MAX_ATTEMPTS = 3;
  var RETRY_BASE_MS = 400;
  var RETRYABLE_STATUS = { 429: true, 500: true, 502: true, 503: true, 504: true };
  function isTransientFetchError(e) {
    if (!e) return false;
    if (e.code === 'ETIMEOUT') return true;
    // TypeError is what fetch throws for network-level failures.
    return (typeof TypeError !== 'undefined' && e instanceof TypeError) || e.name === 'TypeError';
  }
  function backoffMs(retryIndex) {
    var base = RETRY_BASE_MS * Math.pow(2, retryIndex);            // 400, 800
    return Math.round(base * (0.7 + Math.random() * 0.6));         // ±30% jitter
  }
  function fetchReq(url, opts) {
    var attempt = 0;
    function tryOnce() {
      return fetchOnce(url, opts).then(function (res) {
        if (RETRYABLE_STATUS[res.status] && attempt + 1 < MAX_ATTEMPTS) {
          attempt++;
          console.warn('[ow-sync] HTTP ' + res.status + ' — retry ' + attempt + '/' + (MAX_ATTEMPTS - 1) + ': ' + url);
          return new Promise(function (r) { setTimeout(r, backoffMs(attempt - 1)); }).then(tryOnce);
        }
        return res;
      }).catch(function (e) {
        if (isTransientFetchError(e) && attempt + 1 < MAX_ATTEMPTS) {
          attempt++;
          console.warn('[ow-sync] ' + ((e && e.message) || e) + ' — retry ' + attempt + '/' + (MAX_ATTEMPTS - 1) + ': ' + url);
          return new Promise(function (r) { setTimeout(r, backoffMs(attempt - 1)); }).then(tryOnce);
        }
        throw e;
      });
    }
    return tryOnce();
  }

  // baseUrl + token (+ optional vault) — per-vault config (brief §3ה,
  // `localStorage['ow-sync:'+vaultId]`).
  function RemoteClient(opts) {
    var baseUrl = opts.baseUrl;
    var token = opts.token;
    var vault = opts.vault;

    function authHeaders(extra) {
      var h = { Authorization: 'Bearer ' + token };
      if (extra) {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
        }
      }
      return h;
    }

    function vaultQuery() {
      return vault ? 'vault=' + encodeURIComponent(vault) + '&' : '';
    }

    function manifestUrl(after) {
      var qs = vaultQuery() + (after ? 'after=' + encodeURIComponent(after) : '');
      return joinUrl(baseUrl, '/sync/v1/manifest') + (qs ? '?' + qs : '');
    }

    function blobUrl(hash, extraQuery) {
      var qs = vaultQuery() + (extraQuery || '');
      return joinUrl(baseUrl, '/sync/v1/blob/' + hash) + (qs ? '?' + qs : '');
    }

    // GET /sync/v1/manifest → one page {cursor, entries:[{path,size,hash}]}.
    // `cache: 'no-store'` — a sync decision must always be based on the CURRENT
    // server state, never a browser-cached one (unlike blob(), below, whose
    // URLs are content-addressed and safe to let the browser cache).
    async function manifest(after) {
      var res = await fetchReq(manifestUrl(after || ''), { headers: authHeaders(), cache: 'no-store' });
      if (res.status === 401) throw authError('sync manifest: authentication failed (401)');
      if (!res.ok) throw new Error('sync manifest: HTTP ' + res.status);
      return res.json();
    }

    // Every page, in one {cursor, entries}. Stops on `hasMore:false` — an
    // older server that doesn't send the field (single-page world) reads as
    // false, so this degrades to exactly one manifest() call against it.
    // Any page error throws: never hand a partial listing to plan-sync.js.
    async function manifestAll() {
      var entries = [];
      var cursor = null;
      var after = '';
      for (;;) {
        var page = await manifest(after);
        if (page.entries && page.entries.length) {
          for (var i = 0; i < page.entries.length; i++) entries.push(page.entries[i]);
        }
        cursor = page.cursor;
        if (!page.hasMore || !page.entries || page.entries.length === 0) break;
        after = page.entries[page.entries.length - 1].path;
      }
      return { cursor: cursor, entries: entries };
    }

    async function blobResponse(url) {
      var res = await fetchReq(url, { headers: authHeaders() });
      if (res.status === 401) throw authError('sync blob: authentication failed (401)');
      return res;
    }

    // GET /sync/v1/blob/<hash> → ArrayBuffer (raw bytes, content-addressed —
    // brief §3ג: the caller base64-encodes these bytes itself before handing
    // them to OpfsStore.writeFile; this client never touches base64).
    // Deliberately no `cache: 'no-store'` — the server marks this route
    // `Cache-Control: immutable` (content addressed by hash, can never change
    // under the same URL), so letting the browser's HTTP cache serve repeat
    // requests is correct and saves bandwidth. NOTE: this means the browser
    // cache is NOT auth-scoped — a second RemoteClient with a different token
    // hitting the same already-cached hash gets the cached body without a
    // fresh 401 check. That's fine for content-addressed immutable data.
    async function blob(hash) {
      var res = await blobResponse(blobUrl(hash));
      if (res.status === 413) return blobRanged(hash); // server full-GET cap
      if (!res.ok) throw new Error('sync blob: HTTP ' + res.status + ' for hash ' + hash);
      return res.arrayBuffer();
    }

    // Windowed reassembly for blobs the server refuses to serve whole.
    // 416 (start past EOF) is the loop's normal terminator for a size that
    // is an exact multiple of the window.
    async function blobRanged(hash) {
      var parts = [];
      var start = 0;
      for (;;) {
        var res = await blobResponse(blobUrl(hash, 'start=' + start + '&end=' + (start + RANGE_WINDOW - 1)));
        if (res.status === 416) break;
        if (!res.ok) throw new Error('sync blob range: HTTP ' + res.status + ' at offset ' + start);
        var buf = await res.arrayBuffer();
        parts.push(new Uint8Array(buf));
        if (buf.byteLength < RANGE_WINDOW) break;
        start += RANGE_WINDOW;
      }
      var total = 0;
      for (var i = 0; i < parts.length; i++) total += parts[i].length;
      var out = new Uint8Array(total);
      var at = 0;
      for (var j = 0; j < parts.length; j++) {
        out.set(parts[j], at);
        at += parts[j].length;
      }
      return out.buffer;
    }

    // PUT /sync/v1/blob/<hash> — chunked, idempotent. bytes: Uint8Array or
    // ArrayBuffer of the FULL blob; the hash must be its sha-256 (the server
    // verifies on assembly and 409s otherwise).
    async function putBlob(hash, bytes) {
      var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      var total = Math.max(1, Math.ceil(u8.length / UPLOAD_CHUNK));
      for (var i = 0; i < total; i++) {
        var start = i * UPLOAD_CHUNK;
        var slice = u8.subarray(start, Math.min(u8.length, start + UPLOAD_CHUNK));
        var res = await fetchReq(blobUrl(hash), {
          method: 'PUT',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            index: i,
            total: total,
            size: u8.length,
            data: bytesToBase64(slice),
          }),
        });
        if (res.status === 401) throw authError('sync putBlob: authentication failed (401)');
        if (res.status === 501 || res.status === 404) {
          throw pushUnsupported('sync putBlob: HTTP ' + res.status);
        }
        if (res.status === 409) throw new Error('sync putBlob: content does not match hash ' + hash);
        if (!res.ok) throw new Error('sync putBlob: HTTP ' + res.status + ' (chunk ' + i + '/' + total + ')');
        await res.json();
      }
      return { hash: hash, stored: true };
    }

    // POST /sync/v1/blobs/missing {hashes} → [hash…] the server lacks.
    async function missingBlobs(hashes) {
      var res = await fetchReq(joinUrl(baseUrl, '/sync/v1/blobs/missing') + (vault ? '?vault=' + encodeURIComponent(vault) : ''), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ hashes: hashes }),
        cache: 'no-store',
      });
      if (res.status === 401) throw authError('sync blobs/missing: authentication failed (401)');
      if (res.status === 501 || res.status === 404) {
        throw pushUnsupported('sync blobs/missing: HTTP ' + res.status);
      }
      if (!res.ok) throw new Error('sync blobs/missing: HTTP ' + res.status);
      var body = await res.json();
      return body.missing || [];
    }

    // POST /sync/v1/commit {changes, deletions} → {rev, applied, conflicts}.
    // 422 → EMISSING with `.hashes` (those blobs vanished server-side;
    // upload them and retry). 501/404 → EPUSH (pull-only server).
    async function commit(changes, deletions) {
      var res = await fetchReq(joinUrl(baseUrl, '/sync/v1/commit') + (vault ? '?vault=' + encodeURIComponent(vault) : ''), {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ changes: changes || [], deletions: deletions || [] }),
        cache: 'no-store',
      });
      if (res.status === 401) throw authError('sync commit: authentication failed (401)');
      if (res.status === 501 || res.status === 404) {
        throw pushUnsupported('sync commit: HTTP ' + res.status);
      }
      if (res.status === 422) {
        var body = await res.json();
        var e = new Error('sync commit: blobs missing on server');
        e.code = 'EMISSING';
        e.hashes = body.hashes || [];
        throw e;
      }
      if (!res.ok) throw new Error('sync commit: HTTP ' + res.status);
      return res.json();
    }

    return {
      manifest: manifest,
      manifestAll: manifestAll,
      blob: blob,
      putBlob: putBlob,
      missingBlobs: missingBlobs,
      commit: commit,
    };
  }

  window.__owSyncRemoteClient = { RemoteClient: RemoteClient };
})();
