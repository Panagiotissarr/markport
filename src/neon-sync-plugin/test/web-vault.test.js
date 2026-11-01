// Vault-write behaviour on the WEB build (0.2.2).
//
// The web app (src/client-mobile) pulls into OPFS from OUTSIDE Obsidian's
// adapter, so a path can exist on disk while the vault index
// (getAbstractFileByPath / getFiles) stays blind to it until a page reload.
// 0.2.1 hit that with an exclusive createBinary and died:
//
//   [neon-sync] failed: Error: File already exists.
//
// which aborted the WHOLE sync on the first colliding file. 0.2.2 writes
// through adapter.writeBinary in that case and, crucially, leaves the file
// OUT of `synced` — planSync reads (L⊥, S=hash, R=hash) as "we deleted it,
// server unchanged" and would push a deletion. This suite pins both halves:
// the write path and the no-phantom-deletion guarantee.
//
// node --test runs each file in its own process, so this file's
// require('obsidian') hook cannot leak into the other suites.

const Module = require('node:module');
const origLoad = Module._load;

class PluginStub {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest || { id: 'markport-neon-sync', version: '0.0.0-test' };
    this._data = {};
    this.commands = [];
    this.ribbons = [];
    this.tabs = [];
  }
  addRibbonIcon() {}
  addCommand(c) { this.commands.push(c); }
  addSettingTab(t) { this.tabs.push(t); }
  registerInterval() {}
  async loadData() { return this._data; }
  async saveData(d) { this._data = d; }
}

Module._load = function (request) {
  if (request === 'obsidian') {
    return {
      Plugin: PluginStub,
      PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
      Notice: class { constructor(msg) { this.msg = String(msg); } },
      Setting: class {
        setName() { return this; }
        setDesc() { return this; }
        addText(cb) { cb({ setValue() { return this; }, onChange() { return this; } }); return this; }
        addButton(cb) { cb({ setButtonText() { return this; }, setCta() { return this; }, setDisabled() { return this; }, onClick() { return this; } }); return this; }
      },
      normalizePath: (p) => String(p).replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, ''),
      requestUrl: null,
    };
  }
  return origLoad.apply(this, arguments);
};

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Plugin = require('../main.js');

const nodeCrypto = require('node:crypto');

const bytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
// Real hashes where the scan re-derives them from disk (post-reload paths).
const sha = (s) => nodeCrypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// ── vault stub: index (what Obsidian shows) vs disk (what OPFS holds) ──────
function makeVault(opts) {
  opts = opts || {};
  const index = new Map(); // path → TFile | TFolder
  const disk = new Map();  // path → Uint8Array
  const calls = { createBinary: [], modifyBinary: [], adapterWrite: [], createFolder: [], delete: [], adapterExists: [] };

  function tfile(path, buf) {
    return {
      path: path,
      name: path.split('/').pop(),
      extension: path.split('.').pop(),
      stat: { mtime: 1000, size: buf.byteLength },
    };
  }
  function indexFile(path, buf) { disk.set(path, buf); index.set(path, tfile(path, buf)); }

  (opts.indexed || []).forEach((e) => indexFile(e[0], bytes(e[1])));
  (opts.diskOnly || []).forEach((e) => disk.set(e[0], bytes(e[1])));

  const vault = {
    getAbstractFileByPath(p) { return index.get(p) || null; },
    getFiles() { return Array.from(index.values()).filter((f) => !f._folder); },
    async readBinary(f) {
      const b = disk.get(f.path);
      if (!b) throw new Error('ENOENT ' + f.path);
      return b;
    },
    async modifyBinary(f, buf) {
      calls.modifyBinary.push(f.path);
      disk.set(f.path, buf);
      index.set(f.path, tfile(f.path, buf));
    },
    async createBinary(p, buf) {
      calls.createBinary.push(p);
      // Exactly what the web build throws when OPFS already has the path.
      if (disk.has(p)) throw new Error('File already exists.');
      indexFile(p, buf);
    },
    async createFolder(d) {
      calls.createFolder.push(d);
      if (index.has(d)) throw new Error('Folder already exists.');
      index.set(d, { path: d, name: d.split('/').pop(), _folder: true, children: [] });
      disk.set(d, null);
    },
    async delete(f) {
      calls.delete.push(f.path);
      disk.delete(f.path);
      index.delete(f.path);
    },
    adapter: {
      async exists(p) { calls.adapterExists.push(p); return disk.has(p) || index.has(p); },
      async writeBinary(p, buf) { calls.adapterWrite.push(p); disk.set(p, buf); },
    },
  };

  return { vault, index, disk, calls, indexFile };
}

