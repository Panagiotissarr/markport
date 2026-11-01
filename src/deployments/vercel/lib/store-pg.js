// Postgres (Neon) implementation of the store contract — see lib/store.js.
//
// Driver: node-postgres over TLS, using the *pooled* Neon connection string
// (`-pooler` host). Serverless functions are short-lived and each one opens
// its own pool (cached on the module for warm invocations), so the pool is
// deliberately tiny. `ssl: { sslmode: 'require' }` is Neon's documented
// node-postgres setting — it is what makes pg send SNI, which Neon needs to
// route the connection (see neon.com/docs/connect/connection-errors).
//
// Round-trips are batched on purpose: a commit does at most 5 queries
// regardless of how many files it touches (a per-file query would die on
// Neon's latency the moment a vault has more than a handful of changes).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoreError } from './errors.js';
import { planCommit } from './commit-rules.js';

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sslConfig() {
  const noVerify =
    process.env.SYNC_PG_SSL_NO_VERIFY === '1' || process.env.SYNC_PG_SSL_NO_VERIFY === 'true';
  // Escape hatch for TLS-intercepting proxies / broken CA stores. The Neon
  // endpoint itself verifies fine with Node's default trust store.
  return { sslmode: 'require', ...(noVerify ? { rejectUnauthorized: false } : {}) };
}

async function ensureSchema(pool) {
  const ddl = await readFile(SCHEMA_PATH, 'utf8');
  try {
    await pool.query(ddl);
  } catch (err) {
    // Two cold starts can race the DDL; IF NOT EXISTS covers every statement,
    // so the only realistic failure is losing that race on one of them.
    if (!/already exists|duplicate key/i.test(err.message || '')) throw err;
  }
}

