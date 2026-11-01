// build-assets.js — fixture build: a temp main-dir with the real src/ plus a
// fake vendor/obsidian-mobile/, so the full copy/inject pipeline runs without
// the (per-user, gitignored) real Obsidian bundle this environment doesn't
// have. Mirrors cloudflare's build-assets.test.js in intent: the committed
// markers/copy-list are the contract.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERCEL_DIR = path.resolve(HERE, '..');
const REAL_MAIN = path.resolve(VERCEL_DIR, '..', '..', '..');
const BUILD_SCRIPT = path.join(VERCEL_DIR, 'scripts', 'build-assets.js');
const PUBLIC_DIR = path.join(VERCEL_DIR, 'public');

let fixtureRoot;

function runBuild(root, extraEnv) {
  return spawnSync(process.execPath, [BUILD_SCRIPT], {
    cwd: VERCEL_DIR,
    encoding: 'utf8',
    env: { ...process.env, OW_BUILD_ASSETS_ROOT: root, ...(extraEnv || {}) },
  });
}

before(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-vercel-build-'));

  // real src/ (minus this package — the build never reads it) …
  fs.cpSync(path.join(REAL_MAIN, 'src'), path.join(fixtureRoot, 'src'), {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes('deployments') || !src.split(path.sep).includes('vercel'),
  });

  // … plus a stand-in vendor/obsidian-mobile/ (what scripts/update-obsidian-
  // mobile.js would produce locally; vendor/ is gitignored and absent here).
  const vendor = path.join(fixtureRoot, 'vendor', 'obsidian-mobile');
  fs.mkdirSync(path.join(vendor, 'i18n'), { recursive: true });
  fs.mkdirSync(path.join(vendor, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(vendor, 'app.js'), '// fixture app.js\n');
  fs.writeFileSync(path.join(vendor, 'app.css'), '/* fixture app.css */\n');
  fs.writeFileSync(path.join(vendor, 'worker.js'), '// fixture worker.js\n');
  fs.writeFileSync(path.join(vendor, 'i18n', 'main.json'), '{}');
  fs.writeFileSync(path.join(vendor, 'lib', 'noop.js'), '//\n');
});

after(() => {
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  if (fs.existsSync(PUBLIC_DIR)) fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
});

test('missing vendor/ fails loudly with the setup-script hint', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-vercel-novendor-'));
  try {
    const res = runBuild(empty);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /vendor\/obsidian-mobile/);
    assert.match(res.stderr, /update-obsidian-mobile/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('full fixture build: copies, cache-busts, injects, and drops no markers', () => {
  const res = runBuild(fixtureRoot);
  assert.equal(res.status, 0, 'build failed:\n' + res.stdout + '\n' + res.stderr);

  // copies
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'index.html')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'sw.js')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'manifest.webmanifest')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'client-mobile', 'boot.js')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'client-mobile', 'sync', 'run-sync.js')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'obsidian-mobile', 'app.js')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'worker.js')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'app.css')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'i18n', 'main.json')));
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'example-vault.json')));

  // no Vercel build artifacts for CF-only machinery
  assert.ok(!fs.existsSync(path.join(PUBLIC_DIR, '_worker.js')));
  assert.ok(!fs.existsSync(path.join(PUBLIC_DIR, '_headers')));

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(!html.includes('<!-- OW_CONFIG_INJECT -->'), 'config marker survived');
  assert.ok(!html.includes('<!-- OW_BACKEND_INJECT -->'), 'backend marker survived');
  assert.ok(html.includes('window.__owConfigInjected='), 'config not injected');
  assert.ok(html.includes('window.__owBackend="none"'), 'backend flag not injected');
  assert.ok(html.includes('window.__owDemoContent='), 'demo hash not injected');
  assert.match(html, /src="\/client-mobile\/[^"]+\?v=\d+"/, 'cache buster not applied');

  // Vercel Web Analytics: a handle boot.js loads from, not a <script defer> in
  // <head> (a deferred tag is cancelled when boot.js calls location.replace()
  // during parsing — see the analyticsHandle() comment).
  assert.ok(!html.includes('<!-- OW_ANALYTICS_INJECT -->'), 'analytics marker survived');
  assert.ok(!/<script[^>]+src="\/_vercel\/insights\/script\.js"/.test(html),
    'head still carries an analytics script tag — boot.js must be the loader');
  const analyticsPkg = JSON.parse(
    fs.readFileSync(path.join(VERCEL_DIR, 'node_modules', '@vercel', 'analytics', 'package.json'), 'utf8')
  );
  const handle = JSON.parse(
    /window\.__owAnalytics=(\{.*?\});<\/script>/.exec(html)[1]
  );
  assert.equal(handle.src, '/_vercel/insights/script.js', 'handle src wrong');
  assert.equal(handle.sdkn, '@vercel/analytics', 'handle sdkn wrong');
  assert.equal(handle.sdkv, analyticsPkg.version, 'handle sdkv must be the installed version');
  assert.ok(
    html.indexOf('window.__owAnalytics=') < html.indexOf('/client-mobile/boot.js'),
    'handle must be defined before boot.js reads it'
  );

  const sw = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  assert.ok(!sw.includes('__OW_BUILD__'), 'sw.js BUILD_ID not replaced');
  assert.ok(/const BUILD_ID = ['"]?\d+/.test(sw) || sw.includes(String(Math.floor(Date.now() / 1000)).slice(0, 4)),
    'sw.js build id does not look like a timestamp');

  // example vault is template.js's TEMPLATE_FILES as [name, content] pairs
  const example = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'example-vault.json'), 'utf8'));
  assert.ok(Array.isArray(example) && example.length > 0, 'example-vault.json empty');
  assert.ok(Array.isArray(example[0]) && example[0].length === 2, 'example-vault.json shape');

  const pluginsManifest = JSON.parse(
    fs.readFileSync(path.join(PUBLIC_DIR, 'system-plugins', 'manifest.json'), 'utf8')
  );
  assert.ok(Array.isArray(pluginsManifest.plugins), 'system-plugins manifest shape');
  const layout = pluginsManifest.plugins.find((p) => p.id === 'obsidian-web-layout');
  if (layout) {
    assert.ok(
      fs.existsSync(path.join(PUBLIC_DIR, 'system-plugins', 'obsidian-web-layout', 'manifest.json')),
      'layout plugin files not copied'
    );
    assert.match(layout.version, /^\d/);
  }

  // the LiveSync install step must not have crashed the build (it warns and
  // continues offline — vendor/plugins is absent in this environment)
  assert.match(res.stdout, /Done\./);
});

test('OW_ANALYTICS=off drops the tag (local dev builds)', () => {
  const res = runBuild(fixtureRoot, { OW_ANALYTICS: 'off' });
  assert.equal(res.status, 0, 'build failed:\n' + res.stdout + '\n' + res.stderr);
  assert.match(res.stdout, /analytics: skipped \(OW_ANALYTICS=off\)/);

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(!html.includes('window.__owAnalytics='), 'analytics handle survived OW_ANALYTICS=off');
  assert.ok(!html.includes('/_vercel/insights/'), 'insights path survived OW_ANALYTICS=off');
  assert.ok(!html.includes('<!-- OW_ANALYTICS_INJECT -->'), 'marker survived OW_ANALYTICS=off');
  // the rest of the pipeline is untouched by the opt-out
  assert.ok(html.includes('window.__owConfigInjected='), 'config not injected');
  assert.ok(html.includes('window.__owBackend="none"'), 'backend flag not injected');
});