function makeRemote(entries, blobs) {
  const calls = { blob: [], commit: [], missing: [], put: [] };
  return {
    calls,
    async manifestAll() { return { cursor: null, entries: entries.slice() }; },
    async blob(hash) {
      calls.blob.push(hash);
      if (!blobs[hash]) throw new Error('no such blob: ' + hash);
      return blobs[hash];
    },
    async missingBlobs(hashes) { calls.missing.push(hashes); return []; },
    async putBlob(h, b) { calls.put.push(h); },
    async commit(changes, deletions) { calls.commit.push({ changes: changes, deletions: deletions }); return { ok: true, applied: [] }; },
  };
}

async function pluginFor(vaultStub, data) {
  const p = new Plugin({ vault: vaultStub }, { id: 'markport-neon-sync', version: '0.2.2' });
  p._data = data || {};
  await p.loadSettings();
  return p;
}

// ── writeVaultBytes ────────────────────────────────────────────────────────

test('writeVaultBytes: indexed path → modifyBinary, reports visible', async () => {
  const v = makeVault({ indexed: [['notes/a.md', 'old']] });
  const p = await pluginFor(v.vault);
  const visible = await p.writeVaultBytes('notes/a.md', bytes('new'));
  assert.equal(visible, true);
  assert.deepEqual(v.calls.modifyBinary, ['notes/a.md']);
  assert.deepEqual(v.calls.createBinary, []);
  assert.equal(Buffer.from(v.disk.get('notes/a.md')).toString(), 'new');
});

test('writeVaultBytes: absent path → createBinary, reports visible', async () => {
  const v = makeVault({});
  const p = await pluginFor(v.vault);
  const visible = await p.writeVaultBytes('notes/a.md', bytes('fresh'));
  assert.equal(visible, true);
  assert.deepEqual(v.calls.createBinary, ['notes/a.md']);
  assert.equal(v.index.has('notes/a.md'), true);
});

test('writeVaultBytes: index-blind collision → adapter write, reports invisible', async () => {
  // The 0.2.1 crash: disk has it, index does not.
  const v = makeVault({ diskOnly: [['notes/a.md', 'alpha']] });
  const p = await pluginFor(v.vault);
  const visible = await p.writeVaultBytes('notes/a.md', bytes('alpha'));
  assert.equal(visible, false);
  assert.deepEqual(v.calls.adapterWrite, ['notes/a.md']);
  assert.deepEqual(v.calls.modifyBinary, []);
});

test('writeVaultBytes: index catches up mid-write → modifyBinary instead of throwing', async () => {
  const v = makeVault({ diskOnly: [['notes/a.md', 'alpha']] });
  let targetLookups = 0;
  const real = v.vault.getAbstractFileByPath.bind(v.vault);
  v.vault.getAbstractFileByPath = (p) => {
    if (p === 'notes/a.md' && ++targetLookups > 1) {
      // Obsidian processed the on-disk file between our check and create.
      v.indexFile('notes/a.md', v.disk.get('notes/a.md'));
    }
    return real(p);
  };
  const p = await pluginFor(v.vault);
  const visible = await p.writeVaultBytes('notes/a.md', bytes('beta'));
  assert.equal(visible, true);
  assert.deepEqual(v.calls.modifyBinary, ['notes/a.md']);
  assert.equal(Buffer.from(v.disk.get('notes/a.md')).toString(), 'beta');
});

test('writeVaultBytes: unrelated errors are rethrown, adapter untouched', async () => {
  const v = makeVault({});
  v.vault.createBinary = async () => { throw new Error('EACCES: permission denied'); };
  const p = await pluginFor(v.vault);
  await assert.rejects(() => p.writeVaultBytes('notes/a.md', bytes('x')), /EACCES/);
  assert.deepEqual(v.calls.adapterWrite, []);
});

// ── end-to-end: pull over a stale index ────────────────────────────────────

