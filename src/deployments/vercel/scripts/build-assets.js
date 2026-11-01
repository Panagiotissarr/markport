// Build static assets for the Vercel deployment — MOBILE runtime.
//
// Node port of src/deployments/cloudflare/scripts/build-assets.sh — same
// sources, same markers, same cache-busting, so the two deployments ship an
// identical app. KEEP THE TWO IN SYNC: if a copy list or marker changes
// there, change it here.
//
// Reads from:  src/client-mobile/ + vendor/obsidian-mobile/ + src/config/ +
//              src/plugins/ (+ vendor/plugins for LiveSync)
// Writes to:   src/deployments/vercel/public/   (vercel.json outputDirectory)
//
// Differences vs the Cloudflare script:
//   - output lives in the package's public/ (Vercel serves it directly),
//     not .tmp/deployments/cloudflare/public/
//   - no _worker.js/ (Vercel functions live in api/) and no _headers
//     (Cloudflare-only); the /api/proxy-request and SPA-fallback behaviour
//     those provided comes from api/proxy-request.js + vercel.json rewrites
//   - written in Node instead of bash (this repo's Windows dev environment
//     has no bash), preserving the "fail LOUDLY on a missing marker" rules
//
// Run from the vercel/ directory:  npm run build
// OW_PROFILE=<name> selects src/config/deploy-config.<name>.json (unset = default).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERCEL_DIR = path.resolve(HERE, '..');
// Repo root, three levels up from src/deployments/vercel/. Overridable so
// the test suite can point the build at a fixture tree (test/build-assets.test.js).
const MAIN_DIR = process.env.OW_BUILD_ASSETS_ROOT || path.resolve(VERCEL_DIR, '..', '..', '..');
const PUBLIC_DIR = path.join(VERCEL_DIR, 'public');

function fail(message) {
  console.error('');
  console.error('ERROR: ' + message);
  console.error('');
  process.exit(1);
}

function mustExist(file, hint) {
  if (!fs.existsSync(file)) fail(hint ? `${file} not found. ${hint}` : `${file} not found.`);
}

// ── Vercel Web Analytics ────────────────────────────────────────────────────
// @vercel/analytics's inject() appends exactly this to document.head in a
// browser: a deferred script plus its SDK dataset (see the package's
// loadProps/getScriptSrc — path "/_vercel/insights/script.js" in production,
// data-sdkn = the package name, data-sdkv = its version). inject() cannot be
// called HERE: it early-returns without a DOM, so calling it at build time is
// a silent no-op. Emitting the markup it would have produced at runtime is the
// equivalent for a static shell, and it keeps the SDK path/version sourced
// from the installed package instead of hand-copied.
//
// VERCEL OUTPUT ONLY. src/client-mobile/index.html is shared by three targets;
// the Cloudflare build and the Node server serve no /_vercel/* routes, so a tag
// there would 404 on every boot. OW_ANALYTICS=off skips it (local dev builds,
// where /_vercel/insights/script.js does not exist either).
const ANALYTICS_SRC = '/_vercel/insights/script.js';

