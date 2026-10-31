// PUT/GET /sync/v1/blob/:hash — chunked upload, immutable download, ranges.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  installAuth, freshStore, resetStore, authHeaders, url, readJson, sha256Hex,
} from './helpers.js';
import { web as blob } from '../api/sync/v1/blob/[hash].js';
import { MAX_PART_BYTES } from '../lib/store.js';

before(() => installAuth());
beforeEach(() => freshStore());
after(resetStore);

function put(hash, chunk, extra = {}) {
  return blob(new Request(url(`/sync/v1/blob/${hash}`), {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(chunk),
    ...extra,
  }));
}

function get(hash, query) {
  return blob(new Request(url(`/sync/v1/blob/${hash}`, query), { headers: authHeaders() }));
}

function singleChunk(bytes) {
  const buf = Buffer.from(bytes);
  return { index: 0, total: 1, size: buf.length, data: buf.toString('base64') };
}

test('single-chunk upload → stored, then GET returns the bytes immutably', async () => {
  const data = 'the quick brown fox';
  const hash = sha256Hex(data);

  const putRes = await put(hash, singleChunk(data));
  assert.equal(putRes.status, 200);
  assert.deepEqual(await readJson(putRes), { hash, stored: true });

  const getRes = await get(hash);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get('content-type'), 'application/octet-stream');
  // `private` on purpose: see the header comment in api/sync/v1/blob/[hash].js
  // — `public` would licence a shared cache to serve token-gated content to
  // the next caller without a token (RFC 9111 §3.5).
  assert.equal(getRes.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(getRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(getRes.headers.get('etag'), `"${hash}"`);
  assert.equal(getRes.headers.get('accept-ranges'), 'bytes');
  assert.equal(Buffer.from(await getRes.arrayBuffer()).toString(), data);
});

test('multi-chunk upload reports stored:false until the last chunk', async () => {
  const data = Buffer.from('chunked-upload-payload-0123456789');
  const hash = sha256Hex(data);
  const half = Math.ceil(data.length / 2);

  const c0 = await put(hash, {
    index: 0, total: 2, size: data.length,
    data: data.subarray(0, half).toString('base64'),
  });
  assert.deepEqual(await readJson(c0), { hash, stored: false });
  assert.equal((await get(hash)).status, 404); // not assembled yet

  const c1 = await put(hash, {
    index: 1, total: 2, size: data.length,
    data: data.subarray(half).toString('base64'),
  });
  assert.deepEqual(await readJson(c1), { hash, stored: true });

  const got = await get(hash);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(data));
});

test('content that does not match its hash → 409, nothing stored', async () => {
  const wrongHash = 'f'.repeat(64);
  const res = await put(wrongHash, singleChunk('not what you asked for'));
  assert.equal(res.status, 409);
  assert.match((await readJson(res)).error, /content/);
  assert.equal((await get(wrongHash)).status, 404);
});

test('declared size that does not match the bytes → 400', async () => {
  const data = Buffer.from('actual');
  const hash = sha256Hex(data);
  const res = await put(hash, { index: 0, total: 1, size: data.length + 5, data: data.toString('base64') });
  assert.equal(res.status, 400);
  assert.equal((await get(hash)).status, 404);
});

test('a chunk larger than the per-request limit → 413', async () => {
  const oversize = Buffer.alloc(MAX_PART_BYTES + 1, 1);
  const res = await put('a'.repeat(64), {
    index: 0, total: 1, size: oversize.length, data: oversize.toString('base64'),
  });
  assert.equal(res.status, 413);
});

test('unknown hash → 404; malformed hash in the URL → 400', async () => {
  assert.equal((await get('0'.repeat(64))).status, 404);
  assert.equal((await get('not-a-hash')).status, 400);
});

test('byte ranges: 206 with Content-Range and the exact window', async () => {
  const data = '0123456789abcdef';
  const hash = sha256Hex(data);
  await put(hash, singleChunk(data));

  const res = await get(hash, { start: 4, end: 7 });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 4-7/16');
  assert.equal(await res.text(), '4567');

  const tail = await get(hash, { start: 14 });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), 'ef');
});

test('out-of-bounds range → 416', async () => {
  const data = 'short';
  const hash = sha256Hex(data);
  await put(hash, singleChunk(data));

  assert.equal((await get(hash, { start: 99 })).status, 416);
  assert.equal((await get(hash, { start: 3, end: 1 })).status, 416);
  assert.equal((await get(hash, { start: -1 })).status, 400);
});

test('over-size blob: un-ranged GET → 413 (client must window); ranged GET → 206', async () => {
  // A store whose full-GET threshold is tiny, so the test blob crosses it.
  const store = freshStore();
  const big = Buffer.alloc(4096, 7);
  const hash = sha256Hex(big);
  await store.putBlobPart(hash, { index: 0, total: 1, size: big.length, data: big });

  const originalLimit = process.env.SYNC_BLOB_FULL_GET_LIMIT;
  process.env.SYNC_BLOB_FULL_GET_LIMIT = '1024'; // handler reads this per call
  try {
    const whole = await get(hash);
    assert.equal(whole.status, 413);
    assert.match((await readJson(whole)).error, /range/);

    const window1 = await get(hash, { start: 0, end: 2047 });
    assert.equal(window1.status, 206);
    assert.equal(window1.headers.get('content-range'), 'bytes 0-2047/4096');
    assert.equal((await window1.arrayBuffer()).byteLength, 2048);

    const window2 = await get(hash, { start: 2048, end: 4095 });
    assert.equal(window2.status, 206);
    assert.equal((await window2.arrayBuffer()).byteLength, 2048);
  } finally {
    if (originalLimit === undefined) delete process.env.SYNC_BLOB_FULL_GET_LIMIT;
    else process.env.SYNC_BLOB_FULL_GET_LIMIT = originalLimit;
  }
});

test('re-uploading an already-stored blob is idempotent', async () => {
  const data = 'idempotent';
  const hash = sha256Hex(data);
  assert.equal((await readJson(await put(hash, singleChunk(data)))).stored, true);
  assert.equal((await readJson(await put(hash, singleChunk(data)))).stored, true);
  assert.equal((await get(hash)).status, 200);
});

test('malformed bodies → 400', async () => {
  const hash = sha256Hex('x');
  const bad = await blob(new Request(url(`/sync/v1/blob/${hash}`), {
    method: 'PUT',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: 'not json',
  }));
  assert.equal(bad.status, 400);

  assert.equal((await put(hash, { index: 0, total: 1, size: 1 })).status, 400); // no data
  assert.equal((await put(hash, { index: 5, total: 2, size: 1, data: '' })).status, 400);
  assert.equal((await put(hash, { index: 0, total: 0, size: 1, data: '' })).status, 400);
  assert.equal((await put(hash, { index: 0, total: 1, size: 'x', data: '' })).status, 400);
});

test('unauthenticated blob access → 401', async () => {
  const res = await blob(new Request(url(`/sync/v1/blob/${'0'.repeat(64)}`)));
  assert.equal(res.status, 401);
});

test('unsupported method → 405', async () => {
  const res = await blob(new Request(url(`/sync/v1/blob/${'0'.repeat(64)}`), {
    method: 'DELETE',
    headers: authHeaders(),
  }));
  assert.equal(res.status, 405);
});
