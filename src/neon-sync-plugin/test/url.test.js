// parseVaultUrl — the "paste your claimed URL" settings field's parser.
// Rules mirror src/client-mobile/starter-url.js (+ the server short-link
// rule): /vault/<name> canonical links, single-segment short links (dot-free,
// non-reserved), note deep links under either, bare names, scheme-less hosts.
// A link that works in the browser must work here.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Plugin = require('../main.js');
const { parseVaultUrl } = Plugin;

const ORIGIN = 'https://notes.sarris.dev';

test('canonical /vault/<name> link → origin + name', () => {
  assert.deepEqual(parseVaultUrl(ORIGIN + '/vault/myvault'),
    { ok: true, baseUrl: ORIGIN, vault: 'myvault' });
});

test('trailing slash, query and hash are ignored', () => {
  for (const u of [
    ORIGIN + '/vault/myvault/',
    ORIGIN + '/vault/myvault?foo=1',
    ORIGIN + '/vault/myvault#heading',
    '  ' + ORIGIN + '/vault/myvault  ',
  ]) {
    assert.deepEqual(parseVaultUrl(u), { ok: true, baseUrl: ORIGIN, vault: 'myvault' }, u);
  }
});

test('note deep links keep only the vault name', () => {
  assert.deepEqual(parseVaultUrl(ORIGIN + '/vault/myvault/Folder/Note.md'),
    { ok: true, baseUrl: ORIGIN, vault: 'myvault' });
  assert.deepEqual(parseVaultUrl(ORIGIN + '/myvault/Note.md'),
    { ok: true, baseUrl: ORIGIN, vault: 'myvault' });
});

test('short link (single segment) works like the web 302', () => {
  assert.deepEqual(parseVaultUrl(ORIGIN + '/myvault'),
    { ok: true, baseUrl: ORIGIN, vault: 'myvault' });
});

test('short-link rule rejects reserved routes and dot-files', () => {
  for (const u of ['/api', '/starter', '/sync', '/vault', '/api/v1/x', '/app.css', '/_foo', '/~bar']) {
    const r = parseVaultUrl(ORIGIN + u);
    assert.equal(r.ok, false, u);
  }
});

test('origin alone is an error (no vault name)', () => {
  for (const u of [ORIGIN, ORIGIN + '/', ORIGIN + '/vault/', ORIGIN + '/vault']) {
    assert.equal(parseVaultUrl(u).ok, false, u);
  }
});

test('bare name → vault only, keeps the configured Server URL', () => {
  assert.deepEqual(parseVaultUrl('myvault'), { ok: true, baseUrl: null, vault: 'myvault' });
  assert.deepEqual(parseVaultUrl('my.vault'), { ok: true, baseUrl: null, vault: 'my.vault' }); // dots fine when typed as a name
});

test('relative forms fill the vault name only', () => {
  assert.deepEqual(parseVaultUrl('/vault/myvault'), { ok: true, baseUrl: null, vault: 'myvault' });
  assert.deepEqual(parseVaultUrl('vault/myvault'), { ok: true, baseUrl: null, vault: 'myvault' });
});

test('scheme-less host: https for public hosts, http for local/dev hosts', () => {
  assert.deepEqual(parseVaultUrl('notes.sarris.dev/vault/myvault'),
    { ok: true, baseUrl: ORIGIN, vault: 'myvault' });
  assert.deepEqual(parseVaultUrl('notes.sarris.dev/myvault'),
    { ok: true, baseUrl: ORIGIN, vault: 'myvault' });
  // Plain-HTTP dev servers must NOT get an https:// origin — that handshake
  // fails with ERR_SSL_VERSION_OR_CIPHER_MISMATCH.
  assert.deepEqual(parseVaultUrl('localhost:3000/vault/x'),
    { ok: true, baseUrl: 'http://localhost:3000', vault: 'x' });
  assert.deepEqual(parseVaultUrl('127.0.0.1:3000/vault/x'),
    { ok: true, baseUrl: 'http://127.0.0.1:3000', vault: 'x' });
  assert.deepEqual(parseVaultUrl('192.168.1.50/vault/x'),
    { ok: true, baseUrl: 'http://192.168.1.50', vault: 'x' });
});

test('explicit schemes, ports and casing survive', () => {
  assert.deepEqual(parseVaultUrl('http://localhost:3000/vault/x'),
    { ok: true, baseUrl: 'http://localhost:3000', vault: 'x' });
  assert.deepEqual(parseVaultUrl('https://h:8443/vault/x'),
    { ok: true, baseUrl: 'https://h:8443', vault: 'x' });
  assert.deepEqual(parseVaultUrl('HTTPS://H/vault/x'),
    { ok: true, baseUrl: 'HTTPS://H', vault: 'x' });
  assert.deepEqual(parseVaultUrl(ORIGIN + '/VAULT/x'),
    { ok: true, baseUrl: ORIGIN, vault: 'x' });
});

test('percent-encoded names decode; bad encoding is an error', () => {
  assert.deepEqual(parseVaultUrl(ORIGIN + '/vault/my%2Dvault'),
    { ok: true, baseUrl: ORIGIN, vault: 'my-vault' });
  assert.equal(parseVaultUrl(ORIGIN + '/vault/%E0%A4%A').ok, false);
  assert.equal(parseVaultUrl(ORIGIN + '/vault/my%20vault').ok, false); // spaces aren't claimable
});

test('name charset and length follow the claim rule', () => {
  assert.equal(parseVaultUrl('a'.repeat(64)).ok, true);
  assert.equal(parseVaultUrl('a'.repeat(65)).ok, false);
  assert.equal(parseVaultUrl('my vault').ok, false);
  assert.equal(parseVaultUrl('νότα').ok, false);
});

test('other schemes and protocol-relative URLs are refused', () => {
  assert.equal(parseVaultUrl('obsidian://open?vault=x').ok, false);
  assert.equal(parseVaultUrl('//notes.sarris.dev/vault/x').ok, false);
  assert.equal(parseVaultUrl('javascript:alert(1)').ok, false);
});

test('empty input is an error, never a throw', () => {
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(parseVaultUrl(v).ok, false);
  }
});

test('a vault literally named like a route works via the canonical form', () => {
  assert.deepEqual(parseVaultUrl(ORIGIN + '/vault/vault'),
    { ok: true, baseUrl: ORIGIN, vault: 'vault' });
  assert.deepEqual(parseVaultUrl(ORIGIN + '/vault/api'),
    { ok: true, baseUrl: ORIGIN, vault: 'api' });
});
