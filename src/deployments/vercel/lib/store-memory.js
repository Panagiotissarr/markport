// In-memory store — the reference implementation of the store contract (see
// lib/store.js). Used by `npm run dev` (SYNC_STORE=memory, no Neon needed)
// and by the test suite; on a real deployment it would lose every byte on
// the next cold start, which is why SYNC_STORE must never be set there.

import { createHash } from 'node:crypto';
import { StoreError } from './errors.js';
import { planCommit } from './commit-rules.js';

export function createMemoryStore(limits = {}) {
  const maxBlobBytes = limits.maxBlobBytes ?? 64 * 1024 * 1024;
  const maxPartBytes = limits.maxPartBytes ?? 4 * 1024 * 1024;

  const blobs = new Map(); // hash -> {size, data: Buffer}
  const parts = new Map(); // hash -> Map<index, {total, size, data}>
  const files = new Map(); // vault -> Map<path, {hash, size, deleted}>
  const meta = new Map(); // vault -> rev
  const claims = new Map(); // vault name -> {salt, hash} (lib/claims.js)

  function vaultFiles(vault) {
    let map = files.get(vault);
    if (!map) {
      map = new Map();
      files.set(vault, map);
    }
    return map;
  }

  function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
  }

  return {
    kind: 'memory',

    async getManifest(vault, { after = '', limit = 2000 } = {}) {
      const map = files.get(vault) || new Map();
      const entries = [];
      for (const [path, row] of map) {
        if (row.deleted) continue;
        if (after && path <= after) continue; // JS `<` = UTF-16 order; consistent with the sort below
        entries.push({ path, size: row.size, hash: row.hash });
      }
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const hasMore = entries.length > limit;
      return {
        cursor: String(meta.get(vault) || 0),
        entries: entries.slice(0, limit),
        hasMore,
      };
    },

    async getBlob(hash) {
      return blobs.get(hash) || null;
    },

    async missingBlobs(hashes) {
      return hashes.filter((hash) => !blobs.has(hash));
    },

    async putBlobPart(hash, { index, total, size, data }) {
      if (blobs.has(hash)) return { stored: true }; // already there — idempotent
      if (size > maxBlobBytes) throw new StoreError('ETOOLARGE', `blob exceeds ${maxBlobBytes} bytes`);
      if (data.length > maxPartBytes) throw new StoreError('ETOOLARGE', `chunk exceeds ${maxPartBytes} bytes`);
      // A part can never be bigger than the whole file it claims to be part
      // of. Without this, `size` is only a label: a client declares 1 byte
      // and uploads MAX_CHUNKS × maxPartBytes, which the server stores and
      // then tries to Buffer.concat() — storage exhaustion plus an OOM at
      // assembly time (see the sibling check in store-pg.js).
      if (data.length > size) {
        throw new StoreError('ETOOLARGE', 'chunk is larger than the declared blob size');
      }

      let byIndex = parts.get(hash);
      if (!byIndex) {
        byIndex = new Map();
        parts.set(hash, byIndex);
      }
      const existing = byIndex.get(index);
      if (existing && (existing.total !== total || existing.size !== size)) {
        byIndex.clear(); // same hash re-uploaded with different chunking — start over
      }
      // Cumulative bound: every part already accepted for this hash plus the
      // new one must fit inside the declared size. `size` is capped by
      // maxBlobBytes above, so this also caps what assembly can allocate.
      let held = 0;
      for (const [idx, part] of byIndex) if (idx !== index) held += part.data.length;
      if (held + data.length > size) {
        throw new StoreError('ETOOLARGE', 'chunks exceed the declared blob size');
      }
      byIndex.set(index, { total, size, data });

      if (byIndex.size < total) return { stored: false };

      const ordered = [];
      for (let i = 0; i < total; i++) {
        const part = byIndex.get(i);
        if (!part) return { stored: false }; // gaps — not complete yet
        ordered.push(part);
      }
      const assembled = Buffer.concat(ordered.map((p) => p.data));
      if (assembled.length !== ordered[0].size) {
        parts.delete(hash);
        throw new StoreError('ESIZE', 'assembled blob size does not match declared size');
      }
      if (sha256Hex(assembled) !== hash) {
        parts.delete(hash);
        throw new StoreError('EHASH', 'assembled blob does not match its hash');
      }
      if (!blobs.has(hash)) blobs.set(hash, { size: assembled.length, data: assembled });
      parts.delete(hash);
      return { stored: true };
    },

    async commit(vault, changes, deletions, opts = {}) {
      const map = vaultFiles(vault);
      const touched = new Map();
      for (const op of [...changes, ...deletions]) {
        const row = map.get(op.path);
        if (row) touched.set(op.path, row);
      }

      const { applied, conflicts } = planCommit(touched, changes, deletions);

      // Sizes are the SERVER's fact, not the client's: a manifest entry that
      // claims 64 MiB for a 4-byte file feeds the client's mtime+size cache
      // and can make a device skip re-hashing a file that really changed.
      // `checkBlobs` (used by the HTTP route, which must also fail atomically
      // when a blob disappeared between its pre-check and this commit)
      // refuses unknown hashes outright; without it the declared size is the
      // fallback so store-level callers keep working.
      const sizes = new Map();
      const missing = [];
      for (const op of applied) {
        if (op.kind !== 'change') continue;
        const blob = blobs.get(op.hash);
        if (blob) sizes.set(op.hash, blob.size);
        else missing.push(op.hash);
      }
      if (opts.checkBlobs && missing.length > 0) {
        const err = new StoreError('EMISSING', 'commit references unknown blobs');
        err.hashes = [...new Set(missing)];
        throw err;
      }

      for (const op of applied) {
        if (op.kind === 'change') {
          map.set(op.path, { hash: op.hash, size: sizes.get(op.hash) ?? op.size, deleted: false });
        } else {
          const row = map.get(op.path);
          if (row) row.deleted = true; // absent path → no-op, nothing to tombstone
        }
      }

      let rev = meta.get(vault) || 0;
      if (applied.length > 0) {
        rev += 1;
        meta.set(vault, rev);
      }

      return { rev: String(rev), applied: applied.map((op) => op.path), conflicts };
    },

    // Used by the claim route: a name that already holds content must not
    // become claimable by whoever asks first (see api/sync/v1/vaults/[name].js).
    async vaultHasContent(vault) {
      const map = files.get(vault);
      if (!map) return false;
      for (const row of map.values()) if (!row.deleted) return true;
      return false;
    },

    async getClaim(name) {
      const row = claims.get(name);
      return row ? { salt: row.salt, hash: row.hash } : null;
    },

    async putClaim(name, salt, hash) {
      if (claims.has(name)) return false;
      claims.set(name, { salt, hash });
      return true;
    },

    async gc() {
      // no background sweeps needed - parts are dropped on assembly and
      // blobs are only ever written, never orphaned, in memory mode.
    },

    async close() {},
  };
}
