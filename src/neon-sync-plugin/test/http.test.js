// Transport-layer tests against a response object shaped like the one
// Obsidian's requestUrl actually hands back (0.2.3).
//
// The real failure this pins, from a browser-build console:
//
//   plugin:markport-neon-sync:827 [neon-sync] failed: SyntaxError: Unexpected
//   token '/', "/* THIS IS"... is not valid JSON
//       at get json (app.js:1:1252750)
//       at httpOnce (plugin:markport-neon-sync:421:18)
//       at async Object.blob (plugin:markport-neon-sync:579:15)
//
// Obsidian exposes `text` / `json` / `arrayBuffer` as GETTERS and the `json`
// getter THROWS on any non-JSON body. blob GET returns raw note bytes, so
// every pull died on the first note that wasn't JSON. The fix reads each
// accessor defensively; these tests use throwing getters so a regression
// fails here instead of in someone's vault.

const Module = require('node:module');
const origLoad = Module._load;

let requestUrlImpl = null;

Module._load = function (request) {
  if (request === 'obsidian') {
    return {
      Plugin: class { constructor(app, manifest) { this.app = app; this.manifest = manifest; } },
      PluginSettingTab: class { constructor() {} },
      Notice: class { constructor(msg) { this.msg = String(msg); } },
      Setting: class {},
      normalizePath: (p) => String(p),
      // main.js captures this at load time; the indirection lets each test
      // install its own response.
      requestUrl: (opts) => requestUrlImpl(opts),
    };
  }
  return origLoad.apply(this, arguments);
};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Plugin = require('../main.js');

const bytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

// A Response lookalike with Obsidian's getter semantics: every body accessor
// is a getter, `json` throws for non-JSON, `text` throws for binary.
function responseLike(opts) {
  opts = opts || {};
  const body = opts.bytes; // Uint8Array | null
  const plain = opts.text; // string | null
  const res = { status: opts.status === undefined ? 200 : opts.status, headers: {} };
  Object.defineProperty(res, 'text', {
    get() {
      if (plain !== null && plain !== undefined) return plain;
      if (body) return Buffer.from(body).toString('utf8');
      return '';
    },
  });
  Object.defineProperty(res, 'json', {
    get() {
      const t = this.text;
      return JSON.parse(t); // throws SyntaxError — exactly like Obsidian
    },
  });
  Object.defineProperty(res, 'arrayBuffer', {
    get() {
      const b = body || (plain ? bytes(plain) : new Uint8Array(0));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  });
  return res;
}

function stub(status, body) {
  requestUrlImpl = async () => responseLike({ status: status, bytes: body });
}
function stubText(status, text) {
  requestUrlImpl = async () => responseLike({ status: status, text: text });
}

// ── httpOnce ───────────────────────────────────────────────────────────────

test('httpOnce: a binary body does not throw (the blob crash)', async () => {
  const note = bytes('/*\nTHIS IS a CSS snippet note\n*/\nbody { color: red }\n');
  stub(200, note);
  const res = await Plugin.httpOnce({ url: 'https://notes.sarris.dev/sync/v1/blob/abc' });
  assert.equal(res.status, 200);
  assert.equal(res.json, null, 'non-JSON body must yield null, not throw');
  assert.equal(new Uint8Array(res.arrayBuffer).length, note.length, 'bytes survive intact');
});

test('httpOnce: a JSON body is still parsed', async () => {
  stubText(200, '{"cursor":null,"entries":[]}');
  const res = await Plugin.httpOnce({ url: 'https://notes.sarris.dev/sync/v1/manifest' });
  assert.deepEqual(res.json, { cursor: null, entries: [] });
});

test('httpOnce: an HTML error page keeps its text and yields json=null', async () => {
  stubText(500, '<!DOCTYPE html><html><body>An error occurred</body></html>');
  const res = await Plugin.httpOnce({ url: 'https://sync.notes.sarris.dev/sync/v1/manifest' });
  assert.equal(res.status, 500);
  assert.equal(res.json, null);
  assert.match(res.text, /An error occurred/);
});

// ── remote client ──────────────────────────────────────────────────────────

function remoteFor(over) {
  return Plugin.createRemote(Object.assign({
    baseUrl: 'https://notes.sarris.dev',
    vault: 'myvault',
    token: 'mpv1.fake',
  }, over));
}

test('blob(): pulls raw note bytes through the getters without exploding', async () => {
  const note = bytes('/*\nTHIS IS\n*/\n');
  stub(200, note);
  const remote = remoteFor();
  const buf = await remote.blob('deadbeef');
  assert.equal(new Uint8Array(buf).length, note.length);
});

test('manifest(): a crashed deployment reports HTTP 500 AND what it means', async () => {
  stubText(500,
    '{"error":{"code":"FUNCTION_INVOCATION_FAILED","message":"An error occurred with your deployment"}}');
  const remote = remoteFor({ baseUrl: 'https://sync.notes.sarris.dev' });
  await assert.rejects(
    () => remote.manifestAll(),
    (err) => {
      assert.match(err.message, /manifest: HTTP 500/);
      assert.match(err.message, /deployment crashed before answering/, 'actionable hint');
      assert.match(err.message, /FUNCTION_INVOCATION_FAILED/, 'body excerpt included');
      return true;
    },
  );
});

test('statusDetail(): quiet on ordinary bodies, loud on deployment crashes', () => {
  assert.equal(Plugin.statusDetail({ text: '{"error":"vault not found"}' }), ' [{"error":"vault not found"}]');
  assert.match(Plugin.statusDetail({ text: 'NO_RESPONSE_FROM_FUNCTION' }), /deployment crashed/);
  assert.equal(Plugin.statusDetail({}), '');
  assert.equal(Plugin.statusDetail(null), '');
});