export async function createPgStore(databaseUrl, limits = {}) {
  if (!databaseUrl) {
    throw new StoreError('ENOSTORE', 'DATABASE_URL is not set');
  }
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: sslConfig(),
    max: limits.maxConnections ?? 3,
    allowExitOnIdle: true,
  });
  pool.on('error', (err) => console.error('[vercel:pg] idle client error -', err.message));

  await ensureSchema(pool);

  const maxBlobBytes = limits.maxBlobBytes ?? 64 * 1024 * 1024;
  const maxPartBytes = limits.maxPartBytes ?? 4 * 1024 * 1024;
  const gcEveryMs = limits.gcEveryMs ?? 60 * 60 * 1000;
  let lastGcAt = 0;

  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      try {
        await client.query('rollback');
      } catch (_) {
        /* connection already broken */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function gc() {
    const now = Date.now();
    if (now - lastGcAt < gcEveryMs) return;
    lastGcAt = now;
    try {
      // Parts that never got assembled (client vanished mid-upload).
      await pool.query(`delete from blob_parts where created_at < now() - interval '24 hours'`);
      // Blobs no file references any more (edits, deletions, conflict
      // copies), with a 1-hour grace period so an upload that hasn't been
      // committed yet can't be swept out from under its own commit.
      await pool.query(`
        delete from blobs b
        where b.created_at < now() - interval '1 hour'
          and not exists (select 1 from files f where f.hash = b.hash and not f.deleted)
          and not exists (select 1 from blob_parts p where p.hash = b.hash)`);
    } catch (err) {
      console.error('[vercel:pg] gc failed -', err.message); // best effort, never breaks a commit
    }
  }

  return {
    kind: 'postgres',

    async getManifest(vault, { after = '', limit = 2000 } = {}) {
      // Entries FIRST, cursor second: reading them the other way round could
      // hand back a cursor newer than the entries below it, and a client
      // that cached that cursor would then 304 its way past a change.
      const entriesRes = await pool.query(
        `select path, size, hash from files
           where vault_id = $1 and not deleted and path > $2
           order by path
           limit $3`,
        [vault, after, limit + 1]
      );
      const hasMore = entriesRes.rows.length > limit;
      const entries = entriesRes.rows.slice(0, limit).map((row) => ({
        path: row.path,
        size: Number(row.size),
        hash: row.hash,
      }));
      const metaRes = await pool.query(`select rev from vault_meta where vault_id = $1`, [vault]);
      const cursor = metaRes.rows[0] ? String(metaRes.rows[0].rev) : '0';
      return { cursor, entries, hasMore };
    },

    async getBlob(hash) {
      const res = await pool.query(`select size, data from blobs where hash = $1`, [hash]);
      if (!res.rows[0]) return null;
      return { size: Number(res.rows[0].size), data: res.rows[0].data };
    },

    async missingBlobs(hashes) {
      if (hashes.length === 0) return [];
      const res = await pool.query(`select hash from blobs where hash = any($1::text[])`, [hashes]);
      const present = new Set(res.rows.map((row) => row.hash));
      return hashes.filter((hash) => !present.has(hash));
    },

    async putBlobPart(hash, { index, total, size, data }) {
      if (size > maxBlobBytes) {
        throw new StoreError('ETOOLARGE', `blob exceeds ${maxBlobBytes} bytes`);
      }
      if (data.length > maxPartBytes) {
        throw new StoreError('ETOOLARGE', `chunk exceeds ${maxPartBytes} bytes`);
      }

      const stored = await withTransaction(async (client) => {
        const exists = await client.query(`select 1 from blobs where hash = $1`, [hash]);
        if (exists.rowCount > 0) return true;

        // Abandoned parts are swept before we look at them, so a retry after
        // a long pause starts from a clean slate rather than assembling a
        // half-stale upload.
        await client.query(
          `delete from blob_parts where hash = $1 and created_at < now() - interval '24 hours'`,
          [hash]
        );
        const first = await client.query(
          `select total, size from blob_parts where hash = $1 limit 1`,
          [hash]
        );
        if (first.rowCount > 0 &&
            (Number(first.rows[0].total) !== total || Number(first.rows[0].size) !== size)) {
          await client.query(`delete from blob_parts where hash = $1`, [hash]);
        }

        // ── upload-shape guards ────────────────────────────────────────────
        // `size` alone is only a label the client chooses. Without these two
        // checks a client could declare 64 MiB and then POST MAX_CHUNKS
        // (4096) × 3 MiB parts — the parts are stored, and assembly then
        // Buffer.concat()s ~12 GiB inside the function (OOM) while the
        // database holds the bytes until the 24h sweep. Together they make
        // "bytes held for one hash" ≤ the declared size ≤ SYNC_MAX_BLOB_BYTES.
        if (data.length > size) {
          throw new StoreError('ETOOLARGE', 'chunk is larger than the declared blob size');
        }
        const held = await client.query(
          `select coalesce(sum(octet_length(data)), 0)::bigint as n
             from blob_parts where hash = $1 and idx <> $2`,
          [hash, index]
        );
        if (Number(held.rows[0].n) + data.length > size) {
          throw new StoreError('ETOOLARGE', 'chunks exceed the declared blob size');
        }

        await client.query(
          `insert into blob_parts (hash, idx, total, size, data)
           values ($1, $2, $3, $4, $5)
           on conflict (hash, idx) do update
             set data = excluded.data, total = excluded.total,
                 size = excluded.size, created_at = now()`,
          [hash, index, total, size, data]
        );
        const count = await client.query(
          `select count(*)::int as n from blob_parts where hash = $1`,
          [hash]
        );
        if (count.rows[0].n < total) return false;

        const ordered = await client.query(
          `select data from blob_parts where hash = $1 order by idx`,
          [hash]
        );
        if (ordered.rows.length !== total) return false; // concurrent cleanup — caller retries

        const assembled = Buffer.concat(ordered.rows.map((row) => row.data));
        if (assembled.length !== size || sha256Hex(assembled) !== hash) {
          // Leave the transaction BEFORE discarding the parts: a rollback
          // would undo the delete and leave the bad upload to fail forever.
          const err = assembled.length !== size
            ? new StoreError('ESIZE', 'assembled blob size does not match declared size')
            : new StoreError('EHASH', 'assembled blob does not match its hash');
          err.discardParts = true;
          throw err;
        }

        await client.query(
          `insert into blobs (hash, size, data) values ($1, $2, $3)
           on conflict (hash) do nothing`,
          [hash, assembled.length, assembled]
        );
        await client.query(`delete from blob_parts where hash = $1`, [hash]);
        return true;
      }).catch(async (err) => {
        if (err && err.discardParts) {
          await pool.query(`delete from blob_parts where hash = $1`, [hash]).catch(() => {});
        }
        throw err;
      });

      return { stored: stored === true };
    },

    async commit(vault, changes, deletions, opts = {}) {
      const result = await withTransaction(async (client) => {
        await client.query(
          `insert into vault_meta (vault_id) values ($1) on conflict do nothing`,
          [vault]
        );

        const paths = [...changes, ...deletions].map((op) => op.path);
        const current = new Map();
        if (paths.length > 0) {
          // FOR UPDATE: a concurrent commit touching the same paths blocks
          // here until it finishes, so the CAS below can't read a snapshot
          // that is already stale by the time we apply.
          const res = await client.query(
            `select path, hash, size, deleted from files
               where vault_id = $1 and path = any($2::text[])
               for update`,
            [vault, paths]
          );
          for (const row of res.rows) {
            current.set(row.path, {
              hash: row.hash,
              size: Number(row.size),
              deleted: row.deleted,
            });
          }
        }

        const { applied, conflicts } = planCommit(current, changes, deletions);
        const changeOps = applied.filter((op) => op.kind === 'change');
        const deletionOps = applied.filter((op) => op.kind === 'deletion');

        // Sizes are the SERVER's fact, not the client's. `changes[].size` is
        // attacker-chosen (only bounded by SYNC_MAX_BLOB_BYTES); storing it
        // would let a client make the manifest claim 64 MiB for a 4-byte
        // file, which feeds every other device's mtime+size hash cache and
        // can make it skip re-hashing a file that really changed.
        // `checkBlobs` additionally re-verifies, INSIDE this transaction,
        // that the content still exists — the route's pre-check races the
        // blob GC, and losing that race would write a file row pointing at a
        // deleted blob (an unreadable path that no later sync can repair).
        const sizes = new Map();
        if (changeOps.length > 0) {
          const hashes = [...new Set(changeOps.map((op) => op.hash))];
          const res = await client.query(
            `select hash, size from blobs where hash = any($1::text[])`,
            [hashes]
          );
          for (const row of res.rows) sizes.set(row.hash, Number(row.size));
          if (opts.checkBlobs) {
            const missing = hashes.filter((hash) => !sizes.has(hash));
            if (missing.length > 0) {
              const err = new StoreError('EMISSING', 'commit references unknown blobs');
              err.hashes = missing;
              throw err;
            }
          }
        }

        if (changeOps.length > 0) {
          await client.query(
            `insert into files (vault_id, path, hash, size, deleted, updated_at)
             select $1, x.path, x.hash, x.size, false, now()
             from jsonb_to_recordset($2::jsonb) as x(path text, hash text, size bigint)
             on conflict (vault_id, path) do update
               set hash = excluded.hash, size = excluded.size,
                   deleted = false, updated_at = now()`,
            [vault, JSON.stringify(changeOps.map((op) => ({
              path: op.path, hash: op.hash, size: sizes.get(op.hash) ?? op.size,
            })))]
          );
        }

        if (deletionOps.length > 0) {
          await client.query(
            `update files set deleted = true, updated_at = now()
               where vault_id = $1 and path = any($2::text[]) and not deleted`,
            [vault, deletionOps.map((op) => op.path)]
          );
        }

        // Cursor bump last: the row lock taken here serializes concurrent
        // commits in commit order (see lib/schema.sql).
        let rev;
        if (applied.length > 0) {
          const res = await client.query(
            `update vault_meta set rev = rev + 1, updated_at = now()
               where vault_id = $1 returning rev`,
            [vault]
          );
          rev = Number(res.rows[0].rev);
        } else {
          const res = await client.query(`select rev from vault_meta where vault_id = $1`, [vault]);
          rev = res.rows[0] ? Number(res.rows[0].rev) : 0;
        }

        return { rev: String(rev), applied: applied.map((op) => op.path), conflicts };
      });

      // Deletions are what orphan blobs — sweep on those commits only.
      if (deletions.length > 0) await gc();
      return result;
    },

    // Used by the claim route: a name that already holds content must not
    // become claimable by whoever asks first (see api/sync/v1/vaults/[name].js).
    async vaultHasContent(vault) {
      const res = await pool.query(
        `select exists(select 1 from files where vault_id = $1 and not deleted) as present`,
        [vault]
      );
      return !!(res.rows[0] && res.rows[0].present);
    },

    async getClaim(name) {
      const res = await pool.query(
        'select pw_salt, pw_hash from vault_claims where name = $1',
        [name]
      );
      const row = res.rows[0];
      return row ? { salt: row.pw_salt, hash: row.pw_hash } : null;
    },

    // Atomic: ON CONFLICT DO NOTHING reports 0 rows if someone else claimed
    // the name first, so exactly one claimer wins a race.
    async putClaim(name, salt, hash) {
      const res = await pool.query(
        `insert into vault_claims (name, pw_salt, pw_hash)
         values ($1, $2, $3)
         on conflict (name) do nothing`,
        [name, salt, hash]
      );
      return res.rowCount === 1;
    },

    async gc() {
      lastGcAt = 0;
      await gc();
    },

    async close() {
      await pool.end();
    },
  };
}
