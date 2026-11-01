// Local dev server — static public/ + the real /sync/v1 handlers + the
// proxy, so the app behaves like Vercel without a deployment:
//
//   npm run build     # first — produces public/ (or reuse a previous build)
//   npm run dev       # http://localhost:3000
//
// Dev conveniences (local only — none of this ships to Vercel):
//   - SYNC_STORE defaults to `memory` — sync data lives in this process and
//     vanishes with it (a restart starts from an empty vault)
//   - a missing SYNC_TOKEN generates one and prints it, with the exact
//     localStorage line to paste (the deployed functions stay fail-closed:
//     503 until you set the env var there)
//
// Routing mirrors vercel.json: /sync/v1/* → api/sync/v1/*, POST
// /api/proxy-request → api/proxy-request.js, /starter and /vault/* fall back
// to index.html; everything else is a static file out of public/.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERCEL_DIR = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(VERCEL_DIR, 'public');
const API_DIR = path.join(VERCEL_DIR, 'api');
const PORT = Number(process.env.PORT) || 3000;

if (!process.env.SYNC_STORE) {
  process.env.SYNC_STORE = 'memory';
  console.log('[dev] SYNC_STORE=memory (in-process, data lost on restart)');
}
if (!process.env.SYNC_TOKEN) {
  process.env.SYNC_TOKEN = randomBytes(24).toString('hex');
  console.log('[dev] SYNC_TOKEN generated for this run: ' + process.env.SYNC_TOKEN);
  console.log('[dev] paste this into the browser (per vault id):');
  console.log('[dev]   localStorage.setItem("ow-sync:<vaultId>", JSON.stringify({');
  console.log('[dev]     baseUrl: location.origin, token: "' + process.env.SYNC_TOKEN + '" }));');
}
if (!fs.existsSync(PUBLIC_DIR)) {
  console.log('[dev] public/ not found — run `npm run build` first (static serving only after that)');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

// Lazy-loaded so importing this module in tests never pulls the handlers in.
const handlers = new Map();
async function handlerFor(routePath) {
  if (!handlers.has(routePath)) {
    const mod = await import(pathToFileUrl(path.join(API_DIR, routePath)));
    handlers.set(routePath, mod.default); // toNodeHandler(web)
  }
  return handlers.get(routePath);
}

function pathToFileUrl(p) {
  return new URL('file://' + p.replace(/\\/g, '/')).href;
}

// /{VAULT_NAME} short-link rule — mirror of src/client-mobile/starter-url.js's
// shortPathSegment (and vercel.json's redirect / the CF worker / the
// runtime-server route): single segment, no dot, no leading '.'/'_'/'~', not
// a reserved root, vault-name charset. KEEP THE COPIES IN SYNC.
const RESERVED_ROOT_SEGMENTS = ['api', 'sync', 'starter', 'vault', 'mobile',
  'client-mobile', 'obsidian-mobile', 'i18n', 'lib', 'public', 'sandbox',
  'system-plugins', 'index'];
function vaultShortName(pathname) {
  const m = pathname.match(/^\/([^/]+)\/?$/);
  if (!m) return null;
  let seg = m[1];
  try { seg = decodeURIComponent(seg); } catch { return null; }
  if (!seg || seg.includes('.')) return null;
  const c0 = seg.charAt(0);
  if (c0 === '.' || c0 === '_' || c0 === '~') return null;
  if (RESERVED_ROOT_SEGMENTS.includes(seg.toLowerCase())) return null;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(seg)) return null;
  return seg;
}

// vercel.json's rewrite table, minus what Vercel's api/ routing gives free.
function syncRoute(pathname) {
  if (pathname === '/sync/v1/manifest') return 'sync/v1/manifest.js';
  if (pathname === '/sync/v1/commit') return 'sync/v1/commit.js';
  if (pathname === '/sync/v1/blobs/missing') return 'sync/v1/blobs/missing.js';
  if (pathname === '/sync/v1/changes') return 'sync/v1/changes.js';
  if (pathname === '/sync/v1/live') return 'sync/v1/live.js';
  if (pathname === '/sync/v1/deletions') return 'sync/v1/deletions.js';
  if (pathname.startsWith('/sync/v1/blob/')) return 'sync/v1/blob/[hash].js';
  return null;
}

function sendFile(res, file) {
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store', // dev: never fight a stale copy
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '/starter' || rel.startsWith('/vault/')) rel = '/index.html';

  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found: ' + pathname }));
    return;
  }
  sendFile(res, file);
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  try {
    if (pathname === '/api/proxy-request') {
      const handler = await handlerFor('proxy-request.js');
      await handler(req, res);
      return;
    }
    if (pathname.startsWith('/sync/v1/')) {
      const route = syncRoute(pathname);
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no such sync route', path: pathname }));
        return;
      }
      const handler = await handlerFor(route);
      await handler(req, res);
      return;
    }
    // vercel.json's /{VAULT_NAME} → /vault/{VAULT_NAME} redirect, mirrored
    // (dev.js is the local stand-in for the platform's routing table).
    if (req.method === 'GET') {
      const shortName = vaultShortName(pathname);
      if (shortName) {
        res.writeHead(302, { location: '/vault/' + encodeURIComponent(shortName) });
        res.end();
        return;
      }
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[dev] handler error on', req.method, pathname, '-', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});

server.listen(PORT, () => {
  console.log(`[dev] obsidian-web (Vercel shape) → http://localhost:${PORT}`);
});
