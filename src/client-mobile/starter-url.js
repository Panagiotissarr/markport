/**
 * starter-url.js — pure helpers for the two URL entry points:
 *
 *  1. `parseVaultUrlInput(raw)` — the /starter screen is a single
 *     "Enter URL" box. The typed value can be:
 *       - a bare vault name            ("myvault")        → { kind:'name' }
 *       - an absolute http(s) URL      ("https://h/vault/myvault") → { kind:'url' }
 *       - an absolute path             ("/vault/myvault/Note") → { kind:'path' }
 *       - host-prefixed / vault-prefixed forms ("h/vault/myvault",
 *         "/vault/myvault") — normalized down to name (+ optional note path)
 *       - anything else                → { kind:'error', error }
 *     boot.js decides WHERE each kind navigates (a 'name' first checks the
 *     local vault registry, so a vault created with a uuid id still opens
 *     when its NAME is typed).
 *
 *  2. `shortPathSegment(pathname)` — "/{VAULT_NAME} goes to
 *     /vault/{VAULT_NAME}". Returns the single-segment candidate for the
 *     redirect, or null when the path must NOT be treated as a vault name:
 *     anything with more than one segment, anything containing a dot (real
 *     files: app.css, sw.js, manifest.webmanifest…), anything starting with
 *     '.'/'_'/'~', reserved app routes/dirs, and anything that fails the
 *     vault-name rule. The same rule is duplicated (deliberately, each in
 *     its own runtime) by the server-side routers that must answer these
 *     paths with the app shell or a redirect: runtime-server's `/:name`
 *     route, the Cloudflare Worker, vercel.json's redirect, and vercel's
 *     dev.js — keep the RESERVED list below in sync with those.
 *
 * No browser/DOM deps — runs under node:test and inside the browser via a
 * plain <script> tag (attaches to window.__owStarterUrl), same pattern as
 * vault-root-path.js / bootstrap-lookup.js.
 */
(function () {
  'use strict';

  // Same rule the claim/unlock endpoints enforce server-side
  // (src/deployments/vercel/lib/validate.js) and boot.js's vault gate used
  // before this module existed.
  var OW_VAULT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

  // Root-level segments that are app routes or asset directories, never a
  // vault name. Dot-less single segments ONLY need this list — files
  // (app.css, worker.js, sw.js, manifest.webmanifest, example-vault.json…)
  // are already excluded by the dot rule in shortPathSegment.
  var RESERVED_ROOT_SEGMENTS = [
    'api', 'sync', 'starter', 'vault', 'mobile',
    'client-mobile', 'obsidian-mobile', 'i18n', 'lib',
    'public', 'sandbox', 'system-plugins', 'index',
  ];

  function isReservedSegment(seg) {
    return RESERVED_ROOT_SEGMENTS.indexOf(seg.toLowerCase()) !== -1;
  }

  /**
   * '/myvault' → 'myvault'; '/myvault/' → 'myvault'; everything else → null.
   */
  function shortPathSegment(pathname) {
    if (typeof pathname !== 'string') return null;
    var m = pathname.match(/^\/([^/]+)\/?$/);
    if (!m) return null;
    var seg = m[1];
    try { seg = decodeURIComponent(seg); } catch (_) { return null; }
    if (!seg) return null;
    if (seg.indexOf('.') !== -1) return null;           // a file, not a vault
    var c0 = seg.charAt(0);
    if (c0 === '.' || c0 === '_' || c0 === '~') return null;
    if (isReservedSegment(seg)) return null;
    if (!OW_VAULT_NAME_RE.test(seg)) return null;       // spaces, unicode, …
    return seg;
  }

  var NAME_ERROR = 'Use letters, numbers, dot, dash or underscore (max 64).';
  var EMPTY_ERROR = 'Enter a vault URL or name.';

  /**
   * Parse the /starter input. Never throws.
   * → { kind:'url',  url }   absolute http(s) URL — navigate verbatim
   * → { kind:'path', url, name }  same-site path (may carry a note deep
   *                                 link) — normalized to /vault/<name>[/…]
   * → { kind:'name', name }  bare vault name
   * → { kind:'error', error }
   */
  function parseVaultUrlInput(raw) {
    var s = String(raw === null || raw === undefined ? '' : raw).trim();
    if (!s) return { kind: 'error', error: EMPTY_ERROR };

    // Absolute http(s) URL → go there exactly (same-origin links included —
    // the browser lands on the same routes it would via the parse below).
    if (/^https?:\/\//i.test(s)) return { kind: 'url', url: s };
    // Any other scheme (javascript:, data:, obsidian:, …) — refuse.
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      return { kind: 'error', error: 'Enter an http(s) URL or a vault name.' };
    }
    // Protocol-relative ("//host/…") — refuse (would leave the origin).
    if (s.charAt(0) === '/' && s.charAt(1) === '/') {
      return { kind: 'error', error: 'Enter an http(s) URL or a vault name.' };
    }

    // Strip a pasted origin and leading slashes: "host/vault/foo" and
    // "/vault/foo" both reduce to "foo" (+ optional note path). A
    // scheme-less host prefix is only stripped when the familiar "vault/"
    // route follows it — a bare first segment could itself be a legitimate
    // vault name (dots are allowed in names), so we don't guess further.
    s = s.replace(/^\/+/, '');
    s = s.replace(/^[^/]*\.[^/]*\/(?=vault\/)/i, '');
    s = s.replace(/^vault\//i, '');
    s = s.replace(/\/+$/, '');
    if (!s) return { kind: 'error', error: EMPTY_ERROR };

    var slash = s.indexOf('/');
    var name = slash === -1 ? s : s.slice(0, slash);
    var rest = slash === -1 ? '' : s.slice(slash + 1);
    if (!OW_VAULT_NAME_RE.test(name)) {
      return { kind: 'error', error: NAME_ERROR };
    }
    if (rest) {
      // Note deep link — keep the remaining segments verbatim (they are
      // path segments, already percent-encoded as typed/pasted).
      return { kind: 'path', name: name, url: '/vault/' + encodeURIComponent(name) + '/' + rest };
    }
    return { kind: 'name', name: name };
  }

  var api = {
    parseVaultUrlInput: parseVaultUrlInput,
    shortPathSegment: shortPathSegment,
    isReservedSegment: isReservedSegment,
    OW_VAULT_NAME_RE: OW_VAULT_NAME_RE,
    RESERVED_ROOT_SEGMENTS: RESERVED_ROOT_SEGMENTS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.__owStarterUrl = api;
  }
})();