test('web build: pull over index-blind files completes instead of dying on "File already exists."', async () => {
  const blobs = { h1: bytes('alpha'), h2: bytes('beta') };
  const remote = makeRemote([
    { path: 'notes/a.md', size: 5, hash: 'h1' },
    { path: 'notes/b.md', size: 4, hash: 'h2' },
  ], blobs);
  const v = makeVault({ diskOnly: [['notes/a.md', 'alpha'], ['notes/b.md', 'beta']] });
  const p = await pluginFor(v.vault, { baseUrl: 'https://sync.notes.sarris.dev', vault: 'myvault' });
  p._activeRemote = remote;

  const summary = await p.runSyncWith(remote, true); // must NOT throw
  assert.equal(summary.downloaded, 2);
  assert.equal(summary.reloadNeeded, 2);
  // S stays ⊥ for index-blind writes → no phantom deletion can ever be
  // derived from them (planSync: L⊥ + S=hash + R=hash → pushDeletion).
  assert.deepEqual(p.settings.synced, {});
  assert.deepEqual(p._data.synced, {});

  // Second run, still blind: idempotent re-download, never a push.
  const again = await p.runSyncWith(remote, false);
  assert.equal(again.downloaded, 2);
  assert.equal(again.deleted, 0);
  assert.equal(remote.calls.commit.length, 0);
});

test('stale index: a file still on disk is never deleted on the server', async () => {
  // data.json from an older version recorded S=hash for a path the index
  // now cannot see (page never reloaded): L⊥ + S=R would push a deletion.
  const v = makeVault({ diskOnly: [['notes/gone.md', 'still-there']] });
  const remote = makeRemote([{ path: 'notes/gone.md', size: 11, hash: 'hx' }], { hx: bytes('still-there') });
  const p = await pluginFor(v.vault, {
    baseUrl: 'https://notes.sarris.dev',
    vault: 'myvault',
    synced: { 'notes/gone.md': 'hx' },
    mirror: {},
  });
  p._activeRemote = remote;

  const summary = await p.runSyncWith(remote, false);
  assert.equal(summary.deleted, 0);
  assert.equal(remote.calls.commit.length, 0, 'no deletion may reach the server');
  assert.equal(v.calls.delete.length, 0);
});

test('after the page reload the same files settle with no network at all', async () => {
  const h1 = sha('alpha');
  const blobs = { [h1]: bytes('alpha') };
  const remote = makeRemote([{ path: 'notes/a.md', size: 5, hash: h1 }], blobs);
  const v = makeVault({ diskOnly: [['notes/a.md', 'alpha']] });
  const p = await pluginFor(v.vault, { baseUrl: 'https://notes.sarris.dev', vault: 'myvault' });
  p._activeRemote = remote;

  await p.runSyncWith(remote, true); // blind write, S⊥
  const blobFetches = remote.calls.blob.length;

  // Page reload: the index now sees the bytes the adapter already holds.
  v.indexFile('notes/a.md', bytes('alpha'));

  const settled = await p.runSyncWith(remote, false);
  assert.equal(settled.downloaded, 0, 'L=R + S⊥ must settle without downloading');
  assert.equal(remote.calls.blob.length, blobFetches, 'no blob refetch');
  assert.equal(settled.deleted, 0);
  assert.deepEqual(p.settings.synced, { 'notes/a.md': h1 });
});

test('normal vault: pull creates indexed files, records synced, second run is a no-op', async () => {
  const h1 = sha('alpha');
  const remote = makeRemote([{ path: 'notes/a.md', size: 5, hash: h1 }], { [h1]: bytes('alpha') });
  const v = makeVault({});
  const p = await pluginFor(v.vault, { baseUrl: 'https://notes.sarris.dev', vault: 'myvault' });
  p._activeRemote = remote;

  const first = await p.runSyncWith(remote, false);
  assert.equal(first.downloaded, 1);
  assert.equal(first.reloadNeeded, 0);
  assert.deepEqual(p.settings.synced, { 'notes/a.md': h1 });

  const before = remote.calls.blob.length;
  const second = await p.runSyncWith(remote, false);
  assert.equal(second.downloaded, 0);
  assert.equal(remote.calls.blob.length, before);
  assert.equal(remote.calls.commit.length, 0);
});
