// POST /sync/v1/commit — push local changes (and deletions) to the vault.
//
// This is the endpoint that makes sync bidirectional. Every operation
// carries `baseHash` (what this device last synced for that path) and the
// store applies it only if the server's effective hash still matches —
// see lib/commit-rules.js for the full rules and the conflict contract.
//
// Response:
//   { rev, applied: [path...], conflicts: [{path, hash, size, deleted}...] }
//
// `applied` paths must be recorded as synced by the client; `conflicts`
// report the server's current state for that path so the client can keep
// both sides (its own content becomes a `.conflict-` copy — run-sync.js).
//
// 422 {hashes:[...]} = a change referenced content the server doesn't have.
// The client uploads those blobs and retries; it means a blob vanished
// between the client's "is this on the server?" check and the commit (GC).

import { toNodeHandler } from '../../../lib/adapter.js';
import { requireAuth } from '../../../lib/auth.js';
import { getMaxBlobBytes, MAX_COMMIT_OPS } from '../../../lib/config.js';
import { SyncError, getVaultOrThrow, json, withErrors } from '../../../lib/http.js';
import { getStore } from '../../../lib/store.js';
import { parseCommitBody } from '../../../lib/validate.js';

export const web = withErrors(async (request) => {
  if (request.method !== 'POST') throw new SyncError(405, 'method not allowed');
  const denied = requireAuth(request);
  if (denied) return denied;

  const vault = getVaultOrThrow(request);

  let body;
  try {
    body = await request.json();
  } catch (_) {
    throw new SyncError(400, 'body must be a JSON object');
  }
  const { changes, deletions } = parseCommitBody(body, {
    maxOps: MAX_COMMIT_OPS,
    maxBlobBytes: getMaxBlobBytes(),
  });

  const store = await getStore();

  if (changes.length === 0 && deletions.length === 0) {
    // Nothing to apply — hand back the current cursor anyway (a client
    // aligning itself with the server should not need a second round-trip).
    const { cursor } = await store.getManifest(vault, { after: '', limit: 1 });
    return json({ rev: cursor, applied: [], conflicts: [] });
  }

  const hashes = [...new Set(changes.map((change) => change.hash))];
  const missing = await store.missingBlobs(hashes);
  if (missing.length > 0) {
    return json({ error: 'missing blobs', hashes: missing }, 422);
  }

  // checkBlobs: the store re-verifies presence inside the commit transaction
  // and answers EMISSING (→ the same 422 shape above) if the blob GC removed
  // content between the check above and the write. Without it a file row
  // could point at a deleted blob — a path that 404s on every later pull and
  // that no client can repair on its own.
  const result = await store.commit(vault, changes, deletions, { checkBlobs: true });
  return json(result);
});

export default toNodeHandler(web);
