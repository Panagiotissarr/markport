// /sync/v1/blob/:hash — content-addressed blob read/write.
//
// GET  returns the raw bytes. Vercel caps a response at 4.5 MB, so requests
//      may pass ?start=&end= to fetch a byte range (206 + Content-Range);
//      the client splits anything bigger than one window (see
//      remote-client.js). Content never changes under a hash, so responses
//      are immutable-cacheable either way.
//
// PUT  uploads one chunk of a new blob as JSON {index, total, size, data}
//      (base64) — again because of the 4.5 MB *request* cap. The store
//      assembles the chunks, verifies the sha-256 against the URL's hash,
//      and only then materializes the blob. Idempotent: a chunk of a blob
//      that already exists is a no-op success.

import { toNodeHandler } from '../../../../lib/adapter.js';
import { requireAuth } from '../../../../lib/auth.js';
import { getBlobFullGetLimit } from '../../../../lib/config.js';
import { SyncError, getVaultOrThrow, json, withErrors } from '../../../../lib/http.js';
import { getStore, MAX_PART_BYTES } from '../../../../lib/store.js';
import { requireValidHash } from '../../../../lib/validate.js';

const MAX_CHUNKS = 4096;

function intParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new SyncError(400, `invalid ${name}: ${JSON.stringify(raw)}`);
  }
  return n;
}

async function readBlob(request, hash) {
  const store = await getStore();
  const blob = await store.getBlob(hash);
  if (!blob) throw new SyncError(404, 'unknown hash');

  const url = new URL(request.url);
  const start = intParam(url, 'start');
  const end = intParam(url, 'end'); // inclusive, like RFC 7233

  let status = 200;
  let body = blob.data;
  const headers = {
    'accept-ranges': 'bytes',
    // `private`: the bytes are behind a bearer token. `public` is an explicit
    // licence for a SHARED cache (CDN, corporate proxy) to store a response
    // to a request that carried `Authorization` and hand it to the next
    // caller without one — RFC 9111 §3.5 allows exactly that when the
    // response says `public`. Content is still immutable, so the browser's
    // own cache keeps the same benefit without the leak.
    'cache-control': 'private, max-age=31536000, immutable',
    'content-type': 'application/octet-stream',
    // Note: no filename/path is ever echoed, and vault content is arbitrary
    // user data — never let a browser sniff it into an active type.
    'x-content-type-options': 'nosniff',
    etag: `"${hash}"`,
  };

  if (start === null && end === null) {
    // No range requested: refuse (rather than let Vercel truncate at
    // 4.5 MB) anything the client must window. 413 is the signal
    // remote-client.js reassembles on.
    if (blob.data.length > getBlobFullGetLimit()) {
      throw new SyncError(413, 'blob is larger than one response — request a byte range');
    }
  } else {
    const from = start ?? 0;
    const to = end ?? blob.data.length - 1;
    if (from >= blob.data.length || to < from) {
      throw new SyncError(416, 'range not satisfiable');
    }
    const clampedTo = Math.min(to, blob.data.length - 1);
    body = blob.data.subarray(from, clampedTo + 1);
    status = 206;
    headers['content-range'] = `bytes ${from}-${clampedTo}/${blob.data.length}`;
  }

  return new Response(body, { status, headers });
}

async function writeChunk(request, hash) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    throw new SyncError(400, 'body must be a JSON object');
  }
  if (!body || typeof body !== 'object') {
    throw new SyncError(400, 'body must be a JSON object');
  }

  const index = Number(body.index);
  const total = Number(body.total);
  const size = Number(body.size);
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) ||
      total < 1 || total > MAX_CHUNKS || index >= total) {
    throw new SyncError(400, `invalid chunk coordinates: ${JSON.stringify({ index, total })}`);
  }
  if (!Number.isInteger(size) || size < 0) {
    throw new SyncError(400, `invalid size: ${JSON.stringify(body.size)}`);
  }
  if (typeof body.data !== 'string') {
    throw new SyncError(400, 'data must be a base64 string');
  }

  const data = Buffer.from(body.data, 'base64');
  if (data.length > MAX_PART_BYTES) {
    throw new SyncError(413, `chunk exceeds ${MAX_PART_BYTES} bytes`);
  }

  const store = await getStore();
  const { stored } = await store.putBlobPart(hash, { index, total, size, data });
  return json({ hash, stored });
}

export const web = withErrors(async (request) => {
  const denied = requireAuth(request);
  if (denied) return denied;
  getVaultOrThrow(request); // enforce mpv1 token scope (blobs are global, the request is not)

  const hash = requireValidHash(new URL(request.url).pathname.split('/').pop(), 'hash');

  if (request.method === 'PUT') return writeChunk(request, hash);
  if (request.method === 'GET') return readBlob(request, hash);
  throw new SyncError(405, 'method not allowed');
});

export default toNodeHandler(web);
