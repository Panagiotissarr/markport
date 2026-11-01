// GET  /sync/v1/vaults/:name — is this name claimed?
//        → { name, claimed: boolean }   (public: the gate needs it before
//                                         any password is known; it reveals
//                                         nothing but the name's own status)
// POST /sync/v1/vaults/:name {password}
//        → 201 {token} on first claim, 200 {token} on unlock, 401 if the
//          password is wrong (same empty-body shape as auth failures).
//
// One route does both on purpose: the gate sends whatever password the user
// typed, and the server tries claim-then-unlock in a single hit. The claim
// INSERT is atomic (ON CONFLICT DO NOTHING, lib/store-*.js), so two people
// racing to claim a name cannot both win.
//
// The returned token is the vault-scoped `mpv1.*` bearer (lib/claims.js)
// that /sync/v1/* accepts for that vault only. No token is needed to call
// this route - the password IS the credential - but SYNC_TOKEN must be
// configured because it keys the token HMAC (503 otherwise, fail-closed).
//
// POSTs are rate-limited per client IP (best effort, per function instance:
// Vercel has no shared memory across instances) so a name cannot be
// brute-forced at scale; the scrypt verifier keeps online guessing expensive
// even between resets.

import { toNodeHandler } from '../../../../lib/adapter.js';
import { checkToken } from '../../../../lib/auth.js';
import { assertVaultName, hashPassword, issueVaultToken, verifyPassword } from '../../../../lib/claims.js';
import { clientIp } from '../../../../lib/client-ip.js';
import { getSyncToken } from '../../../../lib/config.js';
import { SyncError, json, withErrors } from '../../../../lib/http.js';
import { getStore } from '../../../../lib/store.js';

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 10;
const hits = new Map(); // ip -> { count, resetAt }

// Best-effort, per function instance: no shared state exists across
// instances, so this dampens one client's guessing rate but is not a quota.
// The key itself must be unspoofable, though — see lib/client-ip.js (taking
// the left-most `x-forwarded-for` entry would let an attacker mint a fresh
// bucket per request and bypass the limit entirely).
function rateLimit(request) {
  const now = Date.now();
  if (hits.size > 1000) {
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }
  const ip = clientIp(request) || 'unknown';
  let entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    hits.set(ip, entry);
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) {
    throw new SyncError(429, 'too many attempts — try again in a minute');
  }
}

export function __resetVaultRateLimitForTest() {
  hits.clear();
}

export const web = withErrors(async (request) => {
  const url = new URL(request.url);
  const raw = url.pathname.split('/').filter(Boolean).pop() || '';
  let name;
  try {
    name = decodeURIComponent(raw);
  } catch (_) {
    name = raw;
  }
  assertVaultName(name);

  const key = getSyncToken();
  if (!key) {
    throw new SyncError(503, 'sync not configured: set SYNC_TOKEN');
  }

  const store = await getStore();

  if (request.method === 'GET') {
    const claim = await store.getClaim(name);
    return json({ name, claimed: !!claim }, 200, { 'cache-control': 'no-store' });
  }

  if (request.method === 'POST') {
    rateLimit(request);

    let body;
    try {
      body = await request.json();
    } catch (_) {
      throw new SyncError(400, 'body must be a JSON object');
    }
    const password = body && body.password;
    if (typeof password !== 'string' || password.length < 8) {
      throw new SyncError(400, 'password must be a string of at least 8 characters');
    }
    if (password.length > 1024) {
      throw new SyncError(400, 'password is too long');
    }

    const claim = await store.getClaim(name);
    if (!claim) {
      // ── first-claim gate ────────────────────────────────────────────────
      // A claim IS the credential: whoever claims a name first gets a token
      // for that vault. That is fine for an EMPTY vault (you are naming the
      // vault you are about to fill), but it would hand any stranger full
      // read/write access to a vault that already holds someone's notes —
      // e.g. a vault the operator filled with SYNC_TOKEN and never claimed.
      // Names are visible in /vault/<name> URLs and GET /vaults/<name> says
      // whether they are claimed, so that is not a secret to rely on.
      // Rule: content already present → only the operator (SYNC_TOKEN) may
      // attach a password. Everyone else must have the real password.
      if (await store.vaultHasContent(name)) {
        const header = request.headers.get('authorization') || '';
        const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!checkToken(bearer, key)) {
          throw new SyncError(
            409,
            'this vault already has synced content — enter its password, or claim it with the ' +
              'operator token (Authorization: Bearer <SYNC_TOKEN>)'
          );
        }
      }
      const { salt, hash } = hashPassword(password);
      const created = await store.putClaim(name, salt, hash);
      if (created) {
        return json({ name, claimed: true, token: issueVaultToken(name, key) }, 201);
      }
      // Lost the claim race: someone else claimed this name between our read
      // and write. Verify against their verifier instead - if it matches,
      // this requester provably knows the winning password too.
      const winner = await store.getClaim(name);
      if (!winner || !verifyPassword(password, winner.salt, winner.hash)) {
        return new Response(null, { status: 401 });
      }
      return json({ name, claimed: true, token: issueVaultToken(name, key) }, 200);
    }

    if (!verifyPassword(password, claim.salt, claim.hash)) {
      return new Response(null, { status: 401 });
    }
    return json({ name, claimed: true, token: issueVaultToken(name, key) }, 200);
  }

  throw new SyncError(405, 'method not allowed');
});

export default toNodeHandler(web);
