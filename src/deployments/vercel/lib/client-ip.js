// Client IP extraction for the in-memory rate limiters (claim/unlock in
// api/sync/v1/vaults/[name].js and the outbound proxy in
// api/proxy-request.js).
//
// Why this is its own module: both limiters key a Map by "the caller", so a
// caller who controls that key controls the limit. `x-forwarded-for` is a
// comma-separated chain that any client may write to; the LEFT-MOST entry is
// whatever the client sent, and a proxy appends the address it actually saw
// to the RIGHT. Reading `split(',')[0]` therefore hands the attacker the key:
// send `X-Forwarded-For: <random>` on every request and every request looks
// like a new caller.
//
// On Vercel the platform sets `x-vercel-forwarded-for` (it overwrites
// client-supplied values), so that is preferred. `x-real-ip` is the next
// most trustworthy single-value header. Only then do we fall back to the
// forwarded chain — and there we take the LAST hop, the one appended by the
// nearest proxy, because that is the only element a client cannot choose.
//
// This remains best-effort by design: these limiters live in one function
// instance's memory, so the real ceiling on distributed abuse is the hard
// cost of the operation being guarded (scrypt for passwords), not this Map.

function lastHop(value) {
  const parts = String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function clientIp(request) {
  if (!request || !request.headers) return '';
  const vercel = request.headers.get('x-vercel-forwarded-for');
  if (vercel) return lastHop(vercel) || ''; // single value in practice
  const real = request.headers.get('x-real-ip');
  if (real && real.trim()) return real.trim();
  return lastHop(request.headers.get('x-forwarded-for'));
}
