'use strict';
/**
 * Markport Neon Sync — Obsidian plugin (desktop AND mobile).
 *
 * Bidirectional sync between this vault and a Markport `/sync/v1` backend
 * (the Vercel + Neon deployment, e.g. https://notes.sarris.dev). Same
 * protocol and same decision rules as the browser client
 * (src/client-mobile/sync/), so both clients can sync one server:
 *
 *   listing     GET  /sync/v1/manifest (paginated, all pages or fail)
 *   deciding    planSync() — the pure decision table, verbatim copy of
 *               src/client-mobile/sync/plan-sync.js (kept identical by
 *               test/plan.test.js vectors, same as the browser suite)
 *   downloading GET  /sync/v1/blob/<hash> (windowed on 413)
 *   pushing     POST /sync/v1/blobs/missing → PUT blob chunks → POST commit
 *               (baseHash CAS; server wins conflicts, loser preserved as
 *               name.conflict-<stamp>.ext)
 *
 * Auth: the settings password is exchanged for a vault-scoped `mpv1.*`
 * bearer token via POST /sync/v1/vaults/<name> (claim-if-unlocked-else-
 * unlock); the token is reused until it nears its 90-day expiry. A manually
 * pasted token (e.g. the operator's global SYNC_TOKEN) also works.
 *
 * Mobile rules: only `require('obsidian')`, `app.requestUrl` (CORS-free on
 * both platforms), WebCrypto (`crypto.subtle`) and Vault adapter APIs — no
 * Node `fs`/`crypto`, no Electron. manifest.json has isDesktopOnly:false.
 *
 * Single-file on purpose (no bundler): `require('obsidian')` is the only
 * require, wrapped in a guard so plain Node can load this file too — that
 * is what test/plan.test.js does to exercise the pure functions.
 */

// ── Obsidian API ────────────────────────────────────────────────────────────
// require('obsidian') is the documented, supported import on desktop and
// mobile. The try/catch keeps this file loadable under plain Node, where
// 'obsidian' does not exist: the class below then extends stubs and only
// the pure functions are exercised. Nothing Obsidian-specific runs at
// module top level beyond these lookups.
var Obs = (function () {
  try {
    return require('obsidian');
  } catch (_) {
    return {};
  }
})();
var PluginBase = Obs.Plugin || function () {};
var PluginSettingTabBase = Obs.PluginSettingTab || function () {};
var Notice = Obs.Notice || function () {};
var Setting = Obs.Setting || function () {};
var normalizePath = Obs.normalizePath || function (p) { return String(p); };
var requestUrl = Obs.requestUrl || null;

// ── protocol constants (mirror src/client-mobile/sync/remote-client.js) ────
var RANGE_WINDOW = 2 * 1024 * 1024;    // blob GET window (server 413 cap)
var UPLOAD_CHUNK = 2 * 1024 * 1024;    // blob PUT chunk (Vercel 4.5 MB cap)
var COMMIT_MAX_OPS = 1000;             // commit batch (server allows 3000)
var MAX_PUSHABLE_PATH = 1000;          // server MAX_PATH_LENGTH minus headroom

// ═══════════════════════════════════════════════════════════════════════════
// Pure functions — no I/O, exercised by node --test (see test/plan.test.js).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * planSync — pure decision function for BIDIRECTIONAL sync. Runs once per
 * sync over the union of remote-manifest paths and local-manifest paths:
 *
 *   remoteEntries — [{path, size, hash}] from the manifest
 *   localHashes   — {[path]: {hash, size}} (L)
 *   syncedHashes  — {[path]: hash} (S — last-synced)
 *
 * The decision table, per path (⊥ = absent):
 *
 *   L⊥    R⊥    → both gone: forget S if we had one.
 *   L⊥    R=…   → S⊥: download (new on server)
 *                 S=R: we deleted it, server unchanged → push deletion
 *                 else: we deleted it, server edited → conflict (server wins:
 *                       nothing of ours to keep, the deletion is abandoned)
 *   L=…   R⊥    → S⊥: push (new local file)
 *                 S=L: server deleted it, we never touched it → conform
 *                      (delete locally, forget S)
 *                 else: we edited it, server deleted it → conflict (copy our
 *                       content to a .conflict- file, conform to server)
 *   L=R   → fully equal: S=L → nothing; else set S:=L (first sync of an
 *            identical file, or both sides landed the same content)
 *   L≠R   → S=L: server moved, local untouched → download
 *           S=R: local moved, server untouched → push change
 *           else (both moved, or S⊥ never synced): conflict — copy local
 *                content to a .conflict- file, then conform the original
 *                path to the server. S⊥+different deliberately does NOT
 *                attempt a push (the server would reject the base anyway).
 *
 * VERBATIM copy of src/client-mobile/sync/plan-sync.js — test/plan.test.js
 * runs the same vectors as the browser suite so the two never drift.
 */
