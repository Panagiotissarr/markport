// Store selection: one process-wide instance per function instance, chosen
// by SYNC_STORE (see lib/config.js). `pg` is imported lazily so a
// memory-store dev/test run works without node_modules containing it.

import { getDatabaseUrl, getStoreMode, getMaxBlobBytes } from './config.js';
import { SyncError } from './http.js';
import { createMemoryStore } from './store-memory.js';

// A single upload chunk, binary. Client sends 2 MiB chunks; base64 expands
// them to ~2.7 MB — comfortably under Vercel's 4.5 MB request cap.
export const MAX_PART_BYTES = 3 * 1024 * 1024;

let cached = null;

export async function getStore() {
  if (cached) return cached;

  const mode = getStoreMode();
  const limits = { maxBlobBytes: getMaxBlobBytes(), maxPartBytes: MAX_PART_BYTES };

  if (mode === 'memory') {
    // Fail closed on a real deployment: the memory store keeps every byte in
    // one function instance, so SYNC_STORE=memory on Vercel means "sync
    // silently loses data on the next cold start". That is a configuration
    // mistake, not a mode. Local dev runs outside Vercel (scripts/dev.js), and
    // SYNC_ALLOW_MEMORY_STORE=1 is the deliberate escape hatch (e.g.
    // `vercel dev` with the memory store).
    if (process.env.VERCEL && process.env.SYNC_ALLOW_MEMORY_STORE !== '1') {
      throw new SyncError(
        503,
        'SYNC_STORE=memory is not allowed on a deployment (it loses data on restart) — ' +
        'set DATABASE_URL, or SYNC_ALLOW_MEMORY_STORE=1 to override locally'
      );
    }
    cached = createMemoryStore(limits);
  } else if (mode === 'postgres') {
    if (!getDatabaseUrl()) {
      throw new SyncError(
        503,
        'sync store not configured: set DATABASE_URL (Neon), or SYNC_STORE=memory for local dev'
      );
    }
    const { createPgStore } = await import('./store-pg.js');
    cached = await createPgStore(getDatabaseUrl(), limits);
  } else {
    throw new SyncError(503, `unknown SYNC_STORE: ${JSON.stringify(mode)}`);
  }
  return cached;
}

// Test hooks — tests inject a fresh memory store per case.
export function __setStoreForTest(store) {
  cached = store;
}
export function __resetStoreForTest() {
  cached = null;
}