function analyticsTag() {
  const require = createRequire(import.meta.url);
  let version;
  try {
    version = require('@vercel/analytics/package.json').version;
  } catch (_) {
    fail(
      '@vercel/analytics is not installed — run `npm install` in ' +
        'src/deployments/vercel, or build with OW_ANALYTICS=off.'
    );
  }
  return (
    `<script defer src="${ANALYTICS_SRC}"` +
    ` data-sdkn="@vercel/analytics" data-sdkv="${version}"></script>`
  );
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  mustExist(src);
  fs.copyFileSync(src, dest);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Replace the config marker with a literal <script>window.__owConfigInjected=…
// (node, not string-replace-in-shell: the JSON payload may contain anything).
function injectMarker(html, marker, snippet, label) {
  if (!html.includes(marker)) {
    fail(`${label} marker ${marker} not found in ${path.join(PUBLIC_DIR, 'index.html')} — refusing to ship a build without it.`);
  }
  return html.replace(marker, snippet);
}

async function build() {
  console.log('obsidian-web Vercel — building assets (mobile)');
  console.log('  main project : ' + MAIN_DIR);
  console.log('  output       : ' + PUBLIC_DIR);

  // ── vendor check ─────────────────────────────────────────────────────────
  const vendorApp = path.join(MAIN_DIR, 'vendor', 'obsidian-mobile', 'app.js');
  if (!fs.existsSync(vendorApp)) {
    fail(
      'vendor/obsidian-mobile/ directory not found or incomplete.\n' +
      `Run first: node ${path.join(MAIN_DIR, 'scripts', 'update-obsidian-mobile.js')}`
    );
  }

  // ── deploy-config — single source of truth for plugins + injected config
  const profile = process.env.OW_PROFILE || '';
  const configPath = profile
    ? path.join(MAIN_DIR, 'src', 'config', `deploy-config.${profile}.json`)
    : path.join(MAIN_DIR, 'src', 'config', 'deploy-config.json');
  if (profile) console.log('  profile: ' + profile);
  if (!fs.existsSync(configPath)) {
    fail(
      profile
        ? `unknown OW_PROFILE '${profile}' — ${configPath} not found.`
        : `${configPath} not found — required for deploy config (plugins + injected config).`
    );
  }

  // ── clean and recreate public/ ───────────────────────────────────────────
  fs.rmSync(PUBLIC_DIR, { recursive: true, force: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  // ── client-mobile (shims + boot) and obsidian-mobile (renderer) ─────────
  console.log('  copying client-mobile/...');
  copyDir(path.join(MAIN_DIR, 'src', 'client-mobile'), path.join(PUBLIC_DIR, 'client-mobile'));

  console.log('  copying obsidian-mobile/...');
  copyDir(path.join(MAIN_DIR, 'vendor', 'obsidian-mobile'), path.join(PUBLIC_DIR, 'obsidian-mobile'));

  // Resource dirs mirrored at root (app.js fetches /i18n/*, /lib/*, …).
  console.log('  copying resource dirs...');
  for (const dir of ['i18n', 'lib', 'public', 'sandbox']) {
    const src = path.join(MAIN_DIR, 'vendor', 'obsidian-mobile', dir);
    if (fs.existsSync(src)) copyDir(src, path.join(PUBLIC_DIR, dir));
  }

  // Worker scripts at root — app.js does `new Worker("worker.js")` against
  // the document base URL, so they must sit at the site root.
  copyFile(
    path.join(MAIN_DIR, 'vendor', 'obsidian-mobile', 'worker.js'),
    path.join(PUBLIC_DIR, 'worker.js')
  );
  const simSrc = path.join(MAIN_DIR, 'vendor', 'obsidian-mobile', 'sim.js');
  if (fs.existsSync(simSrc)) copyFile(simSrc, path.join(PUBLIC_DIR, 'sim.js'));

  // Obsidian's stylesheet at the root: plugins that read Obsidian's own CSS
  // match a <link> whose href is EXACTLY 'app.css'/'/app.css'
  // (callout-manager's viaDom fallback throws otherwise).
  copyFile(
    path.join(MAIN_DIR, 'vendor', 'obsidian-mobile', 'app.css'),
    path.join(PUBLIC_DIR, 'app.css')
  );

  // ── index.html + PWA manifest ────────────────────────────────────────────
  console.log('  copying index.html...');
  copyFile(
    path.join(MAIN_DIR, 'src', 'client-mobile', 'index.html'),
    path.join(PUBLIC_DIR, 'index.html')
  );
  copyFile(
    path.join(MAIN_DIR, 'src', 'client-mobile', 'manifest.webmanifest'),
    path.join(PUBLIC_DIR, 'manifest.webmanifest')
  );

  // ── cache buster: /client-mobile/…?v=<build timestamp> ───────────────────
  const bust = Math.floor(Date.now() / 1000).toString();
  console.log('  cache buster: ' + bust);
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.replace(/\/client-mobile\/([^"]*)\?v=[^"&]*"/g, '/client-mobile/$1?v=' + bust + '"');

  // ── deploy-config inject (window.__owConfigInjected) ─────────────────────
  console.log('  injecting deploy-config (window.__owConfigInjected)...');
  const config = readJson(configPath);
  html = injectMarker(
    html,
    '<!-- OW_CONFIG_INJECT -->',
    '<script>window.__owConfigInjected=' + JSON.stringify(config) + '</script>',
    'OW_CONFIG_INJECT'
  );

  // ── example vault content → static JSON ─────────────────────────────────
  // template.js imports ./plugins-generated.js, which only the (retired)
  // CF build ever generated — stub it empty so template.js loads standalone.
  console.log('  building example-vault.json (static)...');
  const cfDir = path.join(MAIN_DIR, 'src', 'deployments', 'cloudflare');
  const stubPath = path.join(cfDir, 'plugins-generated.js');
  fs.writeFileSync(stubPath, 'export const PLUGIN_FILES = new Map();\n');
  let exampleVaultJson;
  try {
    const template = await import(pathToFileURL(path.join(cfDir, 'template.js')).href);
    exampleVaultJson = JSON.stringify([...template.TEMPLATE_FILES]);
  } finally {
    fs.rmSync(stubPath, { force: true });
  }
  const exampleVaultPath = path.join(PUBLIC_DIR, 'example-vault.json');
  fs.writeFileSync(exampleVaultPath, exampleVaultJson);

  // ── client-only signals inject (window.__owBackend/__owVersion/__owDemoContent)
  const versionPath = path.join(MAIN_DIR, 'src', 'config', 'version.json');
  if (!fs.existsSync(versionPath)) {
    fail(`${versionPath} not found — required for window.__owVersion.`);
  }
  const version = readJson(versionPath).version;
  const demoHash = sha256Hex(fs.readFileSync(exampleVaultPath)).slice(0, 16);
  console.log('  injecting client-only signals (window.__owBackend, window.__owVersion, window.__owDemoContent)...');
  html = injectMarker(
    html,
    '<!-- OW_BACKEND_INJECT -->',
    '<script>window.__owBackend="none";window.__owVersion=' +
      JSON.stringify(version) +
      ';window.__owDemoContent=' +
      JSON.stringify(demoHash) +
      ';</script>',
    'OW_BACKEND_INJECT'
  );

  // ── Vercel Web Analytics (see analyticsTag() above for why this is emitted
  // here rather than by calling inject()) ─────────────────────────────────
  if (process.env.OW_ANALYTICS === 'off') {
    console.log('  analytics: skipped (OW_ANALYTICS=off)');
  } else {
    if (!html.includes('</head>')) {
      fail('</head> not found in index.html — refusing to ship a build without analytics.');
    }
    const tag = analyticsTag();
    html = html.replace('</head>', '  ' + tag + '\n</head>');
    console.log('  analytics: injected ' + ANALYTICS_SRC);
  }

  fs.writeFileSync(indexPath, html);

  // ── service worker at the root (scope covers the whole app) ──────────────
  console.log(`  installing sw.js (BUILD_ID=${bust})...`);
  let sw = fs.readFileSync(path.join(MAIN_DIR, 'src', 'client-mobile', 'sw.js'), 'utf8');
  sw = sw.replace(/__OW_BUILD__/g, bust);
  fs.writeFileSync(path.join(PUBLIC_DIR, 'sw.js'), sw);

  // ── system plugins → static (seed-system-plugins.js falls back to these
  // when the deployment has no /api/system-plugins route) ──────────────────
  console.log('  building system-plugins/ (static)...');
  const layoutInstall = config.plugins['obsidian-web-layout'].install === true;
  const layoutEnabled = config.plugins['obsidian-web-layout'].enabled === true;
  const lsInstall = config.plugins['obsidian-livesync'].install === true;
  const lsEnabled = config.plugins['obsidian-livesync'].enabled === true;

  let layoutVer = '';
  if (layoutInstall) {
    const layoutSrc = path.join(MAIN_DIR, 'src', 'plugins', 'obsidian-web-layout');
    const layoutDest = path.join(PUBLIC_DIR, 'system-plugins', 'obsidian-web-layout');
    fs.mkdirSync(layoutDest, { recursive: true });
    for (const name of fs.readdirSync(layoutSrc)) {
      fs.copyFileSync(path.join(layoutSrc, name), path.join(layoutDest, name));
    }
    layoutVer = readJson(path.join(layoutSrc, 'manifest.json')).version;
  } else {
    console.log('  config: plugins.obsidian-web-layout.install=false — skipping layout-switcher');
  }

  let lsVersion = '';
  let lsFiles = [];
  if (lsInstall) {
    const pin = process.env.SEED_LIVESYNC_VERSION || '';
    const args = [path.join(MAIN_DIR, 'scripts', 'install-livesync.js')];
    if (pin) args.push('--version', pin);
    const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: MAIN_DIR });
    if (res.status === 0) {
      const lsSrc = path.join(MAIN_DIR, 'vendor', 'plugins', 'obsidian-livesync');
      if (fs.existsSync(path.join(lsSrc, 'main.js')) && fs.existsSync(path.join(lsSrc, 'manifest.json'))) {
        const dest = path.join(PUBLIC_DIR, 'system-plugins', 'obsidian-livesync');
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(path.join(lsSrc, 'main.js'), path.join(dest, 'main.js'));
        fs.copyFileSync(path.join(lsSrc, 'manifest.json'), path.join(dest, 'manifest.json'));
        lsFiles = ['main.js', 'manifest.json'];
        if (fs.existsSync(path.join(lsSrc, 'styles.css'))) {
          fs.copyFileSync(path.join(lsSrc, 'styles.css'), path.join(dest, 'styles.css'));
          lsFiles.push('styles.css');
        }
        lsVersion = readJson(path.join(lsSrc, 'manifest.json')).version;
      }
    } else {
      console.log('  WARN: obsidian-livesync download failed — skipping preinstall (build continues, layout-switcher only)');
    }
  } else {
    console.log('  config: plugins.obsidian-livesync.install=false — skipping LiveSync');
  }

  const plugins = [];
  if (layoutVer) {
    plugins.push({ id: 'obsidian-web-layout', version: layoutVer, files: ['main.js', 'manifest.json'], enabled: layoutEnabled });
  }
  if (lsVersion) {
    plugins.push({ id: 'obsidian-livesync', version: lsVersion, files: lsFiles, enabled: lsEnabled });
  }
  fs.mkdirSync(path.join(PUBLIC_DIR, 'system-plugins'), { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, 'system-plugins', 'manifest.json'), JSON.stringify({ plugins }));

  // ── summary ──────────────────────────────────────────────────────────────
  let files = 0;
  let bytes = 0;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        files++;
        bytes += fs.statSync(p).size;
      }
    }
  })(PUBLIC_DIR);

  console.log('');
  console.log('Done.');
  console.log(`  files : ${files}`);
  console.log(`  size  : ${(bytes / (1024 * 1024)).toFixed(1)} MB`);
  console.log('');
  console.log('Next:');
  console.log('  vercel deploy --prod   # publish (needs SYNC_TOKEN + DATABASE_URL env vars)');
  console.log('  npm run dev            # local dev, publishes nothing');
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  build().catch((err) => {
    console.error('');
    console.error('ERROR: build failed —', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

export { build, MAIN_DIR, PUBLIC_DIR };