function planSync(remoteEntries, localHashes, syncedHashes) {
  var local = localHashes || {};
  var synced = syncedHashes || {};
  var remote = {};
  var i;

  for (i = 0; i < remoteEntries.length; i++) {
    remote[remoteEntries[i].path] = remoteEntries[i];
  }

  var plan = {
    downloads: [],
    pushChanges: [],
    pushDeletions: [],
    conflicts: [],
    setSynced: [],
    forgetSynced: [],
    localDeletes: [],
    inSync: 0,
  };

  // Union of all three sides' paths: remote, local, and synced-only (a path
  // present only in S means it vanished from both sides — it must be
  // forgotten, which can only happen if it enters the union here).
  var paths = [];
  var seen = {};
  function addPath(p) {
    if (Object.prototype.hasOwnProperty.call(seen, p)) return;
    seen[p] = true;
    paths.push(p);
  }
  for (i = 0; i < remoteEntries.length; i++) addPath(remoteEntries[i].path);
  var localPaths = Object.keys(local);
  for (i = 0; i < localPaths.length; i++) addPath(localPaths[i]);
  var syncedPaths = Object.keys(synced);
  for (i = 0; i < syncedPaths.length; i++) addPath(syncedPaths[i]);

  for (i = 0; i < paths.length; i++) {
    var path = paths[i];
    var lEntry = Object.prototype.hasOwnProperty.call(local, path) ? local[path] : undefined;
    var rEntry = Object.prototype.hasOwnProperty.call(remote, path) ? remote[path] : undefined;
    var L = lEntry ? lEntry.hash : undefined;
    var R = rEntry ? rEntry.hash : undefined;
    var S = Object.prototype.hasOwnProperty.call(synced, path) ? synced[path] : undefined;

    if (L === undefined && R === undefined) {
      // both sides gone
      if (S !== undefined) plan.forgetSynced.push(path);
      else plan.inSync++;
    } else if (L === undefined) {
      // server-only
      if (S === undefined) {
        plan.downloads.push({ path: path, hash: R, size: rEntry.size });
      } else if (S === R) {
        plan.pushDeletions.push({ path: path, baseHash: S });
      } else {
        plan.conflicts.push({ path: path, hash: R, size: rEntry.size, deleted: false });
      }
    } else if (R === undefined) {
      // local-only
      if (S === undefined) {
        plan.pushChanges.push({ path: path, hash: L, size: lEntry.size, baseHash: null });
      } else if (S === L) {
        plan.localDeletes.push(path);
      } else {
        plan.conflicts.push({ path: path, hash: null, size: 0, deleted: true });
      }
    } else if (L === R) {
      if (S === L) plan.inSync++;
      else plan.setSynced.push({ path: path, hash: L });
    } else if (S === L) {
      plan.downloads.push({ path: path, hash: R, size: rEntry.size });
    } else if (S === R) {
      plan.pushChanges.push({ path: path, hash: L, size: lEntry.size, baseHash: S });
    } else {
      plan.conflicts.push({ path: path, hash: R, size: rEntry.size, deleted: false });
    }
  }

  return plan;
}

// 'dir/note.md' + stamp + n → 'dir/note.conflict-20260926101500[-n].md'
// (identical to run-sync.js's naming — same server, same rules).
function conflictCopyName(path, stamp, n) {
  var slash = path.lastIndexOf('/');
  var dir = slash === -1 ? '' : path.slice(0, slash + 1);
  var name = slash === -1 ? path : path.slice(slash + 1);
  var suffix = '.conflict-' + stamp + (n > 1 ? '-' + n : '');
  var dot = name.lastIndexOf('.');
  if (dot > 0) return dir + name.slice(0, dot) + suffix + name.slice(dot);
  return dir + name + suffix;
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

// Never sync Obsidian's own bookkeeping or dot-folders (same filter the
// browser client's local-manifest applies to .obsidian/.trash).
function isInternalPath(path) {
  var segments = String(path).split('/');
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].charAt(0) === '.') return true;
  }
  return false;
}

function joinUrl(baseUrl, path) {
  var base = String(baseUrl || '').replace(/\/+$/, '');
  return base + path;
}

