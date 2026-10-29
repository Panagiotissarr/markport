// obsidian-web — Cloudflare deployment (browser file system / OPFS only).
//
// Vaults live ENTIRELY in the browser (OPFS). There is NO server-side vault
// storage here: the previous Durable Object `VaultDO` (which stored vault
// files server-side and handled /api/fs/*) has been removed on purpose — this
// deployment is client-only. The vault, its files, and all FS operations
// happen in the browser via the OpfsStore engine.
//
// /api/proxy-request IS handled here (Worker edge route + Cache API — see
// proxy-worker.js) so community-plugin downloads work: GitHub/obsidian.md
// don't send CORS headers, so the browser can't fetch them directly.
//
// FOLLOW-UP (per "add the other options later"): port the Node server's
//   • /api/system-plugins        (seed manifest)
//   • /api/system-plugin-file    (seed bytes — src/runtime-server/server/api/system-plugin-files.js)
// to Worker routes. Not needed today — cf-mobile-seed already ships a static
// fallback (public/system-plugins/*) for both. Recommended env for CF:
// SYSTEM_PLUGINS_SEED_DISABLED="obsidian-livesync" (LiveSync pre-installed
// but disabled).

import { handleProxy } from './proxy-worker.js';

// /{VAULT_NAME} short-link rule — mirror of src/client-mobile/starter-url.js's
// shortPathSegment (the client-side twin, which covers the offline
// service-worker fallback), the runtime-server's /:name route, and
// vercel.json's redirect. Single segment, no dot (real files must keep
// 404-ing through ASSETS, not become vaults), no leading '.'/'_'/'~', not a
// reserved app route/asset dir, vault-name charset. The build only copies
// this worker + proxy-worker.js into _worker.js/, so the helper is inline
// here rather than imported — KEEP THE FOUR COPIES IN SYNC.
const RESERVED_ROOT_SEGMENTS = ['api', 'sync', 'starter', 'vault', 'mobile',
  'client-mobile', 'obsidian-mobile', 'i18n', 'lib', 'public', 'sandbox',
  'system-plugins', 'index'];
const VAULT_SHORT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
function vaultShortName(pathname) {
  const m = pathname.match(/^\/([^/]+)\/?$/);
  if (!m) return null;
  let seg = m[1];
  try { seg = decodeURIComponent(seg); } catch { return null; }
  if (!seg || seg.includes('.')) return null;
  const c0 = seg.charAt(0);
  if (c0 === '.' || c0 === '_' || c0 === '~') return null;
  if (RESERVED_ROOT_SEGMENTS.includes(seg.toLowerCase())) return null;
  if (!VAULT_SHORT_NAME_RE.test(seg)) return null;
  return seg;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/proxy-request' && request.method === 'POST') {
      return handleProxy(request, ctx);
    }
    if (request.method === 'GET' &&
        (url.pathname === '/starter' || url.pathname.startsWith('/vault/'))) {
      // fetch את ה-root shell '/' (200) — לא '/index.html' (finding 2: html_handling
      // עלול להחזיר 307 מ-'/index.html' ל-'/' ולאבד את ה-deep-link). fetch של '/'
      // מחזיר את ה-shell כ-200; ה-URL בדפדפן נשאר /vault/<id> (זו לא הפניה, זה גוף),
      // ו-boot קורא את location.pathname האמיתי. (אומת ע"י אביגיל: 200, לא 307.)
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }
    if (request.method === 'GET') {
      // /{VAULT_NAME} → the canonical /vault/{VAULT_NAME} URL (302, not a
      // shell-body serve: the redirect is one round-trip cheaper than
      // booting the shell just to have boot.js location.replace it, and the
      // browser URL ends up canonical either way).
      const shortName = vaultShortName(url.pathname);
      if (shortName) {
        return Response.redirect(new URL('/vault/' + encodeURIComponent(shortName), url).href, 302);
      }
    }
    // Everything else: the static app bundle. Vault storage is OPFS in the
    // browser, not the server.
    return env.ASSETS.fetch(request);
  },
};
