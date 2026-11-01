/**
 * boot.js — mobile client
 *
 * מקביל ל-client/boot.js של הddesktop:
 *  1. בחירת vault + localStorage
 *  2. חישוב Platform overrides (לפני שה-bundle רץ)
 *  3. הגדרת window.require לפלאגינים
 *  4. async: אימות vault → הזרקה דינמית של scripts → הסרת ספינר
 *
 * הפריסה (mobile/desktop) נקבעת ב-client-mobile/platform-bridge.js —
 * יירוט Object.defineProperty בזמן ריצה שקורא את ה-overrides שנקבעים כאן
 * (ראה docs/plans/runtime-platform-descriptors.md). אפס build-time patches
 * על vendor/obsidian-mobile/app.js (docs/plans/zero-patches.md) — כל
 * התנהגות-הפלטפורמה, כולל פאנל ה-vault-profile, מותאמת ברמת-ריצה, לא ע"י
 * עריכת app.js. כאן רק קובעים את ה-overrides ש-platform-bridge.js יקרא
 * בעצלתיים בזמן ה-install.
 */

// רשימת הscripts של Obsidian Mobile — מוזרקים דינמית אחרי האימות.
// הlib חייבים לפני app.js (globals שנקראים ב-module level).
const MOBILE_SCRIPTS = [
  '/obsidian-mobile/lib/codemirror/codemirror.js',
  '/obsidian-mobile/lib/codemirror/overlay.js',
  '/obsidian-mobile/lib/codemirror/markdown.js',
  '/obsidian-mobile/lib/codemirror/cm-addons.js',
  '/obsidian-mobile/lib/codemirror/vim.js',
  '/obsidian-mobile/lib/codemirror/meta.min.js',
  '/obsidian-mobile/lib/moment.min.js',
  '/obsidian-mobile/lib/pixi.min.js',
  '/obsidian-mobile/lib/i18next.min.js',
  '/obsidian-mobile/lib/scrypt.js',
  '/obsidian-mobile/lib/turndown.js',
  '/obsidian-mobile/enhance.js',
  '/obsidian-mobile/i18n.js',
  '/obsidian-mobile/app.js',
];

