// GET /sync/v1/deletions — standalone tombstone list. Not implemented: the
// commit endpoint records deletions inline, and a client learns "this path
// is gone" from the manifest itself (a path it has synced but no longer
// sees), so a separate tombstone feed would carry no extra information.
// Routed stub so a client gets a self-describing 501 instead of a 404
// (same contract as src/sync-server/stubs-v2.js).

import { toNodeHandler } from '../../../lib/adapter.js';
import { requireAuth } from '../../../lib/auth.js';
import { json, withErrors } from '../../../lib/http.js';

// Auth FIRST, exactly like the implemented endpoints: an unauthenticated
// caller has no business enumerating the sync surface, and a stub must never
// become the one route that answers without a token. (No client calls this —
// see the header note — so the 401 changes nothing for real traffic.)
export const web = withErrors(async (request) => {
  const denied = requireAuth(request);
  if (denied) return denied;
  return json({ error: 'not implemented', path: new URL(request.url).pathname }, 501);
});

export default toNodeHandler(web);
