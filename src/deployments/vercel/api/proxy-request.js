// Vercel port of src/deployments/cloudflare/proxy-worker.js — outbound HTTP
// proxy for requests Obsidian initiates via ipcRenderer.send("request-url",
// ...). The browser cannot make these directly because external servers
// (releases.obsidian.md, GitHub) don't send CORS headers; capacitor-shim.js
// intercepts those and forwards them here.
//
// POST /api/proxy-request
// Body:     { url, method, headers, contentType, body, binary }
// Response: { status, headers (lowercase), body } — body is ALWAYS base64
//           (matches capacitor-shim.js, which expects base64 always).
//
// Keep the allow-list, SSRF guard and redirect rules in sync with the
// Cloudflare worker — that file is the reference implementation; this is a
// runtime port only (no Cache API, no ctx, Vercel's client-IP header).
//
// Differences vs the Worker version:
//   - no Cache API: Node has no `caches.default`. Plugin downloads are
//     cached by the browser/CDN for immutable raw URLs anyway; skipping the
//     edge cache trades a little origin traffic for a lot less state.
//   - client IP comes from lib/client-ip.js (platform headers first, last
//     forwarded hop last) instead of CF-Connecting-IP.

import { toNodeHandler } from '../lib/adapter.js';
import { clientIp } from '../lib/client-ip.js';
import { withErrors } from '../lib/http.js';

const ALLOWED_HOSTS = new Set([
  'releases.obsidian.md',
  'raw.githubusercontent.com',
  'api.github.com',
  'github.com',
  'forum.obsidian.md',
  'obsidian.md',
  // Templater uses this:
  'templater-unsplash-2.fly.dev',
]);

export function isAllowed(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    if (ALLOWED_HOSTS.has(hostname)) return true;
    // Allow any subdomain of allowed roots.
    if (hostname.endsWith('.obsidian.md')) return true;
    if (hostname.endsWith('.github.com')) return true;
    if (hostname.endsWith('.githubusercontent.com')) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function bytesToB64(arrBuf) {
  const bytes = new Uint8Array(arrBuf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

// ── rate limiting (docs/plans/client-only-resilience.md §3.3) ──────────────
// In-memory, instance-lifetime counter — same design and limits as the CF
// worker (30 requests/minute per IP), because Vercel functions have no
// platform rate-limiter we can lean on here either. Best-effort abuse
// damper, not a quota.
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_ENTRIES = 10000;
const rateLimitMap = new Map();

export function __resetRateLimit() {
  rateLimitMap.clear();
}

export function __getRateLimitMapSizeForTest() {
  return rateLimitMap.size;
}

function pruneExpiredRateLimitEntries(now) {
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(key);
  }
}

// Missing IP bypasses the limiter (tests, and any proxy that strips it) —
// same reasoning as proxy-worker.js: a shared bucket would throttle
// unrelated callers together.
function checkRateLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      pruneExpiredRateLimitEntries(now);
    }
    // Never evict a live (non-expired) entry to make room — drop this
    // request's tracking instead, so memory stays bounded and a throttled
    // IP can't buy itself a reset by filling the map.
    if (rateLimitMap.size < RATE_LIMIT_MAX_ENTRIES) {
      rateLimitMap.set(ip, { count: 1, windowStart: now });
    }
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_PER_MINUTE;
}

export async function handleProxy(request) {
  // Cheapest check first — before parsing the body.
  if (!checkRateLimit(clientIp(request))) {
    return json({ error: 'rate limit exceeded' }, 429, {
      'retry-after': String(RATE_LIMIT_WINDOW_MS / 1000),
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (_) {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const { url, method = 'GET', headers = {}, contentType, body, binary } = payload || {};

  if (!url || typeof url !== 'string') return json({ error: 'url required' }, 400);
  if (!isAllowed(url)) return json({ error: 'host not allowed' }, 403);

  let resp;
  try {
    // finding 2: any network failure → 502 (capacitor-shim throws when
    // !pr.ok), never an unhandled function crash.
    let cur = url;
    let m = method;
    const hdrs = { 'User-Agent': 'Obsidian/1.12.7', ...headers };
    if (contentType) hdrs['Content-Type'] = contentType;
    // Forbidden/framing headers must not reach fetch (Node hangs or errors
    // on a caller-supplied Content-Length/Transfer-Encoding).
    const FORBIDDEN = ['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'expect'];
    for (const k of Object.keys(hdrs)) {
      if (FORBIDDEN.indexOf(k.toLowerCase()) !== -1) delete hdrs[k];
    }
    let reqBody = body ? (binary ? b64ToBytes(body) : body) : undefined;

    for (let i = 0; i < 6; i++) {
      resp = await fetch(cur, { method: m, headers: hdrs, body: reqBody, redirect: 'manual' });
      if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location') && i < 5) {
        const next = new URL(resp.headers.get('location'), cur).toString();
        // SSRF guard: the redirect target must ALSO be allow-listed (GitHub's
        // release CDN is covered by .githubusercontent.com; an internal or
        // metadata host is refused).
        if (!isAllowed(next)) return json({ error: 'redirect to disallowed host blocked' }, 502);
        if (new URL(next).hostname !== new URL(cur).hostname) {
          delete hdrs.authorization;
          delete hdrs.Authorization;
          delete hdrs.cookie;
          delete hdrs.Cookie;
        }
        if (resp.status === 303) {
          m = 'GET';
          reqBody = undefined; // see-other: the follow-up must be a bodyless GET
        }
        cur = next;
        continue;
      }
      break;
    }
  } catch (err) {
    return json({ error: (err && err.message) || 'fetch failed' }, 502);
  }

  const buf = await resp.arrayBuffer();
  const outHeaders = {};
  for (const [k, v] of resp.headers) outHeaders[k.toLowerCase()] = v;
  return json(
    { status: resp.status, headers: outHeaders, body: bytesToB64(buf) },
    200
  );
}

export const web = withErrors(handleProxy);
export default toNodeHandler(web);