(function () {
  'use strict';

  if (typeof global === 'undefined') window.global = window;

  // ── Quiet the browser's "persistent storage" prompt ──────────────────────
  // Obsidian's bundle (Capacitor-derived code paths) can ask the browser for
  // persistent storage — navigator.storage.persist(), or the legacy
  // navigator.webkitPersistentStorage.requestQuota() — which makes some
  // browsers show a permission popup ("…wants to store data on your
  // device"). The answer changes nothing for us: OPFS/localStorage/IndexedDB
  // already work without the grant, and eviction under real storage pressure
  // stays the browser's business either way. Answer "yes" silently, before
  // app.js is ever injected — no popup, no behavior lost.
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist = function () { return Promise.resolve({ persisted: true }); };
    }
  } catch (e) { /* read-only implementation — nothing we can do */ }
  try {
    ['webkitPersistentStorage', 'webkitTemporaryStorage'].forEach(function (prop) {
      var q = navigator[prop];
      if (q && typeof q.requestQuota === 'function') {
        q.requestQuota = function (bytes, successCb) {
          if (typeof successCb === 'function') setTimeout(function () { successCb(bytes || 0); }, 0);
        };
      }
    });
  } catch (e) { /* ditto */ }

  // ── One-time migration: persistent mpv1 tokens → session-only ───────────
  // Earlier builds stored the password-claim token (mpv1.*, 90-day TTL) in
  // localStorage['ow-sync:<name>'], so the credential survived closing the
  // browser. Credentials are session-scoped now ("forget the password when
  // the page is closed" — saveClaimedVault below writes sessionStorage):
  // convert each legacy entry to the NON-SECRET 'ow-sync-claimed:<name>'
  // marker (baseUrl + vault name only) and delete the persisted token. The
  // marker is what makes the next boot re-prompt for the password instead of
  // silently running unsynced. Manual operator configs (a raw SYNC_TOKEN —
  // never 'mpv1.*') stay in localStorage untouched, exactly as before.
  (function migrateLegacyClaimTokens() {
    try {
      var drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('ow-sync:') !== 0) continue;
        var parsed = null;
        try { parsed = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) {}
        if (parsed && typeof parsed.token === 'string' && parsed.token.indexOf('mpv1.') === 0) {
          var name = k.slice('ow-sync:'.length);
          if (name && !localStorage.getItem('ow-sync-claimed:' + name)) {
            localStorage.setItem('ow-sync-claimed:' + name, JSON.stringify({
              baseUrl: parsed.baseUrl || location.origin,
              vault: parsed.vault || name,
            }));
          }
          drop.push(k);
        }
      }
      for (var j = 0; j < drop.length; j++) localStorage.removeItem(drop[j]);
      if (drop.length) {
        console.log('[obsidian-web] moved ' + drop.length +
          ' claimed-vault credential(s) to session-only storage (password will be asked once per session)');
      }
    } catch (e) { /* private mode / storage blocked — nothing to migrate */ }
  })();

  // ── Vault selection — path-based routing (brief §0/§3ב) ────────────────────
  // מקור-האמת עבר מ-?vault= (query, נמחק) ל-location.pathname:
  //   /vault/<id> → כספת פתוחה <id> (גלוי, ניתן-לשיתוף/סימניה)
  //   /starter    → מסך-בחירה, מתעלם מ-auto-resume (mobile-selected-vault/lastVaultId)
  //   כל path אחר (/, /mobile וכו') → entry: יש כספת-אחרונה → /vault/<id>; אחרת → /starter
  var __owPath = location.pathname;
  // vault-note-deeplink §3א: מפריד id (סגמנט יחיד — ids אמיתיים הם hashים בלי
  // slash) מ-note-path (רב-סגמנטי, עשוי לכלול slashים — Features/Tags וכו').
  var __owVaultMatch = __owPath.match(/^\/vault\/([^/]+)(?:\/(.*))?$/);
  var VAULT_ID = __owVaultMatch ? decodeURIComponent(__owVaultMatch[1]) : '';
  // פענוח פר-סגמנט (שומר slashים כמפרידי-נתיב, מפענח תווים מקודדים בתוך שם).
  var NOTE_PATH = (__owVaultMatch && __owVaultMatch[2])
                    ? __owVaultMatch[2].split('/').map(decodeURIComponent).join('/')
                    : '';
  var forceStarter = (__owPath === '/starter');

  // ── מסך-פתיחה נייטיב — helpers (opfs-ux) ───────────────────────────────────
  // הנייטיב (`.mobile-vault-chooser-screen`) שומר בחירת-vault תחת
  // 'mobile-selected-vault'. אנחנו כותבים לשם ערכים בצורה '<id>/<name>'
  // (executor spike: docs/plans/opfs-ux.md §3ה — הפורמט האמיתי ש-Obsidian
  // מצפה לו ב-Lte הוא מערך של path-strings גולמיים, לא אובייקטים {name,
  // location,storageType} כפי שהבריף המקורי הניח; ve()/basename מחלץ את השם
  // מהמחרוזת עצמה — לכן 'id/name' נותן גם id-חילוץ נקי וגם שם קריא).
  // owNativeVaultIdFromValue מחלץ את ה-id ומאמת מול registry מקומי
  // (local/folder) או ow-known-vault-ids (גם server) — למניעת loop על ערך יתום.
  function owNativeVaultIdFromValue(value) {
    if (!value) return null;
    var slash = value.indexOf('/');
    var id = slash !== -1 ? value.slice(0, slash) : value;
    if (window.__owLocalVaults && window.__owLocalVaults.get(id)) return id;
    var known = [];
    try { known = JSON.parse(localStorage.getItem('ow-known-vault-ids') || '[]'); } catch (e) {}
    if (known.indexOf(id) !== -1) return id;
    return null;
  }

  // navigateToVault — path-based, **אבסולוטי** (brief §3ב): '/vault/<id>' הוא
  // עכשיו מקור-האמת ל-URL, גלוי ונשאר (ניתן-לשיתוף/סימניה) — לא תלוי יותר
  // באיזה path הגיש את הדף (CF/מקומי מגישים שניהם אותו shell). משמש הן ע"י
  // ה-Create-vault interceptor למטה והן ע"י הגישור native-vault-open (Bug 2b).
  function navigateToVault(id) {
    location.href = '/vault/' + encodeURIComponent(id);
  }

  // DEMO_ID — הועלה לכאן, לפני בלוק ניתוב-הכניסה למטה (docs/plans/
  // demo-origin-split.md §4 Commit 2, 🔴 אילוץ סדר): הבלוק הזה משתמש בו
  // כדי להפנות ישירות לכספת הדמו כשאין VAULT_ID/כספת-אחרונה ו-autoOpen
  // דולק. ensureDemo() והקריאה `if (VAULT_ID === DEMO_ID) ensureDemo();`
  // (§3ג) נשארות במקומן למטה — רק ההגדרה הועלתה, לא הלוגיקה שתלויה בה.
  var DEMO_ID = (window.__owConfig && window.__owConfig.demoVault && window.__owConfig.demoVault.id) || '0000demo0000demo';

  // מודל הנייטיב: 'mobile-selected-vault' = "כספת פתוחה/נבחרה" — מקור-האמת
  // (Bug 1, brief §0/§3א). היעדרו פירושו native close/"ניהול כספות" (quick
  // action 'close-vault' מוחק את המפתח ועושה reload) — כוונה מפורשת לחזור
  // למסך-הפתיחה, ולכן *לא* נופלים חזרה ל-lastVaultId (זו הייתה הסיבה
  // שהמסך לא חזר: lastVaultId שלנו נשאר מלא כי הנייטיב לא מנקה אותו).
  // אם sel קיים אבל לא ניתן לפענוח מול הregistry (יתום/stale) — fallback
  // ל-lastVaultId, כדי לא לשבור server-vault resume (§3א, DoD#4/#5).
  //
  // path-based routing (brief §3ב): /vault/<id> כבר קבע VAULT_ID מה-path —
  // אין צורך להתייעץ עם localStorage. /starter מתעלם מ-auto-resume לגמרי
  // (forceStarter, למטה — זו דרך-המילוט היחידה למסך-הפתיחה בדומיין הדמו,
  // ממשיכה לעקוף גם את הפתיחה-האוטומטית למטה). רק path "entry" (לא
  // /vault/<id>, לא /starter — /, /mobile וכו') מפנה בעצמו ל-/vault/<id> (יש
  // כספת-אחרונה), ל-/vault/<DEMO_ID>/Welcome (אין כספת-אחרונה אבל
  // demoVault.autoOpen דולק — docs/plans/demo-origin-split.md §4 Commit 2,
  // note-path עודכן ל-/Welcome ב-Commit 6 אחרי calev-heavy, ראה שם), או
  // ל-/starter (אף אחד מהשניים) — location.replace (לא push) כדי שלא ייווצר
  // loop ב-back.
  //
  // ── /{VAULT_NAME} → /vault/{VAULT_NAME} (קישור-קצר) ──────────────────────
  // A bare single-segment path IS a vault name: redirect to the canonical
  // /vault/<name> URL (location.replace — no back-loop). The server routers
  // (runtime-server's /:name route, the Cloudflare Worker, vercel.json's
  // redirect, vercel's dev.js) answer these paths with a 302 FIRST — this
  // client-side twin covers the cases where the shell still lands here
  // unredirected: the offline service-worker fallback (sw.js serves the
  // cached '/' shell for ANY failed navigation) and stale deployments.
  // starter-url.js's shortPathSegment is the shared rule: one segment, no
  // dot (real files), not reserved (/api, /starter, /mobile, /client-mobile,
  // …), vault-name charset. '/' itself and multi-segment paths fall through
  // to the entry logic below, unchanged.
  if (!VAULT_ID && !forceStarter && window.__owStarterUrl) {
    var __owShortName = window.__owStarterUrl.shortPathSegment(__owPath);
    if (__owShortName) {
      location.replace('/vault/' + encodeURIComponent(__owShortName));
      return;   // מנווטים החוצה — אין מה לעשות יותר בטיק הזה
    }
  }

  if (forceStarter) {
    // מנקה מפתח-בחירה פעם-אחת (בלי reload נוסף — אין loop) כדי שהבאנדל
    // הנייטיב לא ינסה auto-open כשהוא רץ מיד למטה (מסך-הפתיחה, no-vault).
    if (localStorage.getItem('mobile-selected-vault')) localStorage.removeItem('mobile-selected-vault');
    localStorage.removeItem('obsidian-web:lastVaultId');
  } else if (!VAULT_ID) {
    var sel = localStorage.getItem('mobile-selected-vault');
    var resumeId = sel ? (owNativeVaultIdFromValue(sel) || localStorage.getItem('obsidian-web:lastVaultId') || '') : '';
    if (!sel) localStorage.removeItem('obsidian-web:lastVaultId');
    if (resumeId) {
      location.replace('/vault/' + encodeURIComponent(resumeId));
    } else {
      // דמו — פתיחה-אוטומטית (§0 מטרה: מבקר בדומיין הדמו נוחת ישירות בכספת,
      // אפס לחיצות). ES5 guard pattern (כמו ensureDemo/DEMO_ID למעלה) —
      // demoVault.autoOpen===true במפורש (לא ייתכן "on by default" — ברירת-
      // המחדל היא ללא-דמו, §9 שאלה 1) וגם enabled!==false (opt-out מפורש
      // מבטל גם autoOpen).
      var d = window.__owConfig && window.__owConfig.demoVault;
      if (d && d.autoOpen === true && d.enabled !== false) {
        // /Welcome (docs/plans/demo-origin-split.md §4 Commit 6, calev-heavy
        // runtime-gate finding 1): a bare /vault/<demoId> lands on Obsidian's
        // empty "New tab" screen — Welcome.md exists but isn't open. .obsidian/
        // (workspace.json, app.json's defaultViewMode) is deliberately never
        // seeded (finding 1), so routing straight to the note is the only
        // remaining way to actually render it, zero clicks, as §1 promises.
        location.replace('/vault/' + encodeURIComponent(DEMO_ID) + '/Welcome');
      } else {
        location.replace('/starter');
      }
    }
    return;   // מנווטים החוצה — אין מה לעשות יותר בטיק הזה
  }

  // ── Demo vault — lazy create-if-missing (seed-demo §3ג) ────────────────────
  // Fixed-id demo vault (window.__owConfig.demoVault.id, default
  // '0000demo0000demo') — NOT registered ahead of time (brief §0 decision 2:
  // registry stays empty for a brand-new user → native onboarding screen,
  // not the vault-chooser, DoD#3). ensureDemo() is the only thing that ever
  // writes the Demo's registry entry — called here for the share-link
  // (/vault/<demoId>, DoD#5) and from the starter-screen button (installed
  // in a later commit, DoD#4). Idempotent: get(DEMO_ID) truthy on repeat
  // visits → no-op (the fixed id, not a fresh uuid, is what makes this work
  // — local-vault-registry.js create() opts.id, seed-demo §3א).
  // (DEMO_ID itself is defined earlier, before the entry-routing block —
  // see the comment there, Commit 2 — so the routing block below can use it.)
  function ensureDemo() {
    // ES5 guard, avigail round-2 fix (precedence bug in the brief's draft
    // pseudocode `!d.enabled ?? true`, which isn't even valid without `??`):
    // `d && d.enabled === false` — explicit opt-out only; missing config or
    // missing `enabled` key both default to "on".
    var d = window.__owConfig && window.__owConfig.demoVault;
    if (d && d.enabled === false) return null;
    if (window.__owLocalVaults && !window.__owLocalVaults.get(DEMO_ID)) {
      window.__owLocalVaults.create('Demo', { id: DEMO_ID });
    }
    return DEMO_ID;
  }

  // /vault/<demoId> — share-link (DoD#5): create-if-missing on first visit;
  // repeat visits find the registry entry already there (idempotent, no-op).
  // Once created, VAULT_TYPE below resolves to 'local' (registry lookup
  // succeeds) instead of falling back to 'server' for an unknown id.
  if (VAULT_ID === DEMO_ID) ensureDemo();

  // Vault type: 'local' (OPFS, no server round-trip), 'folder' (real
  // directory picked via showDirectoryPicker, also OPFS-store-backed — see
  // capacitor-shim's fsBackend), or 'server' (HTTP /api/fs). Determined by
  // the browser-side local vault registry's `type` field (window.__owLocalVaults,
  // loaded synchronously via <script> before boot.js — see index.html loading
  // order). No entry in the registry → 'server' (unchanged from before).
  var __owV = window.__owLocalVaults && window.__owLocalVaults.get(VAULT_ID);
  var VAULT_TYPE = __owV ? (__owV.type || 'local') : 'server';   // 'folder' | 'local' | 'server'
  window.__owVaultType = VAULT_TYPE;
  window.__owVaultId   = VAULT_ID;
  console.log('[obsidian-web] vault type:', VAULT_TYPE, 'id:', VAULT_ID);

  // ── /_owres/ folder-vault RPC responder (sw-vault-resources §3ד) ─────────
  // The SW's `/_owres/` handler (sw.js) can read OPFS ('local' vaults)
  // directly, but a 'folder' vault's FileSystemDirectoryHandle needs FS
  // Access permission — `queryPermission`/`requestPermission` require a
  // user-activated Window, which a Service Worker doesn't have (spike #2,
  // §0.1). So for folder vaults the SW asks *this* page instead: one hop via
  // MessageChannel. Answers with the already permission-granted
  // `window.__owFolderRoot` (set once, via a real user gesture, by
  // showGrantScreen below) — not a fresh handle re-loaded from IndexedDB,
  // which could still need a permission re-check (finding 3, brief §3ד).
  // Registered unconditionally (cheap no-op for 'local'/'server' vaults —
  // just an early-return on vaultId/type mismatch) since VAULT_TYPE is known
  // synchronously here but __owFolderRoot is only set later, once the grant
  // resolves (verifyPromise below) — the listener checks it at call-time.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var msg = ev.data;
      if (!msg || msg.type !== 'ow-res') return;
      var port = ev.ports && ev.ports[0];
      if (!port) return;
      if (msg.vaultId !== VAULT_ID || VAULT_TYPE !== 'folder' || !window.__owFolderRoot) {
        port.postMessage({ ok: false, error: 'no matching granted folder vault' });
        return;
      }
      var parts = String(msg.realRel || '').split('/').filter(function (p) { return p.length > 0; });
      var name = parts.pop();
      var cur = Promise.resolve(window.__owFolderRoot);
      parts.forEach(function (part) {
        cur = cur.then(function (dir) { return dir.getDirectoryHandle(part, { create: false }); });
      });
      cur.then(function (dir) { return dir.getFileHandle(name, { create: false }); })
        .then(function (fh) { return fh.getFile(); })
        .then(function (file) { return file.arrayBuffer(); })
        .then(function (buf) { port.postMessage({ ok: true, buffer: buf }, [buf]); })
        .catch(function (e) { port.postMessage({ ok: false, error: String((e && e.message) || e) }); });
    });
  }

  // (הוסר guard-הפניה ל-/starter כש-VAULT_ID ריק — brief §3א: no-vault
  // מזריק עכשיו את מסך-הפתיחה הנייטיב במקום redirect. /starter עדיין מטופל
  // בהמשך, אחרי setup ה-shims — ראה guard #2 למטה.)

  if (VAULT_ID) {
    localStorage.setItem('obsidian-web:lastVaultId', VAULT_ID);
    localStorage.setItem('mobile-selected-vault', VAULT_ID);
    localStorage.setItem('enable-plugin-' + VAULT_ID, 'true');
    // path-based routing (brief §3ב): אין יותר ?vault= query לנקות — ה-URL
    // '/vault/<id>' עצמו הוא מקור-האמת ונשאר גלוי (Bug 1 המקורי טופל אחרת —
    // ראה installNativeVaultOpenBridge, שם היירוט על removeItem('mobile-
    // selected-vault') מנווט ישירות ל-/starter במקום לסמוך על reload+URL).
  }

  // ── Platform overrides — applied BEFORE app.js loads ──────────────────────
  // client-mobile/platform-bridge.js קורא את האובייקט הזה בעצלתיים, בזמן
  // שהוא לוכד את ה-Platform האמיתי דרך יירוט Object.defineProperty (לא
  // build-time patch — ראה docs/plans/runtime-platform-descriptors.md).
  // מה שמוגדר כאן מנצח.
  //
  // המצב נשמר ב-localStorage תחת המפתח 'obsidian-web:layout-mode'.
  // deploy-config.md §3(ג): layout.default הוא ה-fallback כשאין עדיין
  // localStorage pref אישי (פורס יכול לקבוע ברירת-מחדל 'mobile'/'desktop'/
  // 'auto' לפריסה שלו); layout.threshold מחליף את סף ה-900px הקשיח
  // (innerHeight<600 נשאר קבוע — §3(ג) בבריף מחווט רק default/threshold).
  // ES5 guard pattern (avigail): (window.__owConfig && window.__owConfig.X).
  function computeLayoutMode() {
    var cfg = (window.__owConfig && window.__owConfig.layout) || {};
    var defaultMode = cfg.default || 'auto';
    var threshold = (typeof cfg.threshold === 'number') ? cfg.threshold : 900;
    var pref = localStorage.getItem('obsidian-web:layout-mode') || defaultMode;
    if (pref === 'mobile')  return { isMobile: true,  reason: 'user-pref-mobile' };
    if (pref === 'desktop') return { isMobile: false, reason: 'user-pref-desktop' };
    // 'auto' — viewport-based decision
    var small = window.innerWidth < threshold || window.innerHeight < 600;
    return { isMobile: small, reason: 'auto-' + (small ? 'mobile' : 'desktop') };
  }
  var layout = computeLayoutMode();
  // מציבים את *כל* דגלי-הפלטפורמה עקבית עם מצב ה-layout (לא רק isMobile):
  //  • isPhone/isMobile/isDesktop → ה-layout הכללי (ריווח, אנימציות, סרגלים)
  //    מותאם למצב. הערה: מסך-הסטארטר עצמו (onboarding מול chooser) נבחר ב-bundle
  //    לפי *קיום-vault* (אין vaults=onboarding, יש=chooser), לא לפי הרוחב —
  //    הרוחב קובע רק את ה-layout *בתוך* אותו מסך.
  //  • isDesktopApp — ⚠️ הופך שקרי כאן (docs/plans/desktop-layout-now.md §1ג,
  //    אותה מחלקה כמו ההערה שליד LOCKED_FLAGS ב-platform-bridge.js): עד
  //    לסלייס הזה הריצה הייתה *תמיד* דפדפן-בלבד (אין Node/Electron), וההערה
  //    הקודמת כאן (isDesktopApp:false קבוע, גם במצב desktop-layout — הנימוק
  //    היה שער isDesktopOnly) תיארה את זה נכון. עכשיו יש shim ל-window.electron
  //    (src/client-mobile/shims/electron.js) ⇒ הדגל **כן** נדלק במצב
  //    desktop-layout, עקבי עם isDesktop. platform-bridge.js's computeWant()
  //    הוא זה שבפועל נועל את הדגל (מגזרת isDesktop, לא נקרא מהשדה הזה
  //    ישירות) — הערך כאן נשאר לקריאוּת/עקביות עם שאר האובייקט, לא בגלל
  //    שמישהו קורא אותו ישירות.
  //    ⚠️ שער isDesktopOnly עצמו עדיין נפתח (פלאגיני desktop-only הופכים
  //    ניתנים-להתקנה) — נמדד ותועד, לא נחסם ידנית (docs/plans/
  //    desktop-shell-shim.md §2.5, §9 בבריף).
  window.__owPlatformOverrides = {
    isMobile:     layout.isMobile,
    isPhone:      layout.isMobile,
    isTablet:     false,
    isDesktop:    !layout.isMobile,
    isDesktopApp: !layout.isMobile,
    isMobileApp:  true,
  };
  console.log('[obsidian-web] platform overrides:', layout);

  // ── window.require לפלאגינים ───────────────────────────────────────────────
  var modules = {
    'path':          window.__owPath,
    'url':           window.__owUrl,
    'os':            window.__owOs,
    'btime':         window.__owBtime,
    'crypto':        makeCryptoShim(),
    'node:crypto':   makeCryptoShim(),
    'util':          makeUtilShim(),
    'node:util':     makeUtilShim(),
    'buffer':        { Buffer: window.Buffer },
    'process':       window.process,
    'child_process': makeChildProcessStub(),
    // docs/plans/electron-shim-foundation.md §3.1 — window.electron is set
    // by shims/electron.js, loaded (index.html) BEFORE this script. Note
    // this registers unconditionally (no isDesktopApp check — the gate that
    // matters is the `emulate-mobile` body class the bundle itself checks
    // before it ever calls window.require('electron'), see brief §3.6),
    // exactly like every other entry in this map.
    'electron':      window.electron,
  };

  function makeChildProcessStub() {
    var ERR = new Error('[obsidian-web] child_process not available in web mode');
    function noop() {}
    function fakeProc() {
      return { stdout:{on:noop,pipe:noop}, stderr:{on:noop,pipe:noop},
               stdin:{write:noop,end:noop}, on:noop, once:noop, kill:noop, pid:0 };
    }
    return {
      exec: function(cmd,opts,cb){ if(typeof opts==='function')cb=opts; if(typeof cb==='function')setTimeout(function(){cb(ERR,'','')},0); return fakeProc(); },
      execSync: function(){ throw ERR; },
      spawn: function(){ return fakeProc(); },
      spawnSync: function(){ return {stdout:'',stderr:'',status:1,error:ERR}; },
      execFile: function(f,a,opts,cb){ if(typeof opts==='function')cb=opts; if(typeof cb==='function')setTimeout(function(){cb(ERR,'','')},0); return fakeProc(); },
      fork: function(){ return fakeProc(); },
    };
  }

  function makeUtilShim() {
    return {
      promisify: function(fn){ return function(){ var args=[].slice.call(arguments); return new Promise(function(res,rej){ args.push(function(e,v){e?rej(e):res(v);}); fn.apply(this,args); }); }; },
      callbackify: function(fn){ return function(){ var args=[].slice.call(arguments), cb=args.pop(); fn.apply(this,args).then(function(v){cb(null,v);},function(e){cb(e);}); }; },
      inspect: function(o){ try{return JSON.stringify(o);}catch(_){return String(o);} },
      inherits: function(ctor,sup){ ctor.super_=sup; Object.setPrototypeOf(ctor.prototype,sup.prototype); },
    };
  }

  function makeCryptoShim() {
    // Mirror of client/boot.js makeCryptoShim — keeps desktop and mobile
    // runtimes in sync. WebCrypto's subtle.digest is async-only; we expose
    // a callback-based async path on .digest() and a sync path that warns
    // and returns empty. Algo names mapped from Node to WebCrypto.
    return {
      randomBytes: function(n) {
        var arr = new Uint8Array(n);
        crypto.getRandomValues(arr);
        arr.toString = function(enc) {
          if (enc==='hex') { var s=''; for(var i=0;i<this.length;i++) s+=this[i].toString(16).padStart(2,'0'); return s; }
          return Uint8Array.prototype.toString.call(this);
        };
        return arr;
      },
      createHash: function(algo) {
        // Map Node algo names to WebCrypto names. md5 falls back to SHA-256
        // (browsers don't ship MD5); callers that need real MD5 must bundle
        // their own (e.g. spark-md5, as LiveSync already does).
        var algoMap = { sha1: 'SHA-1', sha256: 'SHA-256', sha512: 'SHA-512', md5: 'SHA-256' };
        var subtleAlgo = algoMap[(algo || '').toLowerCase()] || 'SHA-256';
        var chunks = [];
        var hash = {
          update: function(d){ chunks.push(typeof d==='string'?new TextEncoder().encode(d):d); return hash; },
          digest: function(encoding, cb){
            if (typeof encoding === 'function') { cb = encoding; encoding = 'hex'; }
            // Async path — caller provided a callback.
            if (typeof cb === 'function') {
              var totalLen = 0;
              for (var k = 0; k < chunks.length; k++) totalLen += chunks[k].length;
              var combined = new Uint8Array(totalLen);
              var off = 0;
              for (var j = 0; j < chunks.length; j++) { combined.set(chunks[j], off); off += chunks[j].length; }
              crypto.subtle.digest(subtleAlgo, combined).then(function(buf){
                var bytes = new Uint8Array(buf);
                if (encoding === 'hex') {
                  var s = '';
                  for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
                  cb(null, s);
                } else {
                  cb(null, bytes);
                }
              }).catch(function(err){ cb(err); });
              return hash;
            }
            // Sync path: WebCrypto cannot hash synchronously. Warn so we can
            // spot if something actually relies on it.
            console.warn('[obsidian-web] crypto.createHash(' + algo + ').digest() called synchronously — returning empty. If this causes issues, wrap the caller to use the async (callback) path.');
            return encoding === 'hex' ? '' : new Uint8Array(0);
          },
        };
        return hash;
      },
    };
  }

  var missing = (function(){
    var hits = {};
    return {
      record: function(n){ hits[n]=(hits[n]||0)+1; },
      summary: function(){ console.table(Object.entries(hits).map(function(e){return{module:e[0],count:e[1]};})); },
    };
  })();

  window.require = function(name) {
    if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
    missing.record(name);
    return undefined;
  };
  window.__owMissing = missing;

  window.process = window.process || {
    platform: 'linux', arch: 'x64',
    // electron: '30.0.0' — docs/plans/electron-shim-foundation.md §3.0: a
    // WEIGHT-BEARING literal, not a "for example" placeholder. Derived
    // (Tn/Pn/Ln) values must satisfy THREE measured constraints at once —
    // major>=13, string>="28.2.3", major<40 — or the bundle throws an
    // "upgrade your installer" error at boot, or picks the wrong clipboard
    // API branch. '30.0.0' is the smallest version that clears all three.
    versions: { node: '0.0.0', electron: '30.0.0' }, env: {},
    cwd: function(){ return '/'; },
    nextTick: function(fn){ return Promise.resolve().then(fn); },
  };

  if (!window.Buffer) {
    window.Buffer = {
      from: function(data, enc) {
        if (typeof data==='string') {
          if (enc==='base64') { var b=atob(data),a=new Uint8Array(b.length); for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i); return a; }
          return new TextEncoder().encode(data);
        }
        return new Uint8Array(data);
      },
      isBuffer: function(x){ return x instanceof Uint8Array; },
      alloc: function(n){ return new Uint8Array(n); },
    };
  }

  console.log('[obsidian-web] mobile boot: require + shims installed, vault=' + VAULT_ID);

  // ── אימות vault + הזרקה דינמית של scripts ─────────────────────────────────
  // (הוסר guard-return ל-pathname==='/starter' — brief §3ב: /starter מגיש
  // עכשיו את אותו shell/boot.js כמו כל path אחר; forceStarter כבר אילץ
  // VAULT_ID='' למעלה, כך שהזרימה ממשיכה ישר לענף no-vault למטה ומרנדרת את
  // מסך-הפתיחה הנייטיב — בדיוק ההתנהגות הרצויה, בלי branch נפרד.)

  var statusEl = document.getElementById('ow-status');
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // אלמנט נפרד מ-#ow-loading/#ow-status (calev, סבב-תיקון שלישי, ממצא 3):
  // #ow-status נמחק/נדרס לפני שהמשתמש מספיק לקרוא אותו בתרחיש-הכשל הריאלי —
  // נמדד: ההודעה מופיעה, נדרסת ע"י ה-onload הבא ("Loading Obsidian mobile
  // (14/14)") ואז #ow-loading כולו מוסר לגמרי כש-.workspace מתרנדר, עוד לפני
  // שהמשתמש קרא משהו. הבאנר הזה הוא אלמנט **עצמאי**, ילד ישיר של <body> ולא
  // של #ow-loading — removeLoadingOverlayWhen() (למטה) לעולם לא נוגע בו,
  // ושום setStatus() עתידי לא כותב לתוכו. נוצר lazily (רק בכשל ראשון) כדי
  // שלא יתווסף DOM מיותר במסלול-ההצלחה הרגיל.
  var platformWarningEl = null;
  function showPlatformFailureBanner(text) {
    if (!platformWarningEl) {
      platformWarningEl = document.createElement('div');
      platformWarningEl.id = 'ow-platform-warning';
      platformWarningEl.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'bottom:0',
        'background:#5a1e1e', 'color:#fff', 'padding:10px 16px',
        'font:13px -apple-system, BlinkMacSystemFont, sans-serif',
        'z-index:100000', 'box-shadow:0 -1px 6px rgba(0,0,0,0.4)',
      ].join(';');
      document.body.appendChild(platformWarningEl);
    }
    platformWarningEl.textContent = text;
  }

  // חשוף עבור platform-bridge.js (נטען לפני script זה — index.html) — קו-
  // 3.1א בבריף: אם ה-bridge בסופו-של-דבר מוותר על לכידת Platform, אזהרת
  // console בלבד בלתי-נראית למשתמש. שורה זו רצה מוקדם וסינכרונית, הרבה לפני
  // ש-app.js אפילו מוזרק — עד שה-bridge יכול לקרוא לזה בכלל (רק אחרי ש-app.js
  // נטען, או אחרי רשת-הביטחון הארוכה), ה-hook כבר קיים.
  //
  // כותב לשני מקומות: setStatus() (עדיין מועיל בזמן שהספינר גלוי) וגם
  // showPlatformFailureBanner() — זה מה ש**שורד** אחרי ש-#ow-loading מוסר
  // ואחרי onload-ים מאוחרים יותר שדורסים את #ow-status (calev ממצא 3).
  window.__owReportPlatformFailure = function (msg) {
    setStatus(msg);
    showPlatformFailureBanner(msg);
    // עוצר את הספינר (CSS ב-index.html). ה-overlay עשוי כבר להיות מוסר —
    // ואז אין מה לעשות, והבאנר הוא מה ששורד ממילא.
    var overlay = document.getElementById('ow-loading');
    if (overlay) overlay.classList.add('ow-failed');
  };

  // הזרקה דינמית — browser מוריד במקביל, מריץ לפי סדר (async=false).
  // חולצה מ-for-loop inline (היה כאן במקור) לפונקציה נגישה גם לזרימת
  // ה-no-vault (מסך-הפתיחה הנייטיב, למטה) וגם לזרימת ה-VAULT_ID הרגילה.
  // ── Boot watchdog — כשה-bundle נטען בהצלחה אבל מסרב לעלות ──────────────────
  // `s.onerror` (למטה) מכסה כשל-**רשת** של app.js. מה שלא היה מכוסה: app.js
  // נטען בהצלחה, זורק בזמן-ריצה, והספינר נשאר תקוע על "Loading Obsidian mobile
  // (14/14)" לנצח — בלי שום רמז למשתמש מה קרה. Obsidian 1.13 נכשלת בדיוק כך:
  // `throw new Error` **ריק**, בלי הודעה, מתוך הבאנדל המוקטן.
  //
  // מדוע לא owWhenAppReady: ה-timeout שלו שקט **במכוון** (סעיף vault-name-
  // display §3 — slices אחרים נשענים על כך שהוא לא מדווח כלום), והוא בודק
  // `window.app` שנקבע לפני שה-UI מרונדר. כאן בודקים DOM מרונדר בפועל —
  // איחוד שני ה-selectors ששתי זרימות ההמתנה כבר משתמשות בהן.
  var BOOT_RENDERED_SELECTORS = '.workspace, .mobile-vault-chooser-screen, .mobile-onboarding';

  // '1.13.4' → 11304, להשוואה מספרית. פורמט לא-צפוי → NaN, והקורא נופל
  // להודעה הגנרית במקום לנחש.
  function owVersionKey(v) {
    var p = String(v || '').split('.');
    if (p.length < 2) return NaN;
    return (parseInt(p[0], 10) * 10000) + (parseInt(p[1], 10) * 100) + (parseInt(p[2], 10) || 0);
  }

  function bootFailureMessage() {
    var v = window.__owObsidianVersion || '';
    var key = owVersionKey(v);
    if (!isNaN(key) && key >= 11300) {
      return 'Obsidian ' + v + ' did not start. This version asks its host for a ' +
             'startup acknowledgement that Oryn does not provide. The newest ' +
             'version known to work here is 1.12.7 — see the README.';
    }
    return 'Obsidian ' + (v ? v + ' ' : '') + 'did not start: nothing rendered after the ' +
           'bundle finished loading. Check the browser console for errors.';
  }

  function startBootWatchdog(timeoutMs) {
    setTimeout(function () {
      if (document.querySelector(BOOT_RENDERED_SELECTORS)) return;  // עלה — אין מה לדווח
      window.__owReportPlatformFailure(bootFailureMessage());
    }, timeoutMs || 20000);
  }

  function injectMobileScripts() {
    var loaded = 0;
    var appJsSrc = MOBILE_SCRIPTS[MOBILE_SCRIPTS.length - 1]; // app.js — תמיד אחרון (globals שהוא צריך חייבים לפניו)
    for (var i = 0; i < MOBILE_SCRIPTS.length; i++) {
      (function (src) {
        var s = document.createElement('script');
        s.src = src;
        s.async = false;
        s.onload = function () {
          loaded++;
          setStatus('Loading Obsidian mobile (' + loaded + '/' + MOBILE_SCRIPTS.length + ')');
          // עוגן חלון-הלכידה של platform-bridge.js (docs/plans/
          // runtime-platform-descriptors.md §3.1a) — ה-`load` הנייטיבי של
          // app.js עצמו, לא דדליין שרירותי שסופר את זמן-ההורדה שלו.
          if (src === appJsSrc && window.__owPlatformBridge &&
              typeof window.__owPlatformBridge.notifyAppJsLoaded === 'function') {
            window.__owPlatformBridge.notifyAppJsLoaded();
          }
          // הדדליין נספר מרגע שה-bundle **סיים** להיטען, לא מרגע ההזרקה —
          // אחרת רשת איטית הייתה מייצרת התראת-שווא.
          if (src === appJsSrc) startBootWatchdog();
        };
        s.onerror = function () {
          console.error('[obsidian-web] failed to load: ' + src);
          setStatus('Error loading ' + src.split('/').pop());
          // עוגן שני-ל-חלון-הלכידה (docs/plans/runtime-platform-descriptors.md
          // §3.1a, סבב-תיקון שלישי) — אם app.js עצמו נכשל ברשת (`error`, לא
          // `load`), ל-platform-bridge.js אין דרך אחרת לדעת שהקוד הסינכרוני
          // שלו לעולם לא ירוץ; בלי זה הלכידה הייתה תלויה ב-crash-guard
          // (5 דקות) בלבד לתרחיש הזה בדיוק.
          if (src === appJsSrc && window.__owPlatformBridge &&
              typeof window.__owPlatformBridge.notifyAppJsFailed === 'function') {
            window.__owPlatformBridge.notifyAppJsFailed();
          }
        };
        document.head.appendChild(s);
      })(MOBILE_SCRIPTS[i]);
    }
  }

  // הסרת ספינר (#ow-loading) כש-selector מתרנדר — משותף לשתי הזרימות: זרימת
  // VAULT_ID רגילה ממתינה ל-.workspace; זרימת ה-no-vault (למטה) ממתינה למסך
  // הנייטיב עצמו (.mobile-vault-chooser-screen או .mobile-onboarding — ראה
  // executor spike: ל-Obsidian יש 2 מסכי-כניסה אפשריים, תלוי אם כבר יש
  // vault אחד לפחות ב-Lte/readdir; שניהם תקפים "מסך-פתיחה נייטיב מרונדר").
  // בלי זה — הספינר נשאר תקוע מעל המסך הנייטיב (regression שנתפס ב-spike).
  function removeLoadingOverlayWhen(selector) {
    var overlay = document.getElementById('ow-loading');
    if (!overlay) return;
    if (document.querySelector(selector)) { overlay.remove(); return; }
    var obs = new MutationObserver(function () {
      if (document.querySelector(selector)) {
        overlay.remove();
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── Console hygiene: phone-home network noise ────────────────────────────
  // Obsidian's bundle phones home at boot (update/stats endpoints such as
  // releases.obsidian.md, which serves no CORS headers — verified). When the
  // browser blocks one of those XHRs, the rejection is a stack-less native
  // `NetworkError: A network error occurred.` DOMException that the bundle
  // never catches, so DevTools prints it as an uncaught error on every load
  // (8× a boot) and users read it as "sync is broken". It can't be fixed at
  // the source (third-party headers / no catch inside the minified bundle),
  // and the bundle ignores it too — so we only take it off the console,
  // exactly-matched, keeping it as console.debug for anyone debugging.
  // Our own sync/fetch code always catches and toasts its errors
  // ([ow-sync] …) — it never reaches this listener.
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    if (r && r.name === 'NetworkError' && r.message === 'A network error occurred.') {
      console.debug('[ow] suppressed phone-home network rejection:', r);
      ev.preventDefault();
    }
  });

  // ── App-ready poll — helper רב-שימושי (docs/plans/vault-name-display.md §3) ─
  // אין ב-boot.js נקודת-ready אמינה מובנית (s.onload רק סופר scripts
  // שהורדו — לא app-init; אין onLayoutReady/setInterval/waitFor* קיים). ה-vendor
  // קובע את window.app (בשימוש כבר ב-openVaultChooser click handlers למטה) —
  // poll ל-window.app && window.app.vault הוא הדרך היציבה היחידה. timeout
  // שקט (לא זורק, לא תוקע) — cb פשוט לא נקרא. שם קבוע (owWhenAppReady) —
  // slice הבא (vault-note-deeplink) נשען על אותו helper, ראה coordination note.
  function owWhenAppReady(cb, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 8000);
    (function poll() {
      if (window.app && window.app.vault) { cb(window.app); return; }
      if (Date.now() >= deadline) return;   // timeout: no-op שקט
      setTimeout(poll, 50);
    })();
  }

  // ── עדכון-DOM של תווית שם-הכספת בפאנל (vault-name-display §3) ──────────────
  // probe אמפירי (Chromium headless): getName() נקרא **פעם-אחת** ב-construction
  // של הפאנל (Ex constructor ב-vendor: `t.createDiv({cls:"workspace-drawer-
  // vault-name",text:i})`, i=e.vault.getName() בזמן הבנייה) — override ל-
  // getName **לבדו** אינו מספיק כשהפאנל כבר רונדר (המצב השכיח: הפאנל נבנה
  // בערך באותו טיימינג שבו window.app הופך זמין, לפני שה-poll שלנו מתפענח).
  // לכן תמיד קובעים textContent ישירות בנוסף ל-override. finding אביגיל 3
  // (קריטי): הטרגט הוא ה-**child** `.workspace-drawer-vault-name` — לא
  // `.workspace-drawer-vault-switcher` עצמו — **לא** ה-click-target שלנו יותר
  // (docs/plans/desktop-layout-now.md §6 Commit 7: חטיפת-הקליק שהייתה כאן
  // הוסרה — הקליק על הפאנל עכשיו מגיע לנתיב הנייטיב, שהוא real עכשיו בזכות
  // ערוצי vault/vault-list/vault-open ב-shims/electron.js). דריסת textContent
  // על ה-switcher עצמו עדיין הייתה מוחקת ילדים ושוברת את ה-listener הנייטיב —
  // הזהירות נשארת נכונה, רק המקור שהיא מגינה עליו השתנה.
  // idempotent — בטוח לקרוא שוב (reload/late-render).
  // אם הפאנל עדיין לא רונדר כש-owWhenAppReady מתפענח — MutationObserver
  // קצר-מועד (עקבי עם removeLoadingOverlayWhen למעלה), מתנתק אחרי match/timeout.
  function refreshVaultProfileLabel(name) {
    var nameEl = document.querySelector('.workspace-drawer-vault-name');
    if (nameEl) { nameEl.textContent = name; return; }
    var obs = new MutationObserver(function () {
      var el = document.querySelector('.workspace-drawer-vault-name');
      if (el) { el.textContent = name; obs.disconnect(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { obs.disconnect(); }, 8000);
  }

  // ── מסך-פתיחה נייטיב (no-vault) — גישור בחירת/פתיחת-vault ──────────────────
  // executor spike (docs/plans/opfs-ux.md §3ד/§3ה, finding 4 אביגיל):
  // register() הנייטיב (הפונקציה שרצה אחרי "Open folder as vault"/לחיצה על
  // "Open vault" בשורת vault קיים/auto-resume בעלייה) פותח vault ישירות
  // בזיכרון (window.app=new ete(...)) בלי reload — עוקף לגמרי את זרימת
  // ה-VAULT_ID/boot.js שלנו. נקודת-העיגון האמינה היחידה: register תמיד כותב
  // ל-localStorage['mobile-selected-vault'] רגע לפני הפתיחה הישירה. מיירטים
  // את הכתיבה הזו (monkey-patch ל-localStorage.setItem, מותקן רק בזרימת
  // no-vault) ומנווטים בעצמנו ל-vault שנבחר — כך זרימת ה-boot.js הרגילה
  // (OPFS/folder/server, seed system plugins וכו') רצה כרגיל.
  // Bug 2b (brief §3ג, finding 5): navigateToVault (path-based, '/vault/<id>')
  // במקום '/mobile?vault=' הקשיח — שבר את CF (שם ה-entry הוא '/', אין route
  // '/mobile'). path-based שומר גם CF וגם מקומי (זהה ל-Bug 2 finding 1).
  //
  // brief §3ב finding 4 (קריטי, "מעבר-מיד-סשן"): מותקן עכשיו **גם** בענף
  // vault-open (לא רק no-vault) — אחרת switch (בחירת vault אחר מהרשימה)
  // רץ נייטיבית (setItem+reload באותו URL) ולא נוחת על /vault/<newid>.
  //
  // executor finding (אמפירי, spike ידני ב-Chromium): register() הנייטיב
  // (הפונקציה שמריצה את ה-setItem('mobile-selected-vault', t) שלמעלה) רצה
  // **גם** כחלק מהתחלת-עבודה הרגילה של app.js כש-mobile-selected-vault כבר
  // מוגדר לפני שהבאנדל עלה (בדיוק המצב שלנו — boot.js כותב אותו למעלה, לפני
  // injectMobileScripts). זה כתיבה **חוזרת של אותו id** (לא switch אמיתי) —
  // בלי guard, זה גרם ל-navigateToVault(sameId) → location.href לאותו URL →
  // reload → boot.js רץ מחדש → אותה כתיבה חוזרת → **loop אינסופי** (נתפס
  // ב-manual testing, ~55 מחזורי "vault ok, injecting mobile scripts" בלוג).
  // מיירטים רק כש-id **שונה** מה-VAULT_ID הפתוח כרגע (switch אמיתי); כתיבה
  // חוזרת של אותו id עוברת ל-origSetItem כרגיל (no-op, אין ניווט).
  //
  // סגירה (executor, לא כתוב מפורש בבריף §3ב אבל נדרש ע"י DoD#5): הנייטיב
  // "close-vault"/openVaultChooser() עושה removeItem('mobile-selected-vault')
  // + reload — עם URL קבוע (/vault/<id> נשאר path-based, לא ?vault= שנוקה
  // כבר עם ה-navigation). reload כזה היה נוחת שוב על אותו /vault/<id> (path
  // עדיין תואם) במקום /starter. מיירטים גם את removeItem, באותה משפחת-עוגן,
  // ומנווטים ישירות — עקבי עם המנגנון הקיים ל-setItem, בלי לסמוך על תזמון
  // reload/URL. פעיל רק כשכספת פתוחה (VAULT_ID truthy בזמן ההתקנה); בענף
  // no-vault הכתיבה/מחיקה של המפתח כבר מטופלת ע"י הזרימה הנייטיבית הרגילה.
  function installNativeVaultOpenBridge() {
    if (window.__owNativeVaultBridgeInstalled) return;
    window.__owNativeVaultBridgeInstalled = true;
    var origSetItem = localStorage.setItem.bind(localStorage);
    var origRemoveItem = localStorage.removeItem.bind(localStorage);
    var hadOpenVault = !!VAULT_ID;
    localStorage.setItem = function (key, value) {
      if (key === 'mobile-selected-vault') {
        var id = owNativeVaultIdFromValue(value);
        if (id && id !== VAULT_ID) {
          navigateToVault(id);
          return;
        }
      }
      return origSetItem(key, value);
    };
    localStorage.removeItem = function (key) {
      if (key === 'mobile-selected-vault' && hadOpenVault) {
        location.href = '/starter';
        return;
      }
      return origRemoveItem(key);
    };
  }

  // ── /starter — minimal "Enter URL" screen (no-vault) ──────────────────────
  // The old flow injected Obsidian's own mobile bundle here and rendered its
  // native vault-chooser/onboarding screens (plus our injected buttons and
  // the "Enter or claim URL" field). Replaced: /starter is now a single
  // "Enter URL" box — type a vault URL or name and go. Nothing else renders
  // and the Obsidian bundle is NOT loaded on this screen, which also means
  // the native storage-location UI ("Device storage"/"App storage" radios,
  // vault-location hints) never shows, the screen is instant, and it works
  // offline (the SW's cached shell is all it needs).
  //
  // Where the typed value goes (starter-url.js parseVaultUrlInput):
  //   - absolute http(s) URL       → navigate to it verbatim
  //   - "/path" / "host/vault/x"   → normalized /vault/<name>[/note-path]
  //   - bare name                  → local registry first (exact id, then a
  //     case-insensitive NAME match — vaults created through the old native
  //     flow carry uuid ids, not their name), else:
  //       • client-only build (__owBackend==='none'): /vault/<name> — the
  //         vault gate (showVaultGate) handles password claim/unlock, or
  //         offers an explicit local create when the deployment has no sync
  //         server at all (CF).
  //       • server deployment: check /api/vaults/list (a typed name may be
  //         an existing SERVER vault id/path — the old chooser seeded from
  //         the same endpoint), else create a local vault under a fresh
  //         uuid, matching the old native "Create new vault" behavior.
  // Reached from: the entry redirect (/ with no last vault), "manage
  // vaults"/close-vault inside an open vault (installNativeVaultOpenBridge's
  // removeItem intercept), and verify failures.
  if (!VAULT_ID) {
    renderStarterScreen();
    return;
  }

  function renderStarterScreen() {
    var overlay = document.getElementById('ow-loading');
    var host = overlay || document.body;

    // No spinner — nothing loads on this screen. The overlay itself stays as
    // the backdrop (same centered dark flex CSS as the boot spinner).
    var spinner = host.querySelector('.ow-spinner');
    if (spinner && spinner.parentNode) spinner.parentNode.removeChild(spinner);
    setStatus('');

    var card = document.createElement('div');
    card.setAttribute('data-ow-injected', 'starter-screen');
    card.style.cssText = 'display:flex;flex-direction:column;gap:12px;align-items:stretch;' +
      'width:min(92vw,360px);padding:8px 0;' +
      'font:14px -apple-system,BlinkMacSystemFont,sans-serif;';

    var brand = (window.__owConfig && window.__owConfig.branding && window.__owConfig.branding.name) || 'Oryn';
    var title = document.createElement('div');
    title.textContent = brand;
    title.style.cssText = 'font-size:24px;font-weight:600;text-align:center;' +
      'color:rgba(255,255,255,0.92);letter-spacing:0.3px;';

    var hint = document.createElement('div');
    hint.textContent = 'Enter a vault URL to open it.';
    hint.style.cssText = 'font-size:13px;text-align:center;color:rgba(255,255,255,0.5);margin-bottom:4px;';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Enter URL';
    input.setAttribute('aria-label', 'Vault URL or name');
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.style.cssText = 'flex:1;min-width:0;padding:10px 12px;' +
      'border:1px solid rgba(255,255,255,0.25);border-radius:6px;' +
      'background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.92);' +
      'font:15px -apple-system,BlinkMacSystemFont,sans-serif;outline:none;';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Go';
    btn.setAttribute('data-ow-injected', 'starter-go');
    btn.setAttribute('aria-label', 'Open vault');
    btn.style.cssText = 'padding:10px 18px;background:#7f6df2;color:#fff;border:none;' +
      'border-radius:6px;cursor:pointer;font:14px -apple-system,BlinkMacSystemFont,sans-serif;';

    var err = document.createElement('div');
    err.setAttribute('data-ow-injected', 'starter-err');
    err.style.cssText = 'color:#e07a6b;font:12px -apple-system,BlinkMacSystemFont,sans-serif;' +
      'min-height:16px;text-align:center;';

    var submitting = false;

    // Server deployments only: a typed name may be an existing server vault
    // (id or path basename). Same source the old native chooser listed
    // (/api/vaults/list). No match (or endpoint unreachable) → create a
    // LOCAL vault under a fresh uuid — exactly what the old native "Create
    // new vault" flow did on this deployment type.
    function serverLookupThenGo(name) {
      function createLocalAndGo() {
        var id = window.__owLocalVaults.create(name).id;
        console.log('[obsidian-web] starter: created local vault', name, '->', id);
        location.href = '/vault/' + encodeURIComponent(id);
      }
      fetch('/api/vaults/list')
        .then(function (r) { return r.json(); })
        .then(function (res) {
          var lower = name.toLowerCase();
          var hit = null;
          Object.keys(res || {}).forEach(function (vid) {
            if (hit) return;
            var v = res[vid] || {};
            var base = String(v.path || vid).split('/').pop();
            if (vid === name || base === name || base.toLowerCase() === lower) hit = vid;
          });
          if (hit) { location.href = '/vault/' + encodeURIComponent(hit); return; }
          createLocalAndGo();
        })
        .catch(function (e) {
          console.warn('[obsidian-web] starter: vault list lookup failed, creating local:', e && e.message || e);
          createLocalAndGo();
        });
    }

    function submit() {
      if (submitting) return;
      var parsed = window.__owStarterUrl
        ? window.__owStarterUrl.parseVaultUrlInput(input.value)
        : { kind: 'error', error: 'Enter a vault URL or name.' };
      if (parsed.kind === 'error') { err.textContent = parsed.error; input.focus(); return; }
      err.textContent = '';
      if (parsed.kind === 'url' || parsed.kind === 'path') {
        submitting = true;
        location.href = parsed.url;
        return;
      }
      // kind === 'name' — already-registered local/folder vault first:
      // exact id, then a case-insensitive NAME match (uuid-id vaults).
      var name = parsed.name;
      if (window.__owLocalVaults) {
        if (window.__owLocalVaults.get(name)) {
          submitting = true;
          location.href = '/vault/' + encodeURIComponent(name);
          return;
        }
        var list = window.__owLocalVaults.list();
        var lower = name.toLowerCase();
        for (var i = 0; i < list.length; i++) {
          if (list[i].name && list[i].name.toLowerCase() === lower) {
            submitting = true;
            location.href = '/vault/' + encodeURIComponent(list[i].id);
            return;
          }
        }
      }
      submitting = true;
      if (window.__owBackend === 'none') {
        // Client-only build — the name IS the vault id; the gate at
        // /vault/<name> takes it from here (claim / unlock / create-local).
        location.href = '/vault/' + encodeURIComponent(name);
      } else {
        serverLookupThenGo(name);
      }
    }

    btn.addEventListener('click', function (e) { e.preventDefault(); submit(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    row.appendChild(input);
    row.appendChild(btn);
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(row);
    card.appendChild(err);
    host.appendChild(card);
  }

  // folder vaults need a re-grant click (user gesture) whenever
  // queryPermission comes back != 'granted' (typically: every fresh reload —
  // browsers don't persist FS Access permissions across sessions outside
  // installed PWAs, brief §9 Q2/v2). Renders a button inside the existing
  // #ow-loading overlay; resolves with the requestPermission() result.
  function showGrantScreen(handle) {
    return new Promise(function (resolve) {
      var overlay = document.getElementById('ow-loading');
      setStatus('Access to "' + handle.name + '" is needed to continue.');
      var btn = document.createElement('button');
      // §3.6: same `data-ow-injected` marking convention required of every
      // button this file injects (the vault gate and the starter screen
      // below follow it too) — "every button we inject gets marked" is the
      // rule going forward.
      btn.setAttribute('data-ow-injected', 'grant-access');
      btn.textContent = 'Grant access to ' + handle.name;
      btn.style.cssText = 'margin-top:8px;padding:8px 16px;background:#7f6df2;color:#fff;' +
        'border:none;border-radius:4px;cursor:pointer;font:13px -apple-system,BlinkMacSystemFont,sans-serif;';
      btn.onclick = async function () {
        btn.disabled = true;
        btn.textContent = 'Requesting…';
        var perm;
        try {
          perm = await handle.requestPermission({ mode: 'readwrite' });
        } catch (e) {
          perm = 'denied';
        }
        if (btn.parentNode) btn.parentNode.removeChild(btn);
        resolve(perm);
      };
      (overlay || document.body).appendChild(btn);
    });
  }

  // ── folder-vault external-change refresh (docs/plans/folder-watch.md §2/§3ד,
  // reused from slice/folder-refresh, which already verified DoD#3/4/5 there —
  // the retarget here (folder-watch) is the addListener capture itself, see
  // capacitor-shim.js + opfs-store.js) ──────────────────────────────────────
  // folder vaults (a real directory) can change from outside the browser —
  // another app, a sync client, another tab/device on the same directory.
  // OpfsStore (opfs-store.js) wires FileSystemObserver where supported and
  // always exposes rescan() as the manual/fallback path — this installs the
  // user-facing side: a manual refresh button (always shown — cheap even
  // when the observer IS active, covers edge cases like {recursive} not
  // fully supported) and, only when FileSystemObserver isn't supported, a
  // visibilitychange-triggered auto-rescan (debounced ~500ms) so switching
  // back to the tab/app picks up external edits without a manual click.
  // VAULT_TYPE==='folder' guard only (DoD#4) — 'local' (OPFS) vaults can
  // never change externally, must stay a no-op.

  // ── Vault name links (/vault/<name>) — password claims ─────────────────────
  // The name in a shared link IS the vault id. The sync server knows whether
  // it's claimed (GET /sync/v1/vaults/<name>) and exchanges the password for
  // a vault-scoped mpv1 token (POST, same route — claim-if-unlocked-else-
  // unlock). One shared saver writes the result: a local OPFS registry entry
  // under the name itself, plus the ow-sync config run-sync/run-pull read
  // (baseUrl = this origin — the claim endpoint just answered on it; vault =
  // the name — the mpv1 token is only valid for that vault on /sync/v1).
  //
  // SESSION-SCOPED CREDENTIAL ("forget the password when the page is
  // closed"): the token half of that config goes to sessionStorage — it dies
  // with the tab, so a new session must re-enter the vault password. The
  // NON-SECRET half (baseUrl + name) stays in localStorage under
  // 'ow-sync-claimed:<name>' as the marker that tells the next boot this
  // local vault is a synced one, so it re-prompts (showVaultGate's optional
  // mode, wired into the verify flow below) instead of silently running
  // unsynced. getSyncConfig in run-sync.js/run-pull.js reads sessionStorage
  // FIRST, then localStorage — a manual operator config (raw SYNC_TOKEN,
  // documented in the READMEs) keeps working exactly as before.
  var OW_VAULT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

  function saveClaimedVault(name, token) {
    if (window.__owLocalVaults && !window.__owLocalVaults.get(name)) {
      window.__owLocalVaults.create(name, { id: name });   // id === name (type 'local')
    }
    // Probe sessionStorage — some privacy modes disable it entirely. Without
    // a fallback the claim flow would loop forever (unlock → "saved" →
    // reload → credential missing → prompt → …), so when session storage is
    // unavailable the credential degrades to localStorage (persistent —
    // logged loudly) rather than break the vault.
    var credStore = null;
    try {
      sessionStorage.setItem('ow-sync-probe', '1');
      sessionStorage.removeItem('ow-sync-probe');
      credStore = sessionStorage;
    } catch (e) {
      console.warn('[obsidian-web] sessionStorage unavailable — the sync credential will persist in localStorage instead of being forgotten on close');
      credStore = localStorage;
    }
    credStore.setItem('ow-sync:' + name, JSON.stringify({
      baseUrl: location.origin,
      token: token,
      vault: name,
    }));
    localStorage.setItem('ow-sync-claimed:' + name, JSON.stringify({
      baseUrl: location.origin,
      vault: name,
    }));
    // Legacy cleanup: earlier builds kept the token itself in localStorage
    // (90 days). When the credential went to sessionStorage, drop any
    // leftover persistent copy — the marker above replaces it (same rule as
    // migrateLegacyClaimTokens at the top). Skipped when credStore IS
    // localStorage (the fallback just wrote there — removing would undo it).
    if (credStore === sessionStorage) {
      try { localStorage.removeItem('ow-sync:' + name); } catch (e) {}
    }
    console.log('[obsidian-web] claimed vault ready:', name);
  }

  // The non-secret "this local vault syncs with a server" marker written by
  // saveClaimedVault. Presence WITHOUT a live session token is what triggers
  // the password re-prompt on a new session's boot.
  function getSyncClaimMarker(name) {
    try {
      var raw = localStorage.getItem('ow-sync-claimed:' + name);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }


  // The gate for an unrecognized /vault/<name> on a client-only build
  // (replaces the old "not on this device" rejection — see the verify branch
  // below). Renders inside the existing #ow-loading overlay (like
  // showGrantScreen): status text + password field + Unlock/Claim + Back.
  //
  // Two modes:
  //  - claim/unlock (default): the sync server decides — claimed → password
  //    unlock, unclaimed → password claim. A deployment with NO sync
  //    endpoint at all (404/405/501 — the Cloudflare build ships none)
  //    offers an explicit "Create it here" local-vault fallback instead, so
  //    a typo'd deep link never silently mints an empty vault. Success
  //    registers the vault and RELOADS — VAULT_TYPE was already resolved to
  //    'server' before verify ran, so boot must start over with the fresh
  //    registry entry ('local') rather than continue in place; this promise
  //    therefore never settles. Wrong password / rate limit keep the form up
  //    with an inline error; Back and network failure reject with the old
  //    human message (owHuman → shared .catch → /starter).
  //  - resume (opts.optional): an already-local claimed vault booting in a
  //    NEW session — the sessionStorage credential is gone BY DESIGN (the
  //    password is forgotten when the page closes). No status fetch (the
  //    localStorage marker already says it's claimed): password → session
  //    token → RESOLVE {unlocked:true}, boot continues in place (no reload —
  //    VAULT_TYPE is already 'local'). "Continue without syncing" or a dead
  //    network resolves {skipped:true}: the vault still opens offline, sync
  //    just stays off for this session.
  function showVaultGate(name, opts) {
    var optional = !!(opts && opts.optional);
    return new Promise(function (resolve, reject) {
      var overlay = document.getElementById('ow-loading');
      var host = overlay || document.body;
      var wrap = null;

      function removeGate() {
        if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
        wrap = null;
      }

      function bail() {
        if (optional) { removeGate(); resolve({ skipped: true }); return; }
        var err = new Error('This vault isn\'t on this device — vaults are stored locally in the browser.');
        err.owHuman = true;
        reject(err);
      }

      // No sync endpoint on this deployment (CF ships none — its worker
      // answers 404 like any unknown asset): the name can still become a
      // plain LOCAL vault, but only on explicit confirmation.
      function renderLocalCreateFallback() {
        if (!OW_VAULT_NAME_RE.test(name)) { bail(); return; }
        setStatus('No vault named "' + name + '" on this device — and this site has no sync server to ask.');
        wrap = document.createElement('div');
        wrap.setAttribute('data-ow-injected', 'vault-gate');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px;' +
          'max-width:320px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;';
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;';
        var create = document.createElement('button');
        create.setAttribute('data-ow-injected', 'vault-gate-create');
        create.textContent = 'Create it here';
        create.style.cssText = 'padding:8px 16px;background:#7f6df2;color:#fff;border:none;' +
          'border-radius:4px;cursor:pointer;font:13px -apple-system,BlinkMacSystemFont,sans-serif;';
        var back = document.createElement('button');
        back.setAttribute('data-ow-injected', 'vault-gate-cancel');
        back.textContent = 'Back';
        back.style.cssText = 'padding:8px 16px;background:transparent;color:#888;' +
          'border:1px solid #bbb;border-radius:4px;cursor:pointer;' +
          'font:13px -apple-system,BlinkMacSystemFont,sans-serif;';
        create.addEventListener('click', function () {
          window.__owLocalVaults.create(name, { id: name });
          console.log('[obsidian-web] gate: created local vault', name);
          location.reload();   // re-boot as 'local' (never settles here)
        });
        back.addEventListener('click', bail);
        row.appendChild(create);
        row.appendChild(back);
        wrap.appendChild(row);
        host.appendChild(wrap);
      }

      if (optional) {
        renderGate(true);   // claimed by definition — the marker says so
      } else {
        setStatus('Checking vault "' + name + '"...');
        fetch('/sync/v1/vaults/' + encodeURIComponent(name), { cache: 'no-store' })
          .then(function (res) {
            if (res.status === 404 || res.status === 405 || res.status === 501) {
              renderLocalCreateFallback();   // no sync endpoint on this deployment
              return null;
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (info) {
            if (info) renderGate(!!(info && info.claimed));
          })
          .catch(function (err) {
            console.warn('[obsidian-web] vault gate: status check failed:', err && err.message || err);
            bail();
          });
      }

      function renderGate(claimed) {
        setStatus(optional
          ? 'Vault "' + name + '" syncs with the server — enter its password to turn syncing on. It is forgotten again when you close this tab.'
          : claimed
            ? 'Vault "' + name + '" is password-protected — enter its password to open it.'
            : 'No vault named "' + name + '" exists yet — choose a password to claim it. It will be created on this device and synced to this server.');

        wrap = document.createElement('div');
        wrap.setAttribute('data-ow-injected', 'vault-gate');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:12px;' +
          'max-width:320px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;';

        var input = document.createElement('input');
        input.type = 'password';
        input.placeholder = claimed ? 'Password' : 'New password (at least 8 characters)';
        input.setAttribute('autocomplete', claimed ? 'current-password' : 'new-password');
        input.style.cssText = 'padding:8px 10px;border:1px solid #bbb;border-radius:4px;' +
          'font:14px -apple-system,BlinkMacSystemFont,sans-serif;';

        var errLine = document.createElement('div');
        errLine.style.cssText = 'color:#c0392b;font:12px -apple-system,BlinkMacSystemFont,sans-serif;min-height:14px;';

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;';

        var submit = document.createElement('button');
        submit.setAttribute('data-ow-injected', 'vault-gate-submit');
        submit.textContent = claimed ? 'Unlock' : 'Claim vault';
        submit.style.cssText = 'padding:8px 16px;background:#7f6df2;color:#fff;border:none;' +
          'border-radius:4px;cursor:pointer;font:13px -apple-system,BlinkMacSystemFont,sans-serif;';

        var back = document.createElement('button');
        back.setAttribute('data-ow-injected', 'vault-gate-cancel');
        back.textContent = optional ? 'Continue without syncing' : 'Back';
        back.style.cssText = 'padding:8px 16px;background:transparent;color:#888;' +
          'border:1px solid #bbb;border-radius:4px;cursor:pointer;' +
          'font:13px -apple-system,BlinkMacSystemFont,sans-serif;';

        function submitPassword() {
          var pw = input.value;
          if (pw.length < 8) {
            errLine.textContent = 'Password must be at least 8 characters.';
            return;
          }
          submit.disabled = true;
          errLine.textContent = '';
          fetch('/sync/v1/vaults/' + encodeURIComponent(name), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: pw }),
          })
            .then(function (res) {
              if (res.status === 401) { errLine.textContent = 'Wrong password.'; return null; }
              if (res.status === 429) {
                errLine.textContent = 'Too many attempts — wait a minute and try again.';
                return null;
              }
              if (!res.ok) {
                return res.json().then(function (b) {
                  throw new Error((b && b.error) || ('HTTP ' + res.status));
                });
              }
              return res.json();
            })
            .then(function (body) {
              if (!body) { submit.disabled = false; return; }   // error line already set
              if (!body.token) throw new Error('no token in claim response');
              saveClaimedVault(name, body.token);
              if (optional) {
                // Session resume — VAULT_TYPE is already 'local', so boot
                // continues in place (no reload); the startup sync right
                // after this gate picks the fresh session token up.
                removeGate();
                resolve({ unlocked: true });
                return;
              }
              location.reload();   // re-boot as a 'local' vault (never settles here)
            })
            .catch(function (err) {
              console.warn('[obsidian-web] vault gate: unlock failed:', err && err.message || err);
              errLine.textContent = (err && err.message) || 'Request failed.';
              submit.disabled = false;
            });
        }

        submit.addEventListener('click', submitPassword);
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') submitPassword();
        });
        back.addEventListener('click', function () {
          removeGate();
          bail();
        });

        row.appendChild(submit);
        row.appendChild(back);
        wrap.appendChild(input);
        wrap.appendChild(errLine);
        wrap.appendChild(row);
        host.appendChild(wrap);
        input.focus();
      }
    });
  }

  function installFolderRefreshWatch() {
    if (VAULT_TYPE !== 'folder') return;
    if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.Filesystem) return;
    var fs = window.Capacitor.Plugins.Filesystem;
    var hasObserver = typeof self !== 'undefined' && 'FileSystemObserver' in self;

    function debounce(fn, ms) {
      var t = null;
      return function () {
        if (t) clearTimeout(t);
        t = setTimeout(fn, ms);
      };
    }

    // ── feedback helpers (docs/plans/folder-refresh-toolbar.md §0/§3ב) ───────
    // The button existed before (folder-watch) but gave zero feedback: click
    // → rescan() ran silently, {changed:N} was discarded, and doRescan only
    // ever logged on *failure*. First click without an observer only ever
    // captures a {changed:0} baseline, so nothing visible happens — the
    // button "feels dead" even when it works. Fix: always log the result,
    // spin the icon while in flight, and surface a Notice when available
    // (window.Notice — confirmed exposed by executor spike §0.1ד, not a
    // no-op fallback needed).
    function setSpin(on) {
      var btns = document.querySelectorAll('.ow-folder-refresh-btn');
      for (var i = 0; i < btns.length; i++) {
        if (on) btns[i].classList.add('is-spinning');
        else btns[i].classList.remove('is-spinning');
      }
    }
    function owNotice(n) {
      // window.Notice may be absent in odd embeddings — spin+log always work
      // regardless (brief §6 risk: "setIcon/Notice לא חשופים").
      if (typeof window.Notice !== 'function') return;
      new window.Notice(n ? (n + ' external changes found') : 'No new external changes');
    }

    var rescanning = false;
    function doRescan() {
      if (rescanning || typeof fs.rescan !== 'function') return;
      rescanning = true;
      setSpin(true);
      fs.rescan()
        .then(function (r) {
          var n = (r && r.changed) || 0;
          console.log('[ow] rescan: ' + n + ' changed');
          owNotice(n);
        })
        .catch(function (e) { console.warn('[ow] folder rescan failed', e); })
        .then(function () { rescanning = false; setSpin(false); });
    }

    // fallback trigger — only when there's no observer to do this for us.
    // visibilitychange, not window focus — more resilient: fires reliably on
    // tab-switch/app-resume, unlike focus which some mobile browsers skip.
    if (!hasObserver) {
      var debouncedRescan = debounce(function () {
        if (!document.hidden) doRescan();
      }, 500);
      document.addEventListener('visibilitychange', debouncedRescan);
    }

    // ── manual refresh button — injected into the file-explorer's own
    // nav-buttons-container (docs/plans/folder-refresh-toolbar.md §0.1 spike,
    // executor, Chromium headless against the real 1.12.7 mobile bundle) ────
    // §0.1א (DOM): `.workspace-leaf-content[data-type="file-explorer"]
    // .nav-header .nav-buttons-container` exists and holds 5 native
    // `.nav-action-button` siblings (New note/New folder/Change sort
    // order/Auto-reveal/Expand all). Exact markup, verified via outerHTML:
    // `<div class="clickable-icon nav-action-button" aria-label="...">`
    // wrapping an inline `<svg class="svg-icon lucide-<name>" .../>` — a
    // `<div>`, not a `<button>` (matches the brief's §3א pseudocode). We
    // clone that shape exactly instead of the old fixed-position overlay.
    // §0.1ג (icon): `window.setIcon`/`obsidian.setIcon` are NOT exposed
    // globally in this bundle (confirmed empirically — `typeof
    // window.setIcon === 'undefined'`) → inline SVG. `OW_REFRESH_SVG` below
    // uses the *exact* path data lucide-refresh-cw resolves to in this
    // bundle's icon table (grepped from app.js, not the generic/newer lucide
    // shape — bundled lucide versions drift), so it matches the sibling
    // icons pixel-for-pixel.
    // §0.1ב (timing/re-mount): the file-explorer view mounts after boot and
    // can remount (layout-change fires 8x in this bundle — confirmed a real,
    // subscribable `app.workspace` event via `workspace.trigger('layout-
    // change')` in the spike). `mountRefreshButton` is idempotent (dedupe via
    // `.querySelector('.ow-folder-refresh-btn')` per bar) so it's safe to
    // call both once via `owWhenAppReady` (first mount) and again on every
    // `layout-change` (recovers from remounts) without ever duplicating.
    var OW_REFRESH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-refresh-cw">' +
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>' +
      '<path d="M21 3v5h-5"></path>' +
      '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>' +
      '<path d="M8 16H3v5"></path></svg>';

    function mountRefreshButton() {
      var bars = document.querySelectorAll(
        '.workspace-leaf-content[data-type="file-explorer"] .nav-buttons-container');
      for (var i = 0; i < bars.length; i++) {
        var bar = bars[i];
        if (bar.querySelector('.ow-folder-refresh-btn')) continue;   // dedupe
        var btn = document.createElement('div');   // nav-action-button is a div in this bundle
        btn.className = 'clickable-icon nav-action-button ow-folder-refresh-btn';
        btn.setAttribute('aria-label', 'Refresh — external folder changes');
        btn.innerHTML = OW_REFRESH_SVG;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          doRescan();
        });
        bar.appendChild(btn);
      }
    }

    // guard מקומי (owWaitForWorkspace pattern, vault-note-deeplink finding,
    // boot.js:1037-1053): window.app.vault יכול להיות קיים לפני
    // window.app.workspace (App.onload אסינכרוני) — owWhenAppReady לבד לא
    // מבטיח את זה. owWaitForWorkspace עצמו מוגדר scope-מקומי במקום אחר בקובץ
    // (לא נגיש מכאן) — פולינג-מקומי זהה, לא מגדיר מחדש את ה-helper המקורי.
    owWhenAppReady(function (app) {
      function whenWorkspaceReady(tries) {
        if (app.workspace) {
          mountRefreshButton();
          app.workspace.on('layout-change', mountRefreshButton);
          return;
        }
        if ((tries || 0) >= 160) return;   // timeout שקט — עקבי עם owWhenAppReady/owWaitForWorkspace
        setTimeout(function () { whenWorkspaceReady((tries || 0) + 1); }, 50);
      }
      whenWorkspaceReady(0);
    });
  }

  // ── sync toolbar: PUSH + PULL buttons (was a single "Sync now" button;
  // the pull-sync brief §2/§3ד, pattern reused from installFolderRefreshWatch's
  // manual-refresh button above) ────────────────────────────────────────────
  // v1 = OPFS-local vaults only (brief §3א round-3 finding — the sync
  // engine's default OPFS root resolution only matches 'local' vaults'
  // layout). This VAULT_TYPE check is the ONE guard point run-pull.js
  // itself relies on (it never re-checks __owVaultType). A vault with no
  // stored `ow-sync:<id>` config (brief §3ה — v1 has no settings-UI, set
  // via localStorage directly) never gets buttons, never touches the
  // network, never hashes anything (brief §5 DoD#6).
  //
  // Each button runs its own mode against the SAME runner:
  //   Pull → run(vaultId, cfg, 'pull')  downloads + conforms + resolves
  //          conflicts (server wins; local content preserved as a copy)
  //   Push → run(vaultId, cfg, 'push')  uploads + commits only; never
  //          rewrites or deletes a local file
  // Feedback rules (why the old single button "did nothing"): every click
  // produces EXACTLY ONE visible Notice — success counts, busy-skip, or the
  // failure's own message (shown 10s) — and the spinner is cleared through a
  // try/catch-wrapped promise chain, so even a synchronous throw can't leave
  // a button spinning. remote-client.js additionally times every request out
  // after 30s (ETIMEOUT), so a stalled network can't spin forever either.
  function installSyncNowTrigger() {
    if (VAULT_TYPE !== 'local') return;
    // Bidirectional runner when its script is present (sync/run-sync.js —
    // pushes local changes too); pull-only run-pull.js stays as the fallback
    // for deployments that ship without it. Both expose the same entry shape;
    // run-pull ignores the (unimplemented) 'push' mode, so Push only renders
    // when the bidirectional runner is actually loaded.
    var runner = window.__owSyncRunSync || window.__owSyncRunPull;
    if (!runner) return;
    if (!runner.getSyncConfig(VAULT_ID)) return; // guard — no config → no buttons, no network (DoD#6)
    var hasPush = !!window.__owSyncRunSync;
    // Live re-read, NOT a mount-time capture: the credential is
    // sessionStorage-scoped now, and a session can gain/refresh its token
    // after this function has already run (the resume gate writes it during
    // verify). Every run() call must use the CURRENT config.
    function syncCfg() { return runner.getSyncConfig(VAULT_ID); }

    // lucide "cloud-download"/"cloud-upload" path data (stable across lucide
    // releases — unlike the refresh icon, these weren't grepped from this
    // bundle's app.js because they aren't pre-existing bundle icons; inline
    // SVG doesn't depend on the bundle's icon table either way, brief §3ו /
    // folder-refresh-toolbar §0.1ג precedent: window.setIcon isn't exposed
    // here).
    var OW_PULL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-cloud-download">' +
      '<path d="M12 13v8"></path><path d="m8 17 4 4 4-4"></path>' +
      '<path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"></path></svg>';
    var OW_PUSH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-cloud-upload">' +
      '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"></path>' +
      '<path d="M12 12v9"></path><path d="m16 16-4-4-4 4"></path></svg>';

    function setSpin(on) {
      var btns = document.querySelectorAll('.ow-sync-now-btn');
      for (var i = 0; i < btns.length; i++) {
        if (on) btns[i].classList.add('is-spinning');
        else btns[i].classList.remove('is-spinning');
      }
    }

    // One visible message per event, always. Notice(message, durationMs).
    function notify(msg, ms) {
      if (typeof window.Notice === 'function') new window.Notice(msg, ms || 5000);
      else console.log('[ow-sync] ' + msg);
    }

    var running = false;
    // While a sync runs: spinner ON + buttons disabled (no clicks, no error
    // toast — the spin is the feedback; "sync already running" on a
    // double-click read as a random failure).
    function setBusy(on) {
      running = on;
      setSpin(on);
      var btns = document.querySelectorAll('.ow-sync-now-btn');
      for (var i = 0; i < btns.length; i++) {
        if (on) {
          btns[i].classList.add('is-disabled');
          btns[i].style.opacity = '0.5';
          btns[i].style.pointerEvents = 'none';
        } else {
          btns[i].classList.remove('is-disabled');
          btns[i].style.opacity = '';
          btns[i].style.pointerEvents = '';
        }
      }
    }
    function doSync(mode) {
      if (running) return; // buttons are disabled while running; belt-and-suspenders
      // Pull writes into OPFS from outside Obsidian's own adapter, so the
      // explorer only picks the new notes up on a full page load — hence the
      // pre-sync warning (requested): tell the user the page will refresh,
      // then reload right after a successful pull.
      if (mode === 'pull' && !window.confirm(
        'The page will refresh after pulling so the new notes appear. Continue?')) {
        return; // declined — no sync, no spinner, no reload
      }
      running = true;
      setBusy(true);
      var p;
      try {
        p = runner.run(VAULT_ID, syncCfg(), mode); // 'pull' | 'push'
      } catch (e) {
        p = Promise.reject(e); // sync throw must not leave the spinner on
      }
      Promise.resolve(p)
        .then(function (r) {
          // The runners signal a stuck mutex as {skipped:true, reason:'busy'}
          // and ONLY that — while on a success summary `skipped` is a COUNT of
          // unchanged files (run-sync.js: summary.skipped = plan.inSync +
          // plan.setSynced + plan.forgetSynced + …, e.g. 237 on a real vault).
          // A bare `r.skipped` truthiness test therefore flagged EVERY
          // successful sync as busy: the notice replaced the real counts and
          // the pull's reload below never fired ("Pull does nothing" — the
          // notes only appeared after a manual refresh).
          if (!r || r.reason === 'busy' || r.skipped === true) {
            // Only reachable if the runner's mutex is stuck (previous run
            // never finished) — say what to DO instead of "try again".
            notify("The previous sync hasn't finished — if the spinner never stops, reload the page.", 8000);
            return;
          }
          if (mode === 'push') {
            var msg = 'Pushed: ' + (r.pushed || 0) + ' files';
            if (r.deleted) msg += ', ' + r.deleted + ' deleted';
            if (r.conflicts) msg += ', ' + r.conflicts + ' conflicts (will resolve on next pull)';
            notify(msg + (r.pushSupported === false ? ' · server is pull-only' : ''));
          } else {
            notify('Pulled: ' + (r.downloaded || 0) + ' downloaded' +
              (r.conflicts ? ', ' + r.conflicts + ' conflicts' : '') +
              ' — reloading the page…', 8000);
            // As promised in the confirm() above: reload so the explorer
            // re-reads OPFS and the pulled notes appear immediately.
            // (Failure paths never reach here — no reload on error.)
            setTimeout(function () { window.location.reload(); }, 1500);
          }
          console.log('[ow-sync] mode=' + mode, r);
        })
        .catch(function (e) {
          console.warn('[ow-sync] sync failed (' + mode + '):', e);
          // The runner's own error text (HTTP status, 401, timeout…) — the
          // old generic 'סנכרון נכשל' hid WHY, which read as "does nothing".
          notify('Sync (' + (mode === 'push' ? 'push' : 'pull') + ') failed: ' +
            ((e && e.message) || e), 10000);
        })
        .then(function () { setBusy(false); });
    }

    function mountSyncButtons() {
      var bars = document.querySelectorAll(
        '.workspace-leaf-content[data-type="file-explorer"] .nav-buttons-container');
      for (var i = 0; i < bars.length; i++) {
        var bar = bars[i];
        if (bar.querySelector('.ow-sync-pull-btn')) continue;   // dedupe
        var defs = [
          { cls: 'ow-sync-pull-btn', svg: OW_PULL_SVG,
            label: 'Pull from server', mode: 'pull' },
        ];
        if (hasPush) {
          defs.unshift({ cls: 'ow-sync-push-btn', svg: OW_PUSH_SVG,
            label: 'Push to server', mode: 'push' });
        }
        for (var d = 0; d < defs.length; d++) {
          (function (def) {
            var btn = document.createElement('div'); // nav-action-button is a div in this bundle
            btn.className = 'clickable-icon nav-action-button ow-sync-now-btn ' + def.cls;
            btn.setAttribute('aria-label', def.label);
            btn.innerHTML = def.svg;
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              doSync(def.mode);
            });
            bar.appendChild(btn);
          })(defs[d]);
        }
      }
      // A remount while a sync runs (layout-change) must inherit the
      // disabled+spinning state instead of coming back clickable.
      if (running) setBusy(true);
    }

    // ── auto-push: edits sync in the background ──────────────────────────
    // Manual buttons alone meant changes sat on the device until someone
    // remembered to click (and a failed click looked like "sync is
    // broken"). Now:
    //   • vault events (create/modify/delete/rename) debounce ~20s, then a
    //     quiet 'push' run — success only logs (no toast spam), failure
    //     notifies at most once per 5 minutes;
    //   • hiding/closing the tab flushes a best-effort push immediately
    //     (visibilitychange/pagehide — no guarantee the network finishes,
    //     but the debounce above means most edits are already up);
    //   • ~45s after boot, one delayed push catches anything edited DURING
    //     the startup sync (which planned from a pre-edit local manifest).
    // Pushing never rewrites local files, so running it under a live app is
    // safe; pulling mid-session is deliberately NOT automatic (OPFS writes
    // behind Obsidian's back only show after a reload) — the startup sync
    // and the manual Pull button cover that side.
    var AUTO_PUSH_DEBOUNCE_MS = 20000;
    var AUTO_PUSH_MIN_GAP_MS = 45000;
    var AUTO_FAIL_NOTICE_GAP_MS = 5 * 60 * 1000;
    var autoPushTimer = null;
    var autoFlushTimer = null;
    var lastAutoPushAt = 0;
    var lastAutoFailNoticeAt = 0;

    function autoPush(reason) {
      if (!hasPush) return;
      var cfgNow = syncCfg();
      if (!cfgNow) return;                       // credential gone (session ended elsewhere) — stay quiet
      if (running) return;                       // manual sync in flight
      var runnerStatus = runner.getStatus && runner.getStatus();
      if (runnerStatus && runnerStatus !== 'idle') {   // busy (startup sync / another run) — retry shortly
        scheduleAutoPush(30000);
        return;
      }
      var now = Date.now();
      if (now - lastAutoPushAt < AUTO_PUSH_MIN_GAP_MS) {
        scheduleAutoPush(AUTO_PUSH_MIN_GAP_MS - (now - lastAutoPushAt));
        return;
      }
      lastAutoPushAt = now;
      var p;
      try {
        p = runner.run(VAULT_ID, cfgNow, 'push');
      } catch (e) {
        p = Promise.reject(e);
      }
      Promise.resolve(p)
        .then(function (r) {
          if (r && (r.reason === 'busy' || r.skipped === true)) { scheduleAutoPush(30000); return; }
          if (r && (r.pushed || r.deleted)) console.log('[ow-sync] auto-push (' + reason + '):', r);
        })
        .catch(function (e) {
          console.warn('[ow-sync] auto-push (' + reason + ') failed:', (e && e.message) || e);
          var t = Date.now();
          if (t - lastAutoFailNoticeAt >= AUTO_FAIL_NOTICE_GAP_MS) {
            lastAutoFailNoticeAt = t;
            notify('Auto-sync failed: ' + ((e && e.message) || e) + ' — will retry on your next edit', 10000);
          }
        });
    }

    function scheduleAutoPush(delayMs) {
      if (autoPushTimer) clearTimeout(autoPushTimer);
      autoPushTimer = setTimeout(function () {
        autoPushTimer = null;
        autoPush('debounced');
      }, delayMs === undefined ? AUTO_PUSH_DEBOUNCE_MS : delayMs);
    }

    // Tab going away: one short-debounce flush (browsers keep timers alive
    // briefly after 'hidden'; pagehide covers close/navigate).
    function flushAutoPush() {
      if (autoPushTimer) { clearTimeout(autoPushTimer); autoPushTimer = null; }
      if (autoFlushTimer) clearTimeout(autoFlushTimer);
      autoFlushTimer = setTimeout(function () { autoPush('tab-hidden'); }, 300);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) flushAutoPush();
    });
    window.addEventListener('pagehide', flushAutoPush);

    // same App.onload race guard as installFolderRefreshWatch above
    // (app.vault can exist before app.workspace).
    owWhenAppReady(function (app) {
      function whenWorkspaceReady(tries) {
        if (app.workspace) {
          mountSyncButtons();
          app.workspace.on('layout-change', mountSyncButtons);
          return;
        }
        if ((tries || 0) >= 160) return;
        setTimeout(function () { whenWorkspaceReady((tries || 0) + 1); }, 50);
      }
      whenWorkspaceReady(0);

      if (hasPush && app.vault && typeof app.vault.on === 'function') {
        ['create', 'modify', 'delete', 'rename'].forEach(function (ev) {
          try { app.vault.on(ev, function () { scheduleAutoPush(); }); } catch (e) { }
        });
        // Edits made WHILE the startup sync ran were invisible to its local
        // manifest (built before them) — one delayed push picks them up.
        scheduleAutoPush(45000);
      }
    });
  }

  // ── startup-sync deadline helper ──────────────────────────────────────────
  // Promise.race with a deadline, so a wedged sync server can't keep the
  // vault from opening. The losing promise keeps running in the background
  // (the runner's mutex reports later runs as busy until it settles —
  // auto-push reschedules instead of stacking up).
  var OW_STARTUP_SYNC_TIMEOUT_MS = 4 * 60 * 1000;
  function owWithTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error('sync did not finish within ' + Math.round(ms / 1000) + 's — opening the vault anyway'));
      }, ms);
      Promise.resolve(promise).then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); });
    });
  }

  setStatus('Verifying vault...');

  // אמת שה-vault קיים: local → OPFS getDirectoryHandle (idempotent, אין
  // bootstrap בשרת ל-local); folder → שחזור handle מ-IndexedDB + permission
  // gate (queryPermission → showGrantScreen אם צריך); server → HTTP stat על
  // ה-root (כמו קודם).
  var verifyPromise;
  if (VAULT_TYPE === 'local') {
    verifyPromise = (async function () {
      if (!window.__owOpfsStore) throw new Error('OPFS store not loaded');
      var root = await navigator.storage.getDirectory();
      var vaults = await root.getDirectoryHandle('vaults', { create: true });
      await vaults.getDirectoryHandle(VAULT_ID, { create: true });   // idempotent
      return { isDirectory: true };
    })();
  } else if (VAULT_TYPE === 'folder') {
    verifyPromise = (async function () {
      if (!window.__owOpfsStore) throw new Error('OPFS store not loaded');
      if (!window.__owFolderHandles) throw new Error('folder handle store not loaded');
      var h = await window.__owFolderHandles.loadHandle(VAULT_ID);
      if (!h) throw new Error('folder handle missing — re-open the folder');
      var perm = await h.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await showGrantScreen(h);   // נתיב ראשי: כפתור → requestPermission (gesture)
      if (perm !== 'granted') throw new Error('Access not granted');
      window.__owFolderRoot = h;                                 // רק אחרי granted
      return { isDirectory: true };
    })();
  } else if (window.__owBackend === 'none') {
    // §3.2 → vault-gate flow. VAULT_TYPE fell back to 'server' because
    // VAULT_ID isn't in the local registry: an unrecognized deep-link
    // (shared name link /vault/<name>, wiped storage, different device —
    // exactly the r/ObsidianMD scenario, §0). window.__owBackend==='none' is
    // a client-only BUILD (injected only by the CF/Vercel build, see
    // index.html/build-assets) — there is no /api/fs to ask, so instead of
    // the old immediate human error, showVaultGate (above) asks the sync
    // server whether the name is claimed and renders the password prompt
    // (claim-or-unlock) in this same overlay. Success registers the name +
    // its mpv1 token (sessionStorage — forgotten when the tab closes) and
    // reloads; failure rejects with the SAME human message as before
    // (err.owHuman, shared .catch below → no "Error: " prefix). A
    // deployment with no /sync/v1 at all (404 — the CF build) gets an
    // explicit "create it here" local-vault fallback instead; offline →
    // that exact old error path, unchanged (DoD: runtime-server never sets
    // __owBackend, so it still runs the /api/fs stat branch).
    verifyPromise = showVaultGate(VAULT_ID);
  } else {
    verifyPromise = fetch('/api/fs/stat?vault=' + encodeURIComponent(VAULT_ID) + '&path=')
      .then(function (res) {
        if (!res.ok) throw new Error('Vault not found (HTTP ' + res.status + ')');
        return res.json();
      });
  }

  verifyPromise
    .then(async function(stat) {
      if (!stat || (!stat.isDirectory && stat.type !== 'directory')) throw new Error('Vault path is not a directory');

      // brief §3ב finding 4 (קריטי): מתקינים את הגישור גם כשכספת פתוחה — לא
      // רק בענף no-vault (למטה). בלי זה, switch/close שרצים מתוך vault פתוח
      // (בחירת vault אחר ברשימה, "close-vault"/openVaultChooser) רצים
      // נייטיבית (setItem/removeItem+reload) ולא נוחתים על /vault/<newid>
      // או /starter בהתאמה. installNativeVaultOpenBridge idempotent
      // (window.__owNativeVaultBridgeInstalled) — בטוח לקרוא גם אם הענף
      // no-vault כבר התקין (לא קורה באותו טעינת-עמוד, אבל להיות עקבי).
      installNativeVaultOpenBridge();

      // ── session credential resume — claimed (synced) vaults ──────────────
      // The mpv1 token is sessionStorage-only ("forget the password when the
      // page is closed"), so every NEW session of a claimed vault starts
      // with the localStorage marker but no credential. Ask for the password
      // once, HERE, before Obsidian loads: the unlock writes the session
      // token, and the startup sync right below can use it immediately.
      // "Continue without syncing" (or a dead network) resolves skipped —
      // the vault still opens; this session just stays offline/unsynced.
      if (VAULT_TYPE === 'local' && getSyncClaimMarker(VAULT_ID)) {
        var resumeRunner = window.__owSyncRunSync || window.__owSyncRunPull;
        var haveSessionCfg = resumeRunner && resumeRunner.getSyncConfig(VAULT_ID);
        if (!haveSessionCfg) {
          try {
            await showVaultGate(VAULT_ID, { optional: true });
          } catch (e) {
            console.warn('[obsidian-web] sync unlock skipped:', (e && e.message) || e);
          }
        }
      }

      // ── startup sync — BEFORE Obsidian loads (the "better syncing" core) ──
      // Pulling while the app runs was always half-broken: files land in
      // OPFS behind Obsidian's back and the explorer only sees them after a
      // full reload (hence the old confirm()+reload Pull button). Syncing
      // HERE — after verify, before injectMobileScripts — means downloaded
      // files are on disk before the vault is first read, so they simply
      // appear: no reload, no stale explorer. The seed guard below also sees
      // the synced content (a fresh non-empty claim never gets example
      // content seeded over server files). Failures NEVER block boot:
      // offline or a dead sync server just logs, and the vault opens with
      // whatever is local. A stuck run is capped by the deadline
      // (owWithTimeout) — boot proceeds; the run keeps going in the
      // background (mutex → later auto-pushes skip until it settles).
      var startupSyncSummary = null;
      if (VAULT_TYPE === 'local') {
        var startupRunner = window.__owSyncRunSync || window.__owSyncRunPull;
        var startupCfg = startupRunner && startupRunner.getSyncConfig(VAULT_ID);
        if (startupRunner && startupCfg) {
          setStatus('Syncing…');
          try {
            startupSyncSummary = await owWithTimeout(
              startupRunner.run(VAULT_ID, startupCfg, 'both'),
              OW_STARTUP_SYNC_TIMEOUT_MS);
            if (startupSyncSummary && startupSyncSummary.reason === 'busy') startupSyncSummary = null;
            console.log('[ow-sync] startup sync:', startupSyncSummary);
          } catch (e) {
            console.warn('[ow-sync] startup sync failed (opening local content):', (e && e.message) || e);
            startupSyncSummary = { failed: (e && e.message) || String(e) };
          }
        }
      }
      // Report the startup run once the app can show Notices (window.Notice
      // exists only after the bundle loads — owWhenAppReady polls for it).
      if (startupSyncSummary) {
        (function (summary) {
          owWhenAppReady(function () {
            if (typeof window.Notice !== 'function') return;
            if (summary.failed) {
              new window.Notice('Sync failed: ' + summary.failed + ' — opened local content only', 10000);
            } else if (summary.downloaded || summary.pushed || summary.deleted || summary.conflicts) {
              new window.Notice('Synced: ' + (summary.downloaded || 0) + ' pulled, ' +
                (summary.pushed || 0) + ' pushed' +
                (summary.conflicts ? ', ' + summary.conflicts + ' conflicts (kept as copies)' : ''), 8000);
            }
          });
        })(startupSyncSummary);
      }

      // ── seed guard — empty-vault-only (seed-demo §0/§3ב, data-safety core) ──
      // A local/folder vault the user already has real content in must NEVER
      // be seeded (system plugins OR example content) without consent —
      // today's unconditional seed damages real vaults (brief §0). readdir
      // root, filter out .obsidian/.trash (Obsidian's own bookkeeping, not
      // user content) — ANY remaining entry → "not empty" → skip BOTH blocks
      // below entirely. readdir failure (e.g. permission edge) defaults to
      // "not empty" (skip) — data-safety-first when uncertain. `seedStore` is
      // reused by both blocks below (one makeStore()+readdir round-trip).
      var seedStore = null;
      var isVaultEmptyForSeed = false;
      if ((VAULT_TYPE === 'local' || VAULT_TYPE === 'folder') && window.__owOpfsStore) {
        var grSeed = VAULT_TYPE === 'folder' ? (async () => window.__owFolderRoot) : undefined;
        seedStore = window.__owOpfsStore.makeStore(VAULT_ID, { getRoot: grSeed });
        try {
          var rootListing = await seedStore.readdir({ path: '' });
          var userEntries = ((rootListing && rootListing.files) || []).filter(function (f) {
            return f.name !== '.obsidian' && f.name !== '.trash';
          });
          isVaultEmptyForSeed = userEntries.length === 0;
        } catch (e) {
          console.warn('[ow] seed guard readdir failed — skipping seed (data-safety default)', e);
        }
      }

      // seed system plugins ל-OPFS/folder לפני טעינת Obsidian (כדי ש-
      // community-plugins.json יהיה מוכן כש-Obsidian קורא אותו) — local
      // (OPFS) ו-folder vaults (לא server, שמקבל אותם דרך overlay צד-שרת
      // קיים). לא חוסם את הפתיחה אם נכשל (retry ב-boot הבא דרך ה-version-gate).
      // isVaultEmptyForSeed (למעלה): לעולם לא בכספת עם תוכן-משתמש קיים.
      if (isVaultEmptyForSeed && seedStore && window.__owSeedSystemPlugins) {
        try { await window.__owSeedSystemPlugins.seedSystemPlugins(seedStore); }
        catch (e) { console.warn('[ow] seed system plugins failed', e); }
      }

      // seed example content (Welcome.md, Features/*) לתוך vault ריק — CF static
      // בלבד (example-vault.json קיים רק ב-build של ה-CF deployment; מקומי
      // fetch מחזיר 404 ו-seedExampleVault מדלג). לא נוגע ב-.obsidian/ (finding
      // 1 בבריף — הקונפיג בבלעדיות של seedSystemPlugins למעלה). לא חוסם את
      // הפתיחה אם נכשל. ראה docs/plans/cf-mobile-seed.md §3ג.
      // deploy-config.md §3(ג): המתג seedExampleContent (ברירת-מחדל true —
      // התנהגות היום, DoD#2/#5) — ES5 guard pattern (avigail):
      // (window.__owConfig && window.__owConfig.X). isVaultEmptyForSeed
      // (למעלה): לעולם לא בכספת עם תוכן-משתמש קיים (seed-demo §0/§3ב).
      if (isVaultEmptyForSeed && seedStore && window.__owSeedExampleVault
          && (window.__owConfig && window.__owConfig.seedExampleContent)) {
        try {
          // seedExampleVault resolves true only when it actually wrote files
          // (calev-heavy Commit-3 phase-verify NBug2 —
          // reports/obsidian-web/demo-origin-split-commit3-calev.md): a
          // silent skip (missing/failed /example-vault.json fetch) must NOT
          // be mistaken for success below.
          var seeded1 = await window.__owSeedExampleVault.seedExampleVault(seedStore);
          // 🔴 אביגיל ממצא 7 — כתיבת המפתח מתווספת גם כאן, מיד אחרי הזריעה
          // הראשונה המוצלחת: בלי זה, בבוט הראשון של הדמו localStorage ריק,
          // הבלוק החדש למטה (re-seed-on-change) רואה "שונה" ורץ force:true
          // מיד אחרי הזריעה הראשונה — זריעה כפולה. 🔴 ולכתיבה הזו חייב להיות
          // אותו guard VAULT_ID===DEMO_ID (אביגיל סבב 2, ממצא 1): הבלוק הזה
          // רץ על **כל** כספת local/folder ריקה, לא רק הדמו — בלי ה-guard,
          // כספת local ריקה שהמבקר יצר לעצמו הייתה כותבת את ה-hash הנוכחי
          // ל-localStorage['ow-demo-content'] (מפתח אחד לכל המקור), ומסמנת
          // בטעות את כספת-הדמו האמיתית כ"כבר מעודכנת" — זריעה-מחדש לא הייתה
          // רצה לעולם, באג שקט שאין לו טסט/DoD חוץ מה-guard הזה. seeded1
          // (למעלה): לא לסמן "בוצע" על סמך ניסיון שדולג/נכשל בשקט (NBug2).
          if (seeded1 && VAULT_ID === DEMO_ID && window.__owDemoContent) {
            try { localStorage.setItem('ow-demo-content', window.__owDemoContent); } catch (e) {}
          }
        }
        catch (e) { console.warn('[ow] seed example vault failed', e); }
      }

      // ── re-seed demo content on change (docs/plans/demo-origin-split.md §4
      // Commit 3) — בלוק חדש ונפרד, לא מתערבב עם הזריעה-הראשונה למעלה. כשה-
      // hash שהוזרק בבניה (window.__owDemoContent, Commit 1) שונה מהמסומן
      // ב-localStorage (בוט קודם, אחרי template.js השתנה בין הבניות), דורס
      // מחדש רק את קבצי-התבנית (force:true — .obsidian/ עדיין מדולג, קבצי
      // המבקר עצמו לא נוגעים). רק בכספת הדמו (VAULT_ID===DEMO_ID) — כספת
      // אחרת של המשתמש לעולם לא נדרסת. כישלון (או ניסיון שדולג בשקט — seeded2
      // false, NBug2) לא חוסם את הפתיחה ולא מעדכן את המפתח, כדי שהניסיון
      // יחזור בבוט הבא (try/catch+console.warn, כמו הבלוק שמעליו). cacheBust
      // (NBug1, אותו דוח): מעביר את ה-hash החדש שכבר בידינו כ-query string —
      // ה-fetch עצמו יוצא נגד URL שמעולם לא נכנס ל-cache (של ה-SW הישן
      // *או* החדש), כך ש-service worker קודם שעדיין שולט בעמוד (redeploy,
      // takeover אסינכרוני) לא יכול להחזיר hit על תוכן ה-build הקודם.
      if (seedStore && window.__owSeedExampleVault
          && (window.__owConfig && window.__owConfig.seedExampleContent)
          && !(window.__owConfig && window.__owConfig.demoVault && window.__owConfig.demoVault.enabled === false)
          && VAULT_ID === DEMO_ID
          && window.__owDemoContent
          && window.__owDemoContent !== localStorage.getItem('ow-demo-content')) {
        try {
          var seeded2 = await window.__owSeedExampleVault.seedExampleVault(seedStore, { force: true, cacheBust: window.__owDemoContent });
          if (seeded2) {
            localStorage.setItem('ow-demo-content', window.__owDemoContent);
          } else {
            // calev-heavy end-of-slice verify (finding 5 —
            // reports/obsidian-web/demo-origin-split-calev.md): a silent
            // (non-throwing) skip — e.g. /example-vault.json fetch failed —
            // still needs the field diagnostic the brief asks for here
            // ("try/catch + console.warn"). The key correctly stays
            // un-updated either way (retry next boot); this only adds the
            // missing log line for that path.
            console.warn('[ow] re-seed example vault (content changed): seed did not complete — will retry next boot');
          }
        } catch (e) { console.warn('[ow] re-seed example vault (content changed) failed', e); }
      }

      setStatus('Loading Obsidian mobile...');
      console.log('[obsidian-web] vault ok, injecting mobile scripts');

      // ── Bootstrap fetch (parallel to script injection) — SERVER VAULTS ONLY.
      // /api/bootstrap returns the entire .obsidian/ tree + vault content
      // + dirs in one pre-compressed response. We expose it on
      // window.__owBootstrapCache so capacitor-shim's Filesystem.readFile/
      // stat/readdir can answer from cache instead of round-tripping per
      // file. watchAndStatAll awaits __owBootstrapPromise instead of
      // re-fetching. See docs/plans/mobile-bootstrap-cache.md.
      //
      // Local vaults have no server bootstrap endpoint (static-file server
      // only, per brief §2 scope boundary) — OpfsStore.watchAndStatAll
      // supplies the file tree directly from OPFS, no fetch needed. See
      // docs/plans/opfs-wire.md §4 Commit 1(ג).
      if (VAULT_TYPE === 'server') {
        var bootstrapPromise = fetch(
          '/api/bootstrap?vault=' + encodeURIComponent(VAULT_ID) + '&full=1',
          { headers: { 'Accept-Encoding': 'br, gzip' } },
        )
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data) return null;
            if (data.disabled) {
              console.log('[obsidian-web] bootstrap disabled by server, all FS reads will round-trip');
              window.__owBootstrapCache = null;
              return null;
            }
            window.__owBootstrapCache = data;
            var fileCount = data.fs ? Object.keys(data.fs).length : 0;
            var capped = data.capped ? ' (CAPPED: ' + data.cappedReason + ')' : '';
            console.log('[obsidian-web] bootstrap loaded: ' + fileCount + ' files cached' + capped);
            return data;
          })
          .catch(function (err) {
            console.warn('[obsidian-web] bootstrap failed:', err && err.message || err);
            window.__owBootstrapCache = null;
            return null;
          });
        window.__owBootstrapPromise = bootstrapPromise;
      }

      // הזרקה דינמית — browser מוריד במקביל, מריץ לפי סדר (async=false).
      // חולצה ל-injectMobileScripts() למעלה — נגישה גם לזרימת ה-no-vault.
      injectMobileScripts();

      // folder-vault external-change refresh (docs/plans/folder-watch.md §2) —
      // VAULT_TYPE guard is inside installFolderRefreshWatch itself (no-op
      // ל-local/server).
      installFolderRefreshWatch();

      // pull-sync "Sync now" trigger (the pull-sync brief
      // §2/§3ד) — VAULT_TYPE + config guards are inside installSyncNowTrigger
      // itself (no-op unless local vault + a stored ow-sync: config, brief
      // §5 DoD#6).
      installSyncNowTrigger();

      // ── שם-כספת מוצג מה-registry (docs/plans/vault-name-display.md §2/§3) ──
      // לכספת OPFS (local/folder) עם רשומת-registry, __owV.name הוא השם
      // שהמשתמשת נתנה; app.vault.getName() (basePath — ה-vault-id hash
      // לכספות OPFS) לא מתאים לתצוגה בפאנל (§0). guard: רק local/folder +
      // __owV.name לא-ריק — server ממשיך עם basename תקין (DoD#3, §2 "שינוי
      // לשם המוצג בכספת server ❌"), יתום (אין רשומה) נופל ל-getName הרגיל
      // (§9 Q3). ה-guard רץ רק בזרימת ה-VAULT_ID (לא בזרימת no-vault למעלה,
      // ששם VAULT_TYPE='server' תמיד) — עונה על גבול §2 "אחרי app-ready".
      if ((VAULT_TYPE === 'local' || VAULT_TYPE === 'folder') && __owV && __owV.name) {
        owWhenAppReady(function (app) {
          var desired = __owV.name;
          if (app.vault && typeof app.vault.getName === 'function') {
            var orig = app.vault.getName.bind(app.vault);
            app.vault.getName = function () { return desired || orig(); };
          }
          refreshVaultProfileLabel(desired);
        });
      }

      // הסרת ספינר כשה-workspace מוכן
      removeLoadingOverlayWhen('.workspace');

      // executor finding (vault-note-deeplink, אמפירי בChromium): owWhenAppReady
      // (מ-#1) בודק רק window.app && window.app.vault — App.onload הוא
      // async-generator (`this.vault=new mx(t)` ואז כמה awaits לפני
      // `this.workspace=...`, מאומת בgrep על הbundle), אז window.app.workspace
      // עלול עדיין להיות undefined באותו tick ש-vault כבר קיים (נתפס פעם אחת
      // ב-4 ריצות — "Cannot read properties of undefined (reading
      // 'onLayoutReady')"). guard מקומי — לא נוגע/מגדיר מחדש את owWhenAppReady
      // עצמו, רק ממתין בנוסף ל-workspace לפני שממשיכים. משותף לכיוון-נכנס
      // (למטה) ולכיוון-יוצא (§3ג, למטה).
      // timeout מוגבל (calev finding: אחרת רקורסיה אינסופית אם App.onload
      // קובע vault ואז נכשל לפני workspace — התיישר עם ה-8s deadline של
      // owWhenAppReady: 160 ניסיונות × 50ms. שקט בכשל — cb פשוט לא נקרא).
      function owWaitForWorkspace(app, cb, tries) {
        if (app.workspace) { cb(app); return; }
        if ((tries || 0) >= 160) return;
        setTimeout(function () { owWaitForWorkspace(app, cb, (tries || 0) + 1); }, 50);
      }

      // ── deep-link למסמך — כיוון-נכנס (vault-note-deeplink §3ב) ─────────────
      // NOTE_PATH הגיע מה-URL (/vault/<id>/<note-path>) — פותחים אותו אחרי
      // ש-workspace מוכן (onLayoutReady, לא רק window.app קיים — owWhenAppReady
      // לבד לא מבטיח שה-workspace layout כבר טעון). md בלי סיומת →
      // getFirstLinkpathDest (idiomatic ל-Obsidian, פותר קישורים); קובץ אחר
      // (עם סיומת, למשל תמונה) → fallback ל-getAbstractFileByPath (נתיב מדויק).
      // מסמך לא-קיים → graceful: נשאר בתצוגת-ברירת-מחדל של הכספת, בלי שגיאה
      // (DoD#3) — owWhenAppReady משתמש מחדש בהelper מ-vault-name-display (#1),
      // לא מוגדר מחדש.
      if (NOTE_PATH) {
        owWhenAppReady(function (app) {
          owWaitForWorkspace(app, function (app) {
            app.workspace.onLayoutReady(function () {
              var f = app.metadataCache.getFirstLinkpathDest(NOTE_PATH.replace(/\.md$/, ''), '')
                      || app.vault.getAbstractFileByPath(NOTE_PATH);
              if (f) app.workspace.getLeaf(false).openFile(f);
            });
          });
        });
      }

      // ── deep-link למסמך — כיוון-יוצא (vault-note-deeplink §3ג) ──────────────
      // מעדכן את ה-URL לפי הקובץ הפעיל בכל שינוי (ניווט לקישור, מעבר בין
      // מסמכים, סגירה). מקור-האמת הוא app.workspace.getActiveFile() (לא ה-arg
      // של file-open, finding 1 בבריף) — נרשם גם על file-open וגם על
      // active-leaf-change (file-open(null) לא מובטח בסגירה, active-leaf-change
      // כן יורה על leaf ריק → getActiveFile()===null → DoD#5). guard VAULT_ID +
      // מיקום בתוך בלוק vault-open בלבד (finding 2) — לא רץ בזרימת no-vault.
      // pathname!==url מונע history entries מיותרים ולולאה מול הפתיחה-הנכנסת
      // למעלה (replaceState לא עושה reload — boot לא רץ שוב, אין לולאה מבנית
      // גם בלי ה-guard). owWaitForWorkspace — אותו guard-הגנה כמו כיוון-נכנס
      // (§3ב, executor finding) למקרה ש-app.workspace עדיין undefined.
      owWhenAppReady(function (app) {
        if (!VAULT_ID) return;
        owWaitForWorkspace(app, function (app) {
          function syncUrlFromActiveFile() {
            var url = '/vault/' + encodeURIComponent(VAULT_ID);
            var file = app.workspace.getActiveFile && app.workspace.getActiveFile();
            if (file && file.path) {
              var p = file.path.replace(/\.md$/, '');
              url += '/' + p.split('/').map(encodeURIComponent).join('/');
            }
            if (location.pathname !== url) history.replaceState(null, '', url);
          }
          app.workspace.on('file-open', syncUrlFromActiveFile);
          app.workspace.on('active-leaf-change', syncUrlFromActiveFile);
        });
      });

      // ── "נהל כספות" <select> → openVaultChooser (polyfill) ────────────────
      // ה-<select> "נהל כספות" (vault-switcher, תחתית-שמאל) מקבל אופציה אחת
      // בלבד: "manage-vaults" (רשימת ה-vaults ריקה כי Bte() מחזיר ריק כשכספת
      // פתוחה — out-of-scope, ראה §2). מכיוון שהאופציה היחידה כבר הערך הנבחר,
      // הקשה עליה לא מפעילה `change` (הדפדפן לא יורה change באותה בחירה) →
      // openVaultChooser() לא נקרא → no-op. תופסים pointerdown+mousedown
      // (לפני native picker, לא change) בשלב ה-capture. guard opts.length<=1:
      // אם רשימת ה-vaults תאוכלס בעתיד (multi-option) → native change עובד →
      // לא מיירטים (docs/plans/vault-switcher-fix.md §3ב, §6).
      ['pointerdown', 'mousedown'].forEach(function (evt) {
        document.addEventListener(evt, function (e) {
          var sel = e.target && e.target.closest ? e.target.closest('select') : null;
          if (!sel) return;
          var opts = Array.prototype.slice.call(sel.options);
          // כל select עם 'manage-vaults' → openVaultChooser. (הוסר guard opts.length<=1:
          // כשה-vault זרוע-תוכן, Bte()/readdir מוסיף תת-ספריות כ"vaults" מדומים
          // — למשל 'Features' — אז length>1, אבל אלה אינם vaults אמיתיים ניתנים-למעבר.
          // מעבר-vault אמיתי קורה במסך-הפתיחה; לכן תמיד → chooser. תוקן אחרי שהבאג
          // צף על ה-demo החי (vault זרוע), בעוד calev בדק vault ריק (length 1).)
          if (opts.some(function (o) { return o.value === 'manage-vaults'; })) {
            e.preventDefault(); e.stopImmediatePropagation();   // מנסה לדכא את ה-native picker
            if (window.app && typeof window.app.openVaultChooser === 'function') {
              window.app.openVaultChooser();   // אומת: removeItem('mobile-selected-vault')+reload(500ms)→chooser
            }
          }
        }, true);
      });
    })
    .catch(function(err) {
      console.warn('[obsidian-web] vault check failed:', err.message);
      // §3.2 DoD#3: the unrecognized-deep-link message (owHuman, above) is
      // already a full human sentence — no "Error: (HTTP ...)" framing.
      // Every other verify failure (local/folder/real-server 404) keeps the
      // existing "Error: <message>" wording unchanged — no regression.
      setStatus(err.owHuman ? err.message : ('Error: ' + err.message));
      localStorage.removeItem('obsidian-web:lastVaultId');
      setTimeout(function(){ location.href = '/starter'; }, 2000);
    });
}());
