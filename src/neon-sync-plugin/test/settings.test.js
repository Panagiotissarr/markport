// Settings-tab render smoke test. main.js reads the Obsidian API through
// require('obsidian') at module load; this suite installs a Module._load
// hook with faithful stubs BEFORE requiring main.js, then actually runs
// onload() + display() — proving the tab renders every action row (the
// "press Connect but no Connect button" regression) and that hand-edited
// data.json values are normalized.
//
// node --test runs each file in its own process, so the hook cannot leak
// into plan.test.js / url.test.js (which exercise the pure functions with
// the no-Obsidian fallbacks).

const Module = require('node:module');
const origLoad = Module._load;

const rendered = []; // Setting rows constructed since the last reset

// Tests flip this OFF to simulate older Obsidian bundles (the pinned mobile
// build behind the web app) whose TextComponent has NO setInputType — the
// unguarded call threw and killed display() below the Password row.
let textHasSetInputType = true;

class TextComponentStub {
  constructor() {
    this.value = '';
    this.placeholder = '';
    this._onChange = null;
    this.inputType = null;
    this.inputEl = { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
    if (textHasSetInputType) {
      // Instance-level so `typeof t.setInputType === 'function'` sees
      // exactly what a real component would expose.
      this.setInputType = (ty) => { this.inputType = String(ty); return this; };
    }
  }
  setPlaceholder(p) { this.placeholder = p; return this; }
  setValue(v) { this.value = v; return this; }
  onChange(fn) { this._onChange = fn; return this; }
}

class ButtonComponentStub {
  constructor() { this.text = ''; this.cta = false; this.disabled = false; this._onClick = null; }
  setButtonText(t) { this.text = String(t); return this; }
  setCta() { this.cta = true; return this; }
  setDisabled(d) { this.disabled = !!d; return this; }
  onClick(fn) { this._onClick = fn; return this; }
}

class ToggleComponentStub {
  constructor() { this.value = false; this._onChange = null; }
  setValue(v) { this.value = !!v; return this; }
  onChange(fn) { this._onChange = fn; return this; }
}

class SettingStub {
  constructor() { this.name = ''; this.desc = ''; this.buttons = []; this.texts = []; this.toggles = []; rendered.push(this); }
  setName(n) { this.name = String(n); return this; }
  setDesc(d) { this.desc = String(d); return this; }
  addText(cb) { const t = new TextComponentStub(); cb(t); this.texts.push(t); return this; }
  addButton(cb) { const b = new ButtonComponentStub(); cb(b); this.buttons.push(b); return this; }
  addToggle(cb) { const t = new ToggleComponentStub(); cb(t); this.toggles.push(t); return this; }
}

const notices = [];
class NoticeStub { constructor(msg) { this.msg = String(msg); notices.push(this); } }

class PluginStub {
  constructor(app, manifest) {
    this.app = app || {};
    this.manifest = manifest || { id: 'test', version: '0.0.0-test' };
    this.commands = [];
    this.tabs = [];
    this.ribbons = [];
    this._data = {};
  }
  addRibbonIcon(icon, title, cb) { this.ribbons.push({ icon, title, cb }); }
  addCommand(c) { this.commands.push(c); }
  addSettingTab(t) { this.tabs.push(t); }
  registerInterval() {}
  async loadData() { return this._data; }
  async saveData(d) { this._data = d; }
}

class PluginSettingTabStub {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = { empty() {} };
  }
}

Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') {
    return {
      Plugin: PluginStub,
      PluginSettingTab: PluginSettingTabStub,
      Notice: NoticeStub,
      Setting: SettingStub,
      normalizePath: (p) => String(p),
      requestUrl: null, // network paths are not exercised here
    };
  }
  return origLoad.apply(this, arguments);
};

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Plugin = require('../main.js');

async function bootedPlugin(data) {
  // Plugin (the real class from main.js) extends PluginStub via the hook —
  // instantiating IT (not the base) gives us onload()/loadSettings()/etc.
  const p = new Plugin({ vault: {} }, { id: 'markport-neon-sync', version: '0.2.4' });
  if (data) p._data = data;
  await p.onload();
  return p;
}

