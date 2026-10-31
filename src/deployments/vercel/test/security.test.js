// Security regression suite for /sync/v1.
//
// Every test here corresponds to a finding from the security review and
// FAILS against the code as it was before the fix. The point is that the
// property, not the implementation, is pinned:
//
//   * upload amplification  — bytes held for one hash ≤ the declared size
//   * commit integrity      — a file row can never reference a missing blob,
//                             and the manifest's `size` is the server's
//   * cache isolation       — token-gated bytes are never shared-cacheable
//   * rate-limit key        — the client cannot choose its own bucket
//   * auth surface          — no /sync/v1 route answers unauthenticated
//   * vault isolation       — one vault's mpv1 token cannot touch another

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/store-memory.js';
import { clientIp } from '../lib/client-ip.js';
import {
  installAuth, freshStore, resetStore, authHeaders, url, sha256Hex, readJson,
} from './helpers.js';
import { issueVaultToken } from '../lib/claims.js';
import { getStore, __resetStoreForTest } from '../lib/store.js';
import { web as vaults } from '../api/sync/v1/vaults/[name].js';
import { web as manifest } from '../api/sync/v1/manifest.js';
import { web as commit } from '../api/sync/v1/commit.js';
import { web as blob } from '../api/sync/v1/blob/[hash].js';
import { web as missing } from '../api/sync/v1/blobs/missing.js';
import { web as changes } from '../api/sync/v1/changes.js';
import { web as deletions } from '../api/sync/v1/deletions.js';
import { web as live } from '../api/sync/v1/live.js';

beforeEach(() => {
  installAuth();
  freshStore();
});
after(resetStore);

function req(path, { method = 'GET', headers = {}, body, query } = {}) {
  const init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json', ...init.headers };
  }
  return new Request(url(path, query), init);
}

// ── 1. upload amplification ────────────────────────────────────────────────

test('upload: a declared size cannot be used as a label for more bytes', async () => {
  const store = createMemoryStore({ maxBlobBytes: 1024, maxPartBytes: 256 });
  const hash = 'a'.repeat(64);

  // 8 parts × 256 B = 2048 B claimed against a declared size of 1024 B.
  let held = 0;
  await assert.rejects(
    async () => {
      for (let i = 0; i < 8; i++) {
        await store.putBlobPart(hash, { index: i, total: 8, size: 1024, data: Buffer.alloc(256, 65) });
        held += 256;
      }
    },
    (err) => err.name === 'StoreError' && err.code === 'ETOOLARGE',
  );
  assert.ok(held <= 1024, `accepted ${held} bytes for a 1024-byte blob`);
  assert.equal(await store.getBlob(hash), null);
});

test('upload: a single chunk bigger than the declared size is refused', async () => {
  const store = createMemoryStore({ maxBlobBytes: 4096, maxPartBytes: 4096 });
  const hash = 'b'.repeat(64);
  await assert.rejects(
    () => store.putBlobPart(hash, { index: 0, total: 1, size: 10, data: Buffer.alloc(4096) }),
    (err) => err.code === 'ETOOLARGE',
  );
});

test('upload: re-sending the same index is not double-counted', async () => {
  const store = createMemoryStore({ maxBlobBytes: 64, maxPartBytes: 32 });
  const data = Buffer.from('0123456789abcdef'); // 16 bytes
  const hash = sha256Hex(data);
  const half = data.length / 2;
  const part = (i, buf) => store.putBlobPart(hash, { index: i, total: 2, size: data.length, data: buf });

  assert.deepEqual(await part(0, data.subarray(0, half)), { stored: false });
  // A retried chunk must not be counted twice and must not trip the bound.
  assert.deepEqual(await part(0, data.subarray(0, half)), { stored: false });
  const done = await part(1, data.subarray(half));
  assert.deepEqual(done, { stored: true });
  assert.ok((await store.getBlob(hash)).data.equals(data));
});