// Uint8Array/ArrayBuffer → base64, chunked (String.fromCharCode.apply blows
// the arg stack at ~65k bytes — same helper shape as remote-client.js).
function bytesToBase64(buf) {
  var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  var CHUNK = 0x8000;
  var s = '';
  for (var i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// WebCrypto on both platforms (desktop + mobile Obsidian, Node ≥19 for the
// test suite) — deliberately NOT Node's crypto module (mobile has none).
async function sha256Hex(buf) {
  var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  var digest = await crypto.subtle.digest('SHA-256', bytes);
  var view = new Uint8Array(digest);
  var hex = '';
  for (var i = 0; i < view.length; i++) hex += pad(view[i].toString(16), 2);
  return hex;
}

// mpv1.* tokens carry their expiry in the third dot-segment; anything else
// (operator's global SYNC_TOKEN, unknown shapes) is treated as
// non-expiring. Refresh margin: 60s.
function tokenExpired(token) {
  if (typeof token !== 'string' || !token) return true;
  var parts = token.split('.');
  if (parts[0] !== 'mpv1') return false; // operator/global token — no expiry
  if (parts.length !== 4) return true;   // malformed vault token — refresh it
  var exp = Number(parts[2]);
  if (!Number.isFinite(exp)) return true;
  return exp < Date.now() + 60 * 1000;
}

function authError(message) {
  var e = new Error(message);
  e.code = 'EAUTH';
  return e;
}

function pushUnsupported(message) {
  var e = new Error(message);
  e.code = 'EPUSH';
  return e;
}

// ── claimed-URL parsing (mirrors src/client-mobile/starter-url.js) ─────────
// The settings screen has ONE "Vault URL" field: paste the link you claimed
// in the browser — https://app/vault/<name>, the short link https://app/<name>,
// a note deep link under either, or just <name> — and it fills Server URL +
// Vault name. Same name charset as the server's claim endpoint, and the same
// short-link exclusions the web routers 302 on (dot-files, reserved routes),
// so any link that works in the browser works here.

var VAULT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

var RESERVED_ROOT_SEGMENTS = [
  'api', 'sync', 'starter', 'vault', 'mobile',
  'client-mobile', 'obsidian-mobile', 'i18n', 'lib',
  'public', 'sandbox', 'system-plugins', 'index',
];

/**
 * parseVaultUrl(raw) — never throws.
 * → { ok:true, baseUrl:<origin|null>, vault:<name> }  (baseUrl null = keep
 *   the already-configured Server URL; the input carried no origin)
 * → { ok:false, error:<message> }
 */
function parseVaultUrl(raw) {
  var s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return { ok: false, error: 'Enter the vault URL or name.' };

  var baseUrl = null;
  var rest = s;

  var m = /^https?:\/\/[^\/?#\s]+/i.exec(s);
  if (m) {
    // Absolute http(s) URL → origin + remainder (query/hash dropped below).
    baseUrl = m[0].replace(/\/+$/, '');
    rest = s.slice(m[0].length);
  } else if (s.charAt(0) === '/' && s.charAt(1) === '/') {
    return { ok: false, error: 'Enter an http(s) URL or a vault name.' };
  } else if (s.indexOf('/') !== -1 &&
             (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?\//.test(s) || /^localhost(:\d+)?\//i.test(s))) {
    // Scheme-less host prefix ("notes.sarris.dev/vault/x", "localhost:3000/x")
    // — assume https (a local http dev server can still be typed with its
    // scheme, or via the Server URL field). Checked BEFORE the scheme reject
    // below so "localhost:3000/…" isn't mistaken for a "localhost:" scheme.
    var hostPart = s.slice(0, s.indexOf('/'));
    baseUrl = 'https://' + hostPart;
    rest = s.slice(hostPart.length);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    // Any other scheme (obsidian:, javascript:, data:, mailto:, …) — refuse.
    return { ok: false, error: 'Enter an http(s) URL or a vault name.' };
  }

  rest = rest.split('?')[0].split('#')[0];
  rest = rest.replace(/^\/+/, '').replace(/\/+$/, '');

  if (!rest) {
    return { ok: false, error: baseUrl
      ? 'That link has no vault name — paste the /vault/<name> URL.'
      : 'Enter the vault URL or name.' };
  }

  var slash = rest.indexOf('/');
  var first = slash === -1 ? rest : rest.slice(0, slash);
  var tail = slash === -1 ? '' : rest.slice(slash + 1);

  var name;
  var shortLink = false; // name came from a URL path segment → short-link rules
  if (first.toLowerCase() === 'vault' && slash !== -1) {
    // Canonical /vault/<name>[/<note path>] — the note part is irrelevant here.
    var vslash = tail.indexOf('/');
    name = vslash === -1 ? tail : tail.slice(0, vslash);
  } else if (baseUrl) {
    // Single segment or "segment/note…" straight under the origin: the
    // short-link form — accept it only when the web routers would 302 it.
    name = first;
    shortLink = true;
  } else {
    // Relative input ("vault/<name>", "/<name>", "<name>/note", "<name>").
    name = first;
  }

  try { name = decodeURIComponent(name); } catch (_) {
    return { ok: false, error: 'That vault name has bad %-encoding.' };
  }
  if (shortLink) {
    if (name.indexOf('.') !== -1) {
      return { ok: false, error: 'That link looks like a file, not a vault — paste the /vault/<name> URL.' };
    }
    var c0 = name.charAt(0);
    if (c0 === '.' || c0 === '_' || c0 === '~') {
      return { ok: false, error: 'That path is not a vault link.' };
    }
    if (RESERVED_ROOT_SEGMENTS.indexOf(name.toLowerCase()) !== -1) {
      return { ok: false, error: '"' + name + '" is an app route, not a vault name.' };
    }
  }
  if (!VAULT_NAME_RE.test(name)) {
    return { ok: false, error: 'Vault names use letters, numbers, dot, dash or underscore (max 64).' };
  }
  return { ok: true, baseUrl: baseUrl, vault: name };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP via app.requestUrl — the only transport Obsidian gives us that is
// CORS-free on both desktop and mobile. requestUrl's exact non-2xx behavior
// differs across builds (resolve vs. throw), so every call is normalised
// through http() below: callers always get {status, text, json, arrayBuffer}.
// ═══════════════════════════════════════════════════════════════════════════

async function httpOnce(opts) {
  if (!requestUrl) throw new Error('requestUrl is unavailable (not running inside Obsidian)');
  var res;
  try {
    res = await requestUrl(opts);
  } catch (err) {
    if (err && typeof err.status === 'number' && err.status > 0) {
      res = err; // some builds throw the response — normalise instead of failing
    } else {
      throw err;
    }
  }
  var status = res.status;
  var text = typeof res.text === 'string' ? res.text : '';
  var json = res.json;
  if (json === undefined || json === null) {
    if (text) {
      try { json = JSON.parse(text); } catch (_) { json = null; }
    } else {
      json = null;
    }
  }
  var ab = res.arrayBuffer;
  if (typeof ab === 'function') ab = ab.call(res); // tolerate method-style access
  return { status: status, text: text, json: json, arrayBuffer: ab };
}

// Transient-failure retries — the same hardening the browser client's
// remote-client.js got: 3 attempts, only for transport-level throws and
// 429/5xx, exponential backoff with jitter. Every endpoint here is safe to
// re-run: blob GET/PUT are content-addressed (idempotent), commit carries
// baseHash CAS (a double-apply is impossible — the second attempt 409s and
// the normal conflict path handles it), claim is rate-limited anyway.
var HTTP_MAX_ATTEMPTS = 3;
var RETRYABLE_STATUS = { 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };

function sleepMs(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function retryDelayMs(attempt) {
  var base = 400 * Math.pow(2, attempt); // 400ms, 800ms
  return Math.round(base * (0.7 + Math.random() * 0.6)); // ±30% jitter
}

async function http(opts) {
  var lastErr = null;
  var lastRes = null;
  for (var attempt = 0; attempt < HTTP_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleepMs(retryDelayMs(attempt - 1));
    var res;
    try {
      res = await httpOnce(opts);
    } catch (err) {
      lastErr = err; // transport-level (timeout, DNS, reset) → transient
      lastRes = null;
      continue;
    }
    if (RETRYABLE_STATUS[res.status] === 1 && attempt < HTTP_MAX_ATTEMPTS - 1) {
      lastErr = null;
      lastRes = res;
      continue;
    }
    return res;
  }
  // Exhausted: a retryable STATUS is returned raw so callers surface their
  // own message (429 "wait a minute", 503 "not configured"); transport
  // errors throw as before.
  if (lastRes) return lastRes;
  throw lastErr;
}

// ── remote: the /sync/v1 client (mirror of remote-client.js over http()) ───
function createRemote(settings) {
  var baseUrl = settings.baseUrl;
  var token = settings.token;
  var vault = settings.vault;

  function authHeaders(extra) {
    var h = { authorization: 'Bearer ' + token };
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

  function blobUrl(hash, extraQuery) {
    var qs = vaultQuery() + (extraQuery || '');
    return joinUrl(baseUrl, '/sync/v1/blob/' + hash) + (qs ? '?' + qs : '');
  }

  async function manifest(after) {
    var url = joinUrl(baseUrl, '/sync/v1/manifest') +
      '?' + vaultQuery() + (after ? 'after=' + encodeURIComponent(after) : '');
    var res = await http({ url: url, method: 'GET', headers: authHeaders() });
    if (res.status === 401) throw authError('manifest: authentication failed (401)');
    if (res.status !== 200) throw new Error('manifest: HTTP ' + res.status);
    return res.json;
  }

  // Every page, in one {cursor, entries}. Any page error throws — never
  // hand a partial listing to planSync (it would look like mass deletions).
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

  async function blobRanged(hash) {
    var parts = [];
    var start = 0;
    for (;;) {
      var res = await http({
        url: blobUrl(hash, 'start=' + start + '&end=' + (start + RANGE_WINDOW - 1)),
        method: 'GET',
        headers: authHeaders(),
      });
      if (res.status === 416) break;
      if (res.status === 401) throw authError('blob range: authentication failed (401)');
      if (res.status !== 206 && res.status !== 200) {
        throw new Error('blob range: HTTP ' + res.status + ' at offset ' + start);
      }
      var buf = res.arrayBuffer;
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

  async function blob(hash) {
    var res = await http({ url: blobUrl(hash), method: 'GET', headers: authHeaders() });
    if (res.status === 401) throw authError('blob: authentication failed (401)');
    if (res.status === 413) return blobRanged(hash); // server full-GET cap
    if (res.status !== 200) throw new Error('blob: HTTP ' + res.status + ' for hash ' + hash);
    return res.arrayBuffer;
  }

  async function putBlob(hash, bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var total = Math.max(1, Math.ceil(u8.length / UPLOAD_CHUNK));
    for (var i = 0; i < total; i++) {
      var start = i * UPLOAD_CHUNK;
      var slice = u8.subarray(start, Math.min(u8.length, start + UPLOAD_CHUNK));
      var res = await http({
        url: blobUrl(hash),
        method: 'PUT',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          index: i,
          total: total,
          size: u8.length,
          data: bytesToBase64(slice),
        }),
      });
      if (res.status === 401) throw authError('putBlob: authentication failed (401)');
      if (res.status === 501 || res.status === 404) {
        throw pushUnsupported('putBlob: HTTP ' + res.status);
      }
      if (res.status === 409) throw new Error('putBlob: content does not match hash ' + hash);
      if (res.status !== 200) {
        throw new Error('putBlob: HTTP ' + res.status + ' (chunk ' + i + '/' + total + ')');
      }
    }
    return { hash: hash, stored: true };
  }

  async function missingBlobs(hashes) {
    var res = await http({
      url: joinUrl(baseUrl, '/sync/v1/blobs/missing') + (vault ? '?vault=' + encodeURIComponent(vault) : ''),
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ hashes: hashes }),
    });
    if (res.status === 401) throw authError('missingBlobs: authentication failed (401)');
    if (res.status === 501 || res.status === 404) {
      throw pushUnsupported('missingBlobs: HTTP ' + res.status);
    }
    if (res.status !== 200) throw new Error('missingBlobs: HTTP ' + res.status);
    return (res.json && res.json.missing) || [];
  }

  async function commit(changes, deletions) {
    var res = await http({
      url: joinUrl(baseUrl, '/sync/v1/commit') + (vault ? '?vault=' + encodeURIComponent(vault) : ''),
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ changes: changes || [], deletions: deletions || [] }),
    });
    if (res.status === 401) throw authError('commit: authentication failed (401)');
    if (res.status === 501 || res.status === 404) throw pushUnsupported('commit: HTTP ' + res.status);
    if (res.status === 422) {
      var e = new Error('commit: blobs missing on server');
      e.code = 'EMISSING';
      e.hashes = (res.json && res.json.hashes) || [];
      throw e;
    }
    if (res.status !== 200) throw new Error('commit: HTTP ' + res.status);
    return res.json;
  }

  return {
    manifestAll: manifestAll,
    blob: blob,
    putBlob: putBlob,
    missingBlobs: missingBlobs,
    commit: commit,
  };
}

// Claim/unlock (POST) and status (GET) don't need a token — the password
// IS the credential, and status is public by design (the web gate needs it
// before any password is known).
async function vaultStatus(settings) {
  var url = joinUrl(settings.baseUrl, '/sync/v1/vaults/' + encodeURIComponent(settings.vault));
  var res = await http({ url: url, method: 'GET', headers: { 'cache-control': 'no-store' } });
  if (res.status === 503) throw new Error('server not configured (503)');
  if (res.status !== 200) throw new Error('vault status: HTTP ' + res.status);
  return res.json; // {name, claimed}
}

async function claimOrUnlock(settings) {
  var url = joinUrl(settings.baseUrl, '/sync/v1/vaults/' + encodeURIComponent(settings.vault));
  var res = await http({
    url: url,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: settings.password }),
  });
  if (res.status === 401) throw authError('wrong password (401)');
  if (res.status === 429) throw new Error('too many attempts — wait a minute');
  if (res.status === 400) {
    throw new Error((res.json && res.json.error) || 'bad password request (400)');
  }
  if (res.status === 503) throw new Error('server not configured (503)');
  if (res.status !== 200 && res.status !== 201) {
    throw new Error('claim/unlock: HTTP ' + res.status);
  }
  if (!res.json || !res.json.token) throw new Error('no token in server response');
  return res.json.token;
}

// ═══════════════════════════════════════════════════════════════════════════
// The plugin.
// ═══════════════════════════════════════════════════════════════════════════

var DEFAULTS = {
  baseUrl: '',
  vault: '',
  password: '',
  token: '',
  intervalMinutes: 0, // 0 = manual sync only
  synced: {},         // S: {path: hash} — last-synced hashes (CAS bases)
  mirror: {},         // {path: {hash, mtime, size}} — skip re-hashing
};

var NeonSyncPlugin = class extends PluginBase {
  async onload() {
    await this.loadSettings();
    this.syncing = false;

    this.addRibbonIcon('refresh-cw', 'Neon sync', () => {
      this.doSync();
    });
    this.addCommand({
      id: 'neon-sync-now',
      name: 'Sync now',
      callback: () => this.doSync(),
    });
    this.addCommand({
      id: 'neon-pull-only',
      name: 'Pull only (download server changes, no push)',
      callback: () => this.doSync(false, true),
    });
    this.addSettingTab(new NeonSyncSettingTab(this.app, this));
    this.startInterval();
  }

  onunload() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async loadSettings() {
    var data = (await this.loadData()) || {};
    this.settings = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && data[k] !== undefined) {
        this.settings[k] = data[k];
      } else {
        this.settings[k] = (typeof DEFAULTS[k] === 'object' && DEFAULTS[k] !== null)
          ? JSON.parse(JSON.stringify(DEFAULTS[k]))
          : DEFAULTS[k];
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  startInterval() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    var mins = Number(this.settings.intervalMinutes) || 0;
    if (mins > 0) {
      this._timer = setInterval(() => { this.doSync(true); }, mins * 60 * 1000);
      this.registerInterval(this._timer);
    }
  }

  // A usable mpv1 token for the configured vault: reuse the stored one until
  // it nears expiry, otherwise exchange the password for a fresh one.
  async ensureToken() {
    var s = this.settings;
    if (!s.baseUrl || !s.vault) {
      throw new Error('set the server URL and vault name in settings first');
    }
    if (s.token && !tokenExpired(s.token)) return s.token;
    if (!s.password) {
      throw new Error('no valid token — enter the vault password in settings and Connect');
    }
    s.token = await claimOrUnlock(s);
    await this.saveSettings();
    return s.token;
  }

  async connect() {
    var s = this.settings;
    if (!s.baseUrl || !s.vault) throw new Error('server URL and vault name are required');
    if (!s.password) throw new Error('password is required');
    s.token = await claimOrUnlock(s);
    await this.saveSettings();
    return s.token;
  }

  async doSync(silent, pullOnly) {
    if (this.syncing) return { skipped: true, reason: 'busy' };
    if (!silent) new Notice(pullOnly ? 'Neon sync: pulling…' : 'Neon sync: starting…');
    this.syncing = true;
    try {
      var summary = await this.runSync(pullOnly);
      new Notice('Neon sync: ↓ ' + summary.downloaded + ' ↑ ' + summary.pushed +
        ' deletions ' + summary.deleted +
        (summary.conflicts ? ' · conflicts ' + summary.conflicts : '') +
        (pullOnly ? ' (pull only)' : '') +
        (summary.pushSupported === false ? ' (server is pull-only)' : ''));
      return summary;
    } catch (err) {
      // A 401 on a stored vault token means the server no longer honours it
      // (revoked/rotated): drop it so the next sync re-unlocks via password.
      if (err && err.code === 'EAUTH' && this.settings.token && this.settings.token.indexOf('mpv1.') === 0) {
        this.settings.token = '';
        try { await this.saveSettings(); } catch (_) { /* notice below matters more */ }
      }
      console.error('[neon-sync] failed:', err);
      new Notice('Neon sync failed: ' + ((err && err.message) || err));
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  async runSync(pullOnly) {
    var s = this.settings;
    var app = this.app;
    await this.ensureToken();

    var remote = createRemote(s);
    this._activeRemote = remote;
    try {
      return await this.runSyncWith(remote, pullOnly);
    } finally {
      this._activeRemote = null;
    }
  }

  async runSyncWith(remote, pullOnly) {
    var s = this.settings;
    var app = this.app;
    var ctx = {
      stamp: stampNow(),
      pullOnly: !!pullOnly,
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

    var remoteManifest = await remote.manifestAll();

    // Local state: hash every file (or reuse the mirror when mtime+size are
    // unchanged — the common case: only edited files cost a read).
    var localHashes = {};
    var mirror = s.mirror;
    var files = app.vault.getFiles();
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (isInternalPath(f.path)) continue;
      var cached = mirror[f.path];
      var hash;
      if (cached && cached.mtime === f.stat.mtime && cached.size === f.stat.size) {
        hash = cached.hash;
      } else {
        var bytes = await app.vault.readBinary(f);
        hash = await sha256Hex(bytes);
        mirror[f.path] = { hash: hash, mtime: f.stat.mtime, size: f.stat.size };
      }
      localHashes[f.path] = { hash: hash, size: f.stat.size };
    }
    // Prune mirror entries for files that no longer exist.
    var mirrorPaths = Object.keys(mirror);
    for (var mp = 0; mp < mirrorPaths.length; mp++) {
      if (!Object.prototype.hasOwnProperty.call(localHashes, mirrorPaths[mp])) {
        delete mirror[mirrorPaths[mp]];
      }
    }

    var plan = planSync(remoteManifest.entries, localHashes, s.synced);

    // ── pull ──────────────────────────────────────────────────────────────
    for (var d = 0; d < plan.downloads.length; d++) {
      var dl = plan.downloads[d];
      var buf = await remote.blob(dl.hash);
      await this.writeVaultBytes(dl.path, buf);
      s.synced[dl.path] = dl.hash;
      await this.rememberFile(dl.path);
      ctx.summary.downloaded++;
    }

    // bookkeeping — no network needed
    for (var ss = 0; ss < plan.setSynced.length; ss++) {
      s.synced[plan.setSynced[ss].path] = plan.setSynced[ss].hash;
    }
    for (var fs2 = 0; fs2 < plan.forgetSynced.length; fs2++) {
      delete s.synced[plan.forgetSynced[fs2]];
    }
    for (var ld = 0; ld < plan.localDeletes.length; ld++) {
      await this.deleteVaultPath(plan.localDeletes[ld]);
      ctx.summary.skipped++;
    }

    // ── conflicts known before pushing (server state from the manifest) ──
    for (var pc = 0; pc < plan.conflicts.length; pc++) {
      await this.resolveConflict(ctx, plan.conflicts[pc].path, plan.conflicts[pc]);
    }

    // ── push ──────────────────────────────────────────────────────────────
    // Skipped entirely in pull-only mode: pushChanges/pushDeletions simply
    // stay unapplied (synced/mirror were not touched for them), so the next
    // full sync picks them up.
    if (!pullOnly) {
      try {
        await this.pushOps(ctx, plan.pushChanges, plan.pushDeletions);
        for (var lc = 0; lc < ctx.lateConflicts.length; lc++) {
          await this.resolveConflict(ctx, ctx.lateConflicts[lc].path, ctx.lateConflicts[lc]);
        }
        if (ctx.pushSupported && ctx.copyChanges.length > 0) {
          await this.pushOps(ctx, ctx.copyChanges, []);
        }
      } catch (e) {
        if (e && e.code === 'EPUSH') {
          ctx.pushSupported = false; // old pull-only server
        } else {
          throw e;
        }
      }
    }
    ctx.summary.pushSupported = ctx.pushSupported;
    ctx.summary.skipped += plan.inSync + plan.setSynced.length + plan.forgetSynced.length;

    await this.saveSettings();
    return ctx.summary;
  }

  // After a pull write, refresh the mirror from the (now-current) TFile so
  // the next sync doesn't re-hash what we just wrote.
  async rememberFile(path) {
    var tf = this.app.vault.getAbstractFileByPath(path);
    if (tf) {
      this.settings.mirror[path] = { hash: this.settings.synced[path], mtime: tf.stat.mtime, size: tf.stat.size };
    }
  }

  async ensureFolder(dir) {
    if (!dir) return;
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    var slash = dir.lastIndexOf('/');
    if (slash !== -1) await this.ensureFolder(dir.slice(0, slash));
    try {
      await this.app.vault.createFolder(dir);
    } catch (_) { /* raced with another writer — fine */ }
  }

  async writeVaultBytes(path, buf) {
    path = normalizePath(path);
    var slash = path.lastIndexOf('/');
    if (slash !== -1) await this.ensureFolder(path.slice(0, slash));
    var existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      await this.app.vault.modifyBinary(existing, buf);
    } else {
      await this.app.vault.createBinary(path, buf);
    }
  }

  async deleteVaultPath(path) {
    var existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (existing) {
      try {
        await this.app.vault.delete(existing, true);
      } catch (_) { /* already gone — conforming is idempotent */ }
    }
    delete this.settings.synced[path];
    delete this.settings.mirror[path];
  }

  async uniqueCopyPath(path, stamp) {
    for (var n = 1; n <= 99; n++) {
      var candidate = conflictCopyName(path, stamp, n);
      var exists = await this.app.vault.adapter.exists(normalizePath(candidate));
      if (!exists) return candidate;
    }
    return conflictCopyName(path, stamp, Date.now());
  }

  // Server wins at the ORIGINAL path; our content survives as a
  // .conflict-<stamp> copy (queued for push as a brand-new path).
  async resolveConflict(ctx, path, server) {
    path = normalizePath(path);
    var localBytes = null;
    var existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      try {
        localBytes = await this.app.vault.readBinary(existing);
      } catch (_) {
        localBytes = null;
      }
    }

    if (localBytes) {
      var copyPath = await this.uniqueCopyPath(path, ctx.stamp);
      await this.writeVaultBytes(copyPath, localBytes);
      if (copyPath.length <= MAX_PUSHABLE_PATH) {
        var copyHash = await sha256Hex(localBytes);
        ctx.copyChanges.push({ path: copyPath, hash: copyHash, size: localBytes.byteLength, baseHash: null });
        if (!ctx.pullOnly) {
          // Mark the copy synced ONLY when this run will push it. In a
          // pull-only run the copy must stay S⊥ so the NEXT full sync pushes
          // it as a new file (S=hash + server⊥ would read as "server deleted
          // it, conform" and remove the preserved copy).
          this.settings.synced[copyPath] = copyHash;
          await this.rememberFile(copyPath);
        }
      }
    }

    if (server.deleted || !server.hash) {
      await this.deleteVaultPath(path);
    } else {
      var buf = await this._activeRemote.blob(server.hash);
      await this.writeVaultBytes(path, buf);
      this.settings.synced[path] = server.hash;
      await this.rememberFile(path);
    }

    ctx.summary.conflicts++;
    ctx.summary.conflictPaths.push(path);
  }

  // Upload + commit one set of push operations. Mutates synced/summary on
  // success; CAS conflicts land in ctx.lateConflicts (their copies need a
  // SECOND push round). Throws EPUSH/EAUTH upward.
  async pushOps(ctx, changes, deletions) {
    if (changes.length === 0 && deletions.length === 0) return;
    var s = this.settings;
    var remote = this._activeRemote;

    // Read + re-hash every change: the vault may have moved since the scan
    // (Obsidian editing mid-sync) — a vanished or re-hashed file is dropped
    // from THIS round rather than pushing content we no longer vouch for.
    var ready = [];
    for (var i = 0; i < changes.length; i++) {
      var ch = changes[i];
      var existing = this.app.vault.getAbstractFileByPath(normalizePath(ch.path));
      if (!existing) continue;
      var bytes;
      try {
        bytes = await this.app.vault.readBinary(existing);
      } catch (_) {
        continue;
      }
      var h = await sha256Hex(bytes);
      if (h !== ch.hash) continue;
      ready.push({ change: ch, hash: h, bytes: bytes });
    }

    // Upload only what the server lacks.
    if (ready.length > 0) {
      var want = [];
      var seen = {};
      for (var r = 0; r < ready.length; r++) {
        if (!seen[ready[r].hash]) {
          seen[ready[r].hash] = true;
          want.push(ready[r].hash);
        }
      }
      var missing = await remote.missingBlobs(want); // may throw EPUSH
      var missingSet = {};
      for (var m = 0; m < missing.length; m++) missingSet[missing[m]] = true;
      for (var u = 0; u < ready.length; u++) {
        if (missingSet[ready[u].hash]) {
          await remote.putBlob(ready[u].hash, ready[u].bytes);
        }
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
      var batchChanges = readyChanges.slice(idx, idx + COMMIT_MAX_OPS);
      var batchDeletions = deletions.slice(idx, idx + COMMIT_MAX_OPS);
      idx += COMMIT_MAX_OPS;

      var res;
      try {
        res = await remote.commit(batchChanges, batchDeletions);
      } catch (e) {
        if (e && e.code === 'EMISSING') {
          // A blob vanished between missing-check and commit — upload and
          // retry once (same recovery as run-sync.js).
          for (var em = 0; em < e.hashes.length; em++) {
            var need = e.hashes[em];
            if (bytesByHash[need]) await remote.putBlob(need, bytesByHash[need]);
          }
          res = await remote.commit(batchChanges, batchDeletions);
        } else {
          throw e;
        }
      }

      for (var a = 0; a < ((res && res.applied) || []).length; a++) {
        var path = res.applied[a];
        if (changedSet[path]) {
          s.synced[path] = findHash(readyChanges, path);
          ctx.summary.pushed++;
        } else if (deletedSet[path]) {
          delete s.synced[path];
          delete s.mirror[path];
          ctx.summary.deleted++;
        }
      }
      var conflicts = (res && res.conflicts) || [];
      for (var f = 0; f < conflicts.length; f++) ctx.lateConflicts.push(conflicts[f]);
    }
  }
};

function findHash(changes, path) {
  for (var i = 0; i < changes.length; i++) {
    if (changes[i].path === path) return changes[i].hash;
  }
  return null;
}

// ── settings tab ────────────────────────────────────────────────────────────
class NeonSyncSettingTab extends PluginSettingTabBase {
  display() {
    var _this = this;
    var plugin = this.plugin;
    var s = plugin.settings;
    var el = this.containerEl;
    el.empty();

    new Setting(el)
      .setName('Markport Neon Sync' + (plugin.manifest && plugin.manifest.version ? ' v' + plugin.manifest.version : ''))
      .setDesc('Bidirectional sync with a Markport /sync/v1 server (Neon Postgres on Vercel).');

    // ── Claimed URL: paste the link from the browser; parseVaultUrl (same
    // rules as the web app's starter-url.js) fills the two fields below ────
    var URL_DESC = 'Paste your claimed link — https://app/vault/<name>, the short https://app/<name>, or a note deep link — and Server URL + Vault name fill in automatically.';
    var baseUrlText = null;
    var vaultText = null;
    var urlField = new Setting(el)
      .setName('Vault URL')
      .setDesc(URL_DESC)
      .addText(function (t) {
        t.setPlaceholder('https://notes.sarris.dev/vault/myvault')
          .onChange(function (v) {
            var raw = String(v === null || v === undefined ? '' : v).trim();
            if (!raw) { urlField.setDesc(URL_DESC); return; }
            var parsed = parseVaultUrl(raw);
            if (!parsed.ok) {
              urlField.setDesc(URL_DESC + ' ⚠ ' + parsed.error);
              return;
            }
            if (parsed.baseUrl) {
              s.baseUrl = parsed.baseUrl;
              if (baseUrlText) baseUrlText.setValue(s.baseUrl);
            }
            s.vault = parsed.vault;
            if (vaultText) vaultText.setValue(s.vault);
            plugin.saveSettings();
            urlField.setDesc(URL_DESC + ' ✓ ' + (s.baseUrl || '(set Server URL below)') +
              ' · vault "' + s.vault + '" — enter the password and press Connect.');
          });
      });

    new Setting(el)
      .setName('Server URL')
      .setDesc('Origin of the deployment, e.g. https://notes.sarris.dev')
      .addText(function (t) {
        baseUrlText = t;
        t.setPlaceholder('https://notes.sarris.dev')
          .setValue(s.baseUrl)
          .onChange(async function (v) {
            s.baseUrl = v.trim().replace(/\/+$/, '');
            await plugin.saveSettings();
          });
      });

    new Setting(el)
      .setName('Vault name')
      .setDesc('The vault id on the server (a-z 0-9 . _ -, up to 64 chars) — the name in /vault/<name> links.')
      .addText(function (t) {
        vaultText = t;
        t.setValue(s.vault)
          .onChange(async function (v) {
            s.vault = v.trim();
            await plugin.saveSettings();
          });
      });

    new Setting(el)
      .setName('Password')
      .setDesc('Claim/unlock password. Stored in this plugin\'s data.json so tokens can refresh; leave empty to use a manually pasted token only.')
      .addText(function (t) {
        t.setInputType('password')
          .setValue(s.password)
          .onChange(async function (v) {
            s.password = v;
            await plugin.saveSettings();
          });
      });

    new Setting(el)
      .setName('Token')
      .setDesc('Advanced: paste a bearer token directly (mpv1 vault token or the operator SYNC_TOKEN). "Connect" overwrites it.')
      .addText(function (t) {
        t.setValue(s.token)
          .onChange(async function (v) {
            s.token = v.trim();
            await plugin.saveSettings();
          });
      });

    var status = new Setting(el)
      .setName('Status')
      .setDesc(_this.statusText());
    status.addButton(function (b) {
      b.setButtonText('Check').onClick(async function () {
        b.setDisabled(true);
        try {
          var info = await vaultStatus(s);
          status.setDesc((info.claimed ? 'claimed' : 'UNCLAIMED — Connect will claim it') +
            ' · token ' + (tokenExpired(s.token) ? 'missing/expired' : 'valid'));
        } catch (err) {
          status.setDesc('error: ' + ((err && err.message) || err));
        } finally {
          b.setDisabled(false);
        }
      });
    });
    status.addButton(function (b) {
      b.setButtonText('Connect').setCta().onClick(async function () {
        b.setDisabled(true);
        try {
          await plugin.connect();
          status.setDesc(_this.statusText());
          new Notice('Neon sync: connected, token saved');
        } catch (err) {
          new Notice('Neon sync: ' + ((err && err.message) || err));
        } finally {
          b.setDisabled(false);
        }
      });
    });
    status.addButton(function (b) {
      b.setButtonText('Sync now').onClick(async function () {
        b.setDisabled(true);
        try {
          await plugin.doSync();
        } catch (_) { /* Notice already shown */ } finally {
          b.setDisabled(false);
        }
      });
    });
    status.addButton(function (b) {
      b.setButtonText('Pull').onClick(async function () {
        b.setDisabled(true);
        try {
          await plugin.doSync(false, true);
        } catch (_) { /* Notice already shown */ } finally {
          b.setDisabled(false);
        }
      });
    });

    new Setting(el)
      .setName('Auto-sync interval (minutes)')
      .setDesc('0 = manual only (command palette / ribbon / settings button).')
      .addText(function (t) {
        t.setValue(String(s.intervalMinutes)).onChange(async function (v) {
          var n = parseInt(v, 10);
          s.intervalMinutes = Number.isFinite(n) && n > 0 ? n : 0;
          await plugin.saveSettings();
          plugin.startInterval();
        });
      });
  }

  statusText() {
    var s = this.plugin.settings;
    if (!s.baseUrl || !s.vault) return 'not configured yet';
    var tokenState = !s.token ? 'no token' : (tokenExpired(s.token) ? 'token expired' : 'token valid');
    return 'vault "' + s.vault + '" at ' + s.baseUrl + ' · ' + tokenState;
  }
}

// Node test hook (see test/plan.test.js): in Obsidian the export is the
// plugin class itself, as required by the plugin loader.
NeonSyncPlugin.planSync = planSync;
NeonSyncPlugin.conflictCopyName = conflictCopyName;
NeonSyncPlugin.isInternalPath = isInternalPath;
NeonSyncPlugin.tokenExpired = tokenExpired;
NeonSyncPlugin.sha256Hex = sha256Hex;
NeonSyncPlugin.bytesToBase64 = bytesToBase64;
NeonSyncPlugin.parseVaultUrl = parseVaultUrl;

module.exports = NeonSyncPlugin;