test('onload registers the ribbon, all three commands and the settings tab', async () => {
  const p = await bootedPlugin();
  assert.equal(p.ribbons.length, 1);
  const ids = p.commands.map((c) => c.id);
  for (const id of ['neon-connect', 'neon-sync-now', 'neon-pull-only']) {
    assert.ok(ids.includes(id), 'missing command: ' + id);
  }
  assert.equal(p.tabs.length, 1);
});

test('display() renders EVERY action on its own row — Connect, Check, Sync now, Pull', async () => {
  const p = await bootedPlugin();
  rendered.length = 0;
  p.tabs[0].display();

  const rows = rendered.filter((r) => r.buttons.length > 0);
  const labels = rows.flatMap((r) => r.buttons.map((b) => b.text));
  for (const label of ['Connect', 'Check', 'Sync now', 'Pull']) {
    assert.ok(labels.includes(label), 'missing button: ' + label);
  }
  // One button per row → nothing can clip off-screen on narrow layouts.
  for (const r of rows) assert.equal(r.buttons.length, 1, 'row "' + r.name + '" shares buttons');

  const connectRow = rows.find((r) => r.buttons[0].text === 'Connect');
  assert.ok(connectRow.buttons[0].cta, 'Connect should be the CTA');
  assert.ok(/Markport Neon Sync v0\.2\.4/.test(rendered[0].name), 'header should show the version');

  const pwRow = rendered.find((r) => r.name === 'Password');
  assert.equal(pwRow.texts[0].inputType, 'password', 'password field should be masked');
});

test('older bundles without setInputType: display() survives and masks via inputEl', async () => {
  // Regression: "t.setInputType is not a function" at NeonSyncSettingTab
  // .display() killed the tab halfway down — Token, Status and all four
  // action rows (Connect!) never rendered. The field must degrade instead.
  const p = await bootedPlugin();
  textHasSetInputType = false;
  try {
    rendered.length = 0;
    assert.doesNotThrow(() => p.tabs[0].display(), 'display() must not throw');

    const pwRow = rendered.find((r) => r.name === 'Password');
    assert.equal(pwRow.texts[0].inputEl.attrs.type, 'password', 'fallback type=password on inputEl');

    const labels = rendered.flatMap((r) => r.buttons.map((b) => b.text));
    for (const label of ['Connect', 'Check', 'Sync now', 'Pull']) {
      assert.ok(labels.includes(label), 'row below Password never rendered: ' + label);
    }
    // The rest of the text fields (and their handlers) still work.
    const urlRow = rendered.find((r) => r.name === 'Vault URL');
    await urlRow.texts[0]._onChange('https://notes.sarris.dev/vault/demo');
    assert.equal(p.settings.vault, 'demo');
  } finally {
    textHasSetInputType = true;
  }
});

test('Vault URL field fills Server URL + Vault name (settings AND their inputs)', async () => {
  const p = await bootedPlugin();
  rendered.length = 0;
  p.tabs[0].display();

  const urlRow = rendered.find((r) => r.name === 'Vault URL');
  assert.ok(urlRow, 'Vault URL row missing');
  await urlRow.texts[0]._onChange('https://notes.sarris.dev/vault/myvault');
  assert.equal(p.settings.baseUrl, 'https://notes.sarris.dev');
  assert.equal(p.settings.vault, 'myvault');

  const serverRow = rendered.find((r) => r.name === 'Server URL');
  const vaultRow = rendered.find((r) => r.name === 'Vault name');
  assert.equal(serverRow.texts[0].value, 'https://notes.sarris.dev');
  assert.equal(vaultRow.texts[0].value, 'myvault');
  assert.match(urlRow.desc, /press Connect/);
});

test('hand-edited data.json: scheme-less baseUrl normalizes on load (http for local hosts)', async () => {
  const p = await bootedPlugin({ baseUrl: 'localhost:3000/', vault: 'myvault' });
  assert.equal(p.settings.baseUrl, 'http://localhost:3000');

  const p2 = await bootedPlugin({ baseUrl: 'notes.sarris.dev', vault: 'x' });
  assert.equal(p2.settings.baseUrl, 'https://notes.sarris.dev');

  const p3 = await bootedPlugin({ baseUrl: 'https://notes.sarris.dev///', vault: 'x' });
  assert.equal(p3.settings.baseUrl, 'https://notes.sarris.dev');
});