test('upload: a legitimately windowed multi-chunk upload still works', async () => {
  const store = createMemoryStore({ maxBlobBytes: 1024, maxPartBytes: 1024 });
  const data = Buffer.alloc(1000, 7);
  const hash = sha256Hex(data);
  const step = 250;
  for (let i = 0; i < 4; i++) {
    const r = await store.putBlobPart(hash, {
      index: i, total: 4, size: data.length, data: data.subarray(i * step, (i + 1) * step),
    });
    assert.equal(r.stored, i === 3);
  }
  assert.ok((await store.getBlob(hash)).data.equals(data));
});

test('upload over HTTP: amplification is a 413, not a stored blob', async () => {
  const store = freshStore({ maxBlobBytes: 512, maxPartBytes: 256 });
  const hash = 'c'.repeat(64);
  const put = (index) => blob(req(`/sync/v1/blob/${hash}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: { index, total: 8, size: 512, data: Buffer.alloc(256, 9).toString('base64') },
  }));

  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await put(i)).status);
  assert.ok(statuses.includes(413), 'no 413 for an over-declared upload: ' + statuses.join(','));
  assert.equal(await store.getBlob(hash), null);
});

// ── 2. commit integrity ────────────────────────────────────────────────────

test('commit: the manifest size is the blob\'s real size, not the client claim', async () => {
  const store = freshStore();
  const data = Buffer.from('tiny');
  const hash = sha256Hex(data);
  await store.putBlobPart(hash, { index: 0, total: 1, size: data.length, data });

  const res = await commit(req('/sync/v1/commit', {
    method: 'POST',
    headers: authHeaders(),
    body: { changes: [{ path: 'a.md', hash, size: 64 * 1024 * 1024, baseHash: null }], deletions: [] },
  }));
  assert.equal(res.status, 200);

  const list = await readJson(await manifest(req('/sync/v1/manifest', { headers: authHeaders() })));
  assert.equal(list.entries[0].size, data.length, 'a client must not be able to lie about size');
});

test('commit: a blob missing at commit time is a 422, not a dangling file row', async () => {
  // The route's presence check and the write are separate round-trips, so the
  // blob GC can delete the content in between. Simulate exactly that: the
  // fast path answers "present", the store sees nothing.
  const store = freshStore();
  const data = Buffer.from('content');
  const hash = sha256Hex(data);
  store.missingBlobs = async () => []; // fast path fooled

  const res = await commit(req('/sync/v1/commit', {
    method: 'POST',
    headers: authHeaders(),
    body: { changes: [{ path: 'gone.md', hash, size: data.length, baseHash: null }], deletions: [] },
  }));
  assert.equal(res.status, 422);
  assert.deepEqual((await readJson(res)).hashes, [hash]);

  const list = await readJson(await manifest(req('/sync/v1/manifest', { headers: authHeaders() })));
  assert.deepEqual(list.entries, [], 'no file row may reference a missing blob');
});

// ── 3. cache isolation ─────────────────────────────────────────────────────

test('blob GET: token-gated bytes are private + nosniff, never shared-cacheable', async () => {
  const store = freshStore();
  const data = Buffer.from('secret note');
  const hash = sha256Hex(data);
  await store.putBlobPart(hash, { index: 0, total: 1, size: data.length, data });

  const res = await blob(req(`/sync/v1/blob/${hash}`, { headers: authHeaders() }));
  assert.equal(res.status, 200);
  const cc = res.headers.get('cache-control') || '';
  assert.match(cc, /^private\b/);
  assert.doesNotMatch(cc, /\bpublic\b/);
  assert.doesNotMatch(cc, /s-maxage/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

// ── 4. rate-limit key spoofing ─────────────────────────────────────────────

test('clientIp: a client-supplied left-most x-forwarded-for cannot pick the bucket', () => {
  const mk = (headers) => new Request('http://localhost/x', { headers });
  // Chain: attacker wrote the first entry, our edge appended the real one.
  assert.equal(clientIp(mk({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })), '203.0.113.9');
  // Vercel's own header wins outright.
  assert.equal(
    clientIp(mk({ 'x-vercel-forwarded-for': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' })),
    '198.51.100.7',
  );
  assert.equal(clientIp(mk({ 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '1.2.3.4' })), '198.51.100.8');
  assert.equal(clientIp(mk({})), '');
});

// ── 5. auth surface ────────────────────────────────────────────────────────

test('no /sync/v1 route answers without a token (stubs included)', async () => {
  const routes = {
    manifest,
    commit,
    blob,
    missing,
    changes,
    deletions,
    live,
  };
  for (const [name, handler] of Object.entries(routes)) {
    const res = await handler(req('/sync/v1/' + name, { method: name === 'commit' || name === 'missing' ? 'POST' : 'GET', body: name === 'commit' || name === 'missing' ? {} : undefined }));
    assert.equal(res.status, 401, `${name} answered ${res.status} without a token`);
    assert.equal(await res.text(), '', `${name} leaked a body on 401`);
  }
});

test('a vault-scoped token is refused on every other vault, on every endpoint', async () => {
  freshStore();
  const token = issueVaultToken('alpha', process.env.SYNC_TOKEN);
  const headers = { authorization: `Bearer ${token}` };

  const other = { vault: 'beta' };
  for (const [name, handler, method] of [
    ['manifest', manifest, 'GET'],
    ['commit', commit, 'POST'],
    ['blob', blob, 'GET'],
    ['missing', missing, 'POST'],
  ]) {
    const body = name === 'commit'
      ? { changes: [], deletions: [] }
      : name === 'missing' ? { hashes: [] } : undefined;
    const res = await handler(req(`/sync/v1/${name}/${name === 'blob' ? 'a'.repeat(64) : ''}`, {
      method, headers, body, query: other,
    }));
    assert.equal(res.status, 403, `${name} let a scoped token touch another vault (${res.status})`);
  }

  // …and still works on its own vault.
  const ok = await manifest(req('/sync/v1/manifest', { headers, query: { vault: 'alpha' } }));
  assert.equal(ok.status, 200);
});

test('scope is enforced on the default vault too (absent ?vault= is not a bypass)', async () => {
  const token = issueVaultToken('alpha', process.env.SYNC_TOKEN);
  const res = await manifest(req('/sync/v1/manifest', { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(res.status, 403);
});

// ── 6. malformed input ─────────────────────────────────────────────────────

test('traversal and absolute paths are rejected at the API boundary', async () => {
  const data = Buffer.from('x');
  const hash = sha256Hex(data);
  const store = freshStore();
  await store.putBlobPart(hash, { index: 0, total: 1, size: data.length, data });

  for (const path of ['../etc/passwd', '/etc/passwd', 'a/../../b.md', 'a\\b.md', 'a//b.md', 'a/./b.md', 'a\u0000b.md']) {
    const res = await commit(req('/sync/v1/commit', {
      method: 'POST',
      headers: authHeaders(),
      body: { changes: [{ path, hash, size: 1, baseHash: null }], deletions: [] },
    }));
    assert.equal(res.status, 400, `path ${JSON.stringify(path)} was accepted (${res.status})`);
  }
});

test('hash parameters are constrained to sha-256 hex', async () => {
  for (const bad of ['../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '']) {
    const res = await blob(req(`/sync/v1/blob/${encodeURIComponent(bad)}`, { headers: authHeaders() }));
    assert.equal(res.status, 400, `hash ${JSON.stringify(bad)} was accepted (${res.status})`);
  }
});

test('oversized bodies and op counts are refused', async () => {
  const res = await commit(req('/sync/v1/commit', {
    method: 'POST',
    headers: authHeaders(),
    body: {
      changes: Array.from({ length: 3001 }, (_, i) => ({ path: `f${i}.md`, hash: 'a'.repeat(64), size: 1, baseHash: null })),
      deletions: [],
    },
  }));
  assert.equal(res.status, 413);
});

// ── 7. the claim IS the credential ─────────────────────────────────────────
// POST /sync/v1/vaults/<name> mints a token for whoever asks first. For an
// empty vault that is the intended "name your vault" flow. For a vault that
// already holds content it would hand a stranger full access to someone
// else's notes — and names are not secret (/vault/<name> links, plus
// GET /vaults/<name> telling you whether it is claimed).

async function seedVault(vault, name = 'note.md') {
  const data = Buffer.from('private diary entry');
  const hash = sha256Hex(data);
  const store = freshStore(); // caller may have replaced it before seeding
  await store.putBlobPart(hash, { index: 0, total: 1, size: data.length, data });
  const res = await commit(req('/sync/v1/commit', {
    method: 'POST',
    headers: authHeaders(), // operator token
    query: { vault },
    body: { changes: [{ path: name, hash, size: data.length, baseHash: null }], deletions: [] },
  }));
  assert.equal(res.status, 200, 'seed commit failed');
  return hash;
}

function claimReq(name, password, headers = {}) {
  return req(`/sync/v1/vaults/${name}`, { method: 'POST', headers, body: { password } });
}

test('a stranger cannot claim a vault that already has content', async () => {
  await seedVault('diary');

  const res = await vaults(claimReq('diary', 'attacker-password'));
  assert.equal(res.status, 409, 'unclaimed-but-populated vault was handed to a stranger');
  const body = await readJson(res);
  assert.equal(body.token, undefined);
  assert.match(body.error, /operator token/);

  // …and the vault is still unreadable without the operator key.
  const anon = await manifest(req('/sync/v1/manifest', { query: { vault: 'diary' } }));
  assert.equal(anon.status, 401);
});

test('the operator can attach a password to a vault that already has content', async () => {
  await seedVault('mine');

  const res = await vaults(claimReq('mine', 'operator-password', authHeaders()));
  assert.equal(res.status, 201);
  const { token } = await readJson(res);
  assert.ok(token);

  // The issued token is scoped to that vault and can read it.
  const list = await readJson(await manifest(req('/sync/v1/manifest', {
    headers: { authorization: `Bearer ${token}` }, query: { vault: 'mine' },
  })));
  assert.equal(list.entries.length, 1);
});

test('the normal flow is untouched: an empty vault is claimable by its first visitor', async () => {
  freshStore();
  const res = await vaults(claimReq('brand-new', 'my-password-1'));
  assert.equal(res.status, 201);
  assert.ok((await readJson(res)).token);

  // And a second claim with a different password does not take it over.
  const taken = await vaults(claimReq('brand-new', 'another-password'));
  assert.equal(taken.status, 401);
});

test('claiming an existing empty claim still requires the right password', async () => {
  freshStore();
  assert.equal((await vaults(claimReq('taken', 'correct-password'))).status, 201);
  assert.equal((await vaults(claimReq('taken', 'correct-password'))).status, 200);
  assert.equal((await vaults(claimReq('taken', 'wrong-password'))).status, 401);
});

// ── 8. production configuration ────────────────────────────────────────────

test('SYNC_STORE=memory is refused on a deployment (silent data loss)', async () => {
  const saved = { store: process.env.SYNC_STORE, vercel: process.env.VERCEL, allow: process.env.SYNC_ALLOW_MEMORY_STORE };
  __resetStoreForTest();
  try {
    process.env.SYNC_STORE = 'memory';
    process.env.VERCEL = '1';
    await assert.rejects(getStore(), (err) => err.status === 503 && /memory/.test(err.message));

    // Explicit override still works (local `vercel dev`).
    process.env.SYNC_ALLOW_MEMORY_STORE = '1';
    __resetStoreForTest();
    assert.equal((await getStore()).kind, 'memory');
  } finally {
    __resetStoreForTest();
    for (const [k, v] of Object.entries({ SYNC_STORE: saved.store, VERCEL: saved.vercel, SYNC_ALLOW_MEMORY_STORE: saved.allow })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
