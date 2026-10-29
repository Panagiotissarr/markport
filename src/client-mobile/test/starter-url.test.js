'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseVaultUrlInput,
  shortPathSegment,
} = require('../starter-url.js');

test('parseVaultUrlInput — bare name', () => {
  assert.deepStrictEqual(parseVaultUrlInput('myvault'), { kind: 'name', name: 'myvault' });
  assert.deepStrictEqual(parseVaultUrlInput('  my-vault_2.x  '), { kind: 'name', name: 'my-vault_2.x' });
});

test('parseVaultUrlInput — absolute http(s) URL passes through', () => {
  assert.deepStrictEqual(
    parseVaultUrlInput('https://example.com/vault/foo'),
    { kind: 'url', url: 'https://example.com/vault/foo' });
  assert.deepStrictEqual(
    parseVaultUrlInput('http://192.168.1.5:3000/starter'),
    { kind: 'url', url: 'http://192.168.1.5:3000/starter' });
});

test('parseVaultUrlInput — strips pasted origin / vault prefix', () => {
  assert.deepStrictEqual(parseVaultUrlInput('vault/foo'), { kind: 'name', name: 'foo' });
  assert.deepStrictEqual(parseVaultUrlInput('/vault/foo'), { kind: 'name', name: 'foo' });
  assert.deepStrictEqual(parseVaultUrlInput('example.com/vault/foo'), { kind: 'name', name: 'foo' });
  assert.deepStrictEqual(parseVaultUrlInput('/foo'), { kind: 'name', name: 'foo' });
  // scheme-less host WITHOUT the vault/ route is NOT stripped — the first
  // segment may itself be a legitimate (dot-containing) vault name.
  const r = parseVaultUrlInput('my.notes/Tags');
  assert.strictEqual(r.kind, 'path');
  assert.strictEqual(r.name, 'my.notes');
});

test('parseVaultUrlInput — note deep links keep the rest of the path', () => {
  const r = parseVaultUrlInput('/vault/foo/Features/Tags');
  assert.strictEqual(r.kind, 'path');
  assert.strictEqual(r.name, 'foo');
  assert.strictEqual(r.url, '/vault/foo/Features/Tags');
});

test('parseVaultUrlInput — rejects empty, bad schemes, protocol-relative, bad names', () => {
  assert.strictEqual(parseVaultUrlInput('').kind, 'error');
  assert.strictEqual(parseVaultUrlInput('   ').kind, 'error');
  assert.strictEqual(parseVaultUrlInput('javascript:alert(1)').kind, 'error');
  assert.strictEqual(parseVaultUrlInput('obsidian://open?x=1').kind, 'error');
  assert.strictEqual(parseVaultUrlInput('//evil.example.com/x').kind, 'error');
  assert.strictEqual(parseVaultUrlInput('has space').kind, 'error');
  assert.strictEqual(parseVaultUrlInput('a'.repeat(65)).kind, 'error');
  assert.strictEqual(parseVaultUrlInput('vault//').kind, 'error');
});

test('shortPathSegment — single clean segment redirects', () => {
  assert.strictEqual(shortPathSegment('/myvault'), 'myvault');
  assert.strictEqual(shortPathSegment('/myvault/'), 'myvault');
  assert.strictEqual(shortPathSegment('/My-Vault_2'), 'My-Vault_2');
  assert.strictEqual(shortPathSegment('/%6Dyvault'), 'myvault');
});

test('shortPathSegment — root, multi-segment and empty are null', () => {
  assert.strictEqual(shortPathSegment('/'), null);
  assert.strictEqual(shortPathSegment('/vault/foo'), null);
  assert.strictEqual(shortPathSegment('/foo/bar'), null);
  assert.strictEqual(shortPathSegment(''), null);
  assert.strictEqual(shortPathSegment(null), null);
});

test('shortPathSegment — files (any dot) never redirect', () => {
  assert.strictEqual(shortPathSegment('/app.css'), null);
  assert.strictEqual(shortPathSegment('/sw.js'), null);
  assert.strictEqual(shortPathSegment('/manifest.webmanifest'), null);
  assert.strictEqual(shortPathSegment('/favicon.ico'), null);
  assert.strictEqual(shortPathSegment('/example-vault.json'), null);
});

test('shortPathSegment — reserved routes/dirs never redirect', () => {
  for (const seg of ['api', 'sync', 'starter', 'vault', 'mobile', 'client-mobile',
    'obsidian-mobile', 'i18n', 'lib', 'public', 'sandbox', 'system-plugins', 'index']) {
    assert.strictEqual(shortPathSegment('/' + seg), null, seg);
    assert.strictEqual(shortPathSegment('/' + seg.toUpperCase()), null, seg + ' (case)');
  }
  assert.strictEqual(shortPathSegment('/_owres'), null);
  assert.strictEqual(shortPathSegment('/.well-known'), null);
  assert.strictEqual(shortPathSegment('/~temp'), null);
});

test('shortPathSegment — names that fail the vault-name rule are null', () => {
  assert.strictEqual(shortPathSegment('/has%20space'), null);
  assert.strictEqual(shortPathSegment('/' + 'a'.repeat(65)), null);
  assert.strictEqual(shortPathSegment('/%E0%A4%A8%E0%A4%AE'), null); // devanagari
});