test('normalizeBaseUrl / isLocalHostName', () => {
  const { normalizeBaseUrl, isLocalHostName } = Plugin;
  assert.equal(normalizeBaseUrl('localhost:3000/'), 'http://localhost:3000');
  assert.equal(normalizeBaseUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normalizeBaseUrl('10.0.0.5'), 'http://10.0.0.5');
  assert.equal(normalizeBaseUrl('172.16.0.9'), 'http://172.16.0.9');
  assert.equal(normalizeBaseUrl('nas.local'), 'http://nas.local');
  assert.equal(normalizeBaseUrl('[::1]:3000'), 'http://[::1]:3000');
  assert.equal(normalizeBaseUrl('notes.sarris.dev'), 'https://notes.sarris.dev');
  assert.equal(normalizeBaseUrl('https://notes.sarris.dev/'), 'https://notes.sarris.dev');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(normalizeBaseUrl(null), '');
  assert.equal(isLocalHostName('172.32.0.1'), false); // outside the 172.16-31 range
  assert.equal(isLocalHostName('LOCALHOST'), true);
});

test('Connect row click runs plugin.connect and reports via Notice', async () => {
  const p = await bootedPlugin({ baseUrl: 'http://localhost:1', vault: 'x', password: 'pw' });
  rendered.length = 0;
  notices.length = 0;
  p.tabs[0].display();
  const connectRow = rendered.find((r) => r.buttons.some((b) => b.text === 'Connect'));
  // requestUrl is null in the stub → connect() fails with a transport error;
  // what matters here is that the click handler runs and surfaces a Notice.
  await connectRow.buttons[0]._onClick();
  assert.equal(notices.length, 1);
  assert.match(notices[0].msg, /^Neon sync: /);
});

// ── credential at rest (security) ──────────────────────────────────────────
// data.json lives in <vault>/.obsidian/plugins/<id>/, i.e. INSIDE a folder
// that gets copied (cloud backup, other sync tools) and that the web build's
// own sync even pushes to the server. A plaintext vault password there is a
// credential leak; the token (expiring, single-vault) is enough to keep sync
// working across restarts.

test('password is NOT written to data.json by default', async () => {
  const p = await bootedPlugin();
  p.settings.password = 'correct horse battery staple';
  await p.saveSettings();
  assert.equal(p._data.password, undefined, 'password leaked into data.json');
  // …but it is still usable in memory for this session.
  assert.equal(p.settings.password, 'correct horse battery staple');
});

test('opting in to Remember password persists it', async () => {
  const p = await bootedPlugin();
  p.settings.password = 'pw-12345678';
  p.settings.rememberPassword = true;
  await p.saveSettings();
  assert.equal(p._data.password, 'pw-12345678');
});

test('a password left in data.json by an older version is used, then dropped', async () => {
  const p = await bootedPlugin({ baseUrl: 'https://notes.sarris.dev', vault: 'v', password: 'legacy-pw' });
  // Usable for this session…
  assert.equal(p.settings.password, 'legacy-pw');
  // …and gone from disk after the next save.
  await p.saveSettings();
  assert.equal(p._data.password, undefined);
});

test('turning Remember password off forgets the password immediately', async () => {
  const p = await bootedPlugin({ password: 'pw-abcdefgh', rememberPassword: true });
  rendered.length = 0;
  p.tabs[0].display();
  const row = rendered.find((r) => r.name === 'Remember password');
  assert.ok(row, 'Remember password row missing');
  await row.toggles[0]._onChange(false);
  assert.equal(p.settings.password, undefined);
  assert.equal(p._data.password, undefined);
});

test('the token is still persisted (sync survives a restart without the password)', async () => {
  const p = await bootedPlugin();
  p.settings.token = 'mpv1.abc.123.sig';
  await p.saveSettings();
  assert.equal(p._data.token, 'mpv1.abc.123.sig');
});
