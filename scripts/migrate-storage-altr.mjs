// SS:migrate:ALTR — copy every object out of the Supabase Storage buckets
// into the matching Altare U3 buckets, then optionally rewrite stored URLs.
//
//   npm run SS:migrate:ALTR                 # copy files (dry-run with -- --dry-run)
//   npm run SS:migrate:ALTR -- --rewrite-urls   # also update DB URL references
//
// Uploads go through the `altr` CLI (session auth — no S3 keys needed), so
// `altr login` must be done first. The target team defaults to Secondary
// (where Veyra is hosted); override with ALTR_TEAM.
//
// Env: SUPABASE_URL / VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from
// .env.local. USE_MARIADB selects the database dialect for --rewrite-urls.

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';

dotenv.config({ path: ['.env.local', '.env'] });

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
  process.exit(1);
}
const authHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// Minimal Supabase Storage REST client — avoids supabase-js, which requires
// a WebSocket transport that Node 20 doesn't provide.
async function storageList(bucket, prefix, limit, offset) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ prefix, limit, offset, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!response.ok) throw new Error(`List ${bucket}/${prefix}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function storageDownload(bucket, path) {
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/authenticated/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!response.ok) throw new Error(`Download ${bucket}/${path}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const execFileAsync = promisify(execFile);
const DRY_RUN = process.argv.includes('--dry-run');
const REWRITE_URLS = process.argv.includes('--rewrite-urls');
const TEAM = process.env.ALTR_TEAM || 'Secondary';
const CONCURRENCY = 4;

// Supabase bucket -> Altare U3 bucket (created with `altr u3 create`, asia).
const BUCKET_MAP = {
  avatars: 'veyra-avatars',
  banners: 'veyra-banners',
  'chat-images': 'veyra-chat-images',
  'chat-videos': 'veyra-chat-videos',
  'chat-voice': 'veyra-chat-voice',
};

const tempDir = await mkdtemp(join(tmpdir(), 'veyra-u3-migrate-'));

async function altrPut(localPath, bucketKey) {
  await execFileAsync('altr', ['u3', 'put', localPath, bucketKey, '--team', TEAM], { windowsHide: true });
}

// Supabase Storage list() is per-directory — recurse through folder entries.
async function listObjects(bucket, prefix = '') {
  const objects = [];
  let offset = 0;
  for (;;) {
    const data = await storageList(bucket, prefix, 1000, offset);
    if (!data?.length) break;
    for (const entry of data) {
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        objects.push(...await listObjects(bucket, key));
      } else {
        objects.push({ name: key, metadata: entry.metadata || {} });
      }
    }
    if (data.length < 1000) break;
    offset += data.length;
  }
  return objects;
}

async function migrateBucket(sbBucket, u3Bucket) {
  const objects = await listObjects(sbBucket);
  console.log(`[${sbBucket}] ${objects.length} objects -> ${u3Bucket}`);
  let done = 0;
  let failed = 0;
  const queue = [...objects];

  async function worker() {
    while (queue.length) {
      const obj = queue.shift();
      const key = obj.name;
      try {
        if (DRY_RUN) {
          console.log(`  would copy ${sbBucket}/${key} -> ${u3Bucket}/${key}`);
        } else {
          const bytes = await storageDownload(sbBucket, key);
          const ext = key.includes('.') ? key.slice(key.lastIndexOf('.')) : '';
          const tmp = join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
          await writeFile(tmp, bytes);
          try {
            await altrPut(tmp, `${u3Bucket}/${key}`);
          } finally {
            await rm(tmp, { force: true });
          }
        }
        done += 1;
        if (done % 25 === 0 || done === objects.length) console.log(`  ${sbBucket}: ${done}/${objects.length}`);
      } catch (error) {
        failed += 1;
        console.error(`  FAIL ${sbBucket}/${key}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[${sbBucket}] done: ${done} copied, ${failed} failed`);
  return failed;
}

// ---------- optional URL rewrite ----------

function b64urlEncodeString(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeString(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// public-object prefix per Supabase bucket -> U3 public host prefix
const URL_REWRITES = Object.entries(BUCKET_MAP).map(([sb, u3]) => ({
  from: `${SUPABASE_URL}/storage/v1/object/public/${sb}/`,
  to: `https://${u3}.u3.altare.global/`,
}));

function rewriteUrlString(url) {
  for (const { from, to } of URL_REWRITES) {
    if (url.startsWith(from)) return to + url.slice(from.length);
  }
  return url;
}

// Rewrites one serialized media item (plain url, video:/audio: prefixed, or
// base64 file:/music: metadata blobs) from Supabase URLs to U3 URLs.
function rewriteMediaItem(item) {
  if (typeof item !== 'string') return item;
  if (item.startsWith('expired:')) return item;
  if (item.startsWith('video:')) return `video:${rewriteUrlString(item.slice(6))}`;
  if (item.startsWith('audio:')) {
    const rest = item.slice(6);
    const idx = rest.lastIndexOf(':');
    const url = idx > 0 ? rest.slice(0, idx) : rest;
    const tail = idx > 0 ? rest.slice(idx) : '';
    return `audio:${rewriteUrlString(url)}${tail}`;
  }
  if (item.startsWith('file:') || item.startsWith('music:')) {
    const prefixLen = item.indexOf(':') + 1;
    try {
      const meta = JSON.parse(b64urlDecodeString(item.slice(prefixLen)));
      if (meta && typeof meta.url === 'string') {
        meta.url = rewriteUrlString(meta.url);
        return `${item.slice(0, prefixLen)}${b64urlEncodeString(JSON.stringify(meta))}`;
      }
    } catch { /* leave as-is */ }
    return item;
  }
  return rewriteUrlString(item);
}

function rewriteSerializedMedia(serialized) {
  if (!serialized || typeof serialized !== 'string') return serialized;
  try {
    const parsed = JSON.parse(serialized);
    const arr = Array.isArray(parsed) ? parsed : [serialized];
    const next = arr.map(rewriteMediaItem);
    return JSON.stringify(next);
  } catch {
    return serialized;
  }
}

async function rewriteDatabaseUrls() {
  const { pool, dialect } = await import('../server/db.mjs');
  try {
    // Plain URL columns.
    const plainColumns = [
      ['profiles', 'avatar_url'],
      ['profiles', 'banner_url'],
    ];
    for (const [table, column] of plainColumns) {
      const [rows] = await pool.execute(
        `SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE '%/storage/v1/object/%' LIMIT 10000`,
      );
      let updated = 0;
      for (const row of rows) {
        const next = rewriteUrlString(String(row.value || ''));
        if (next !== row.value) {
          await pool.execute(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [next, row.id]);
          updated += 1;
        }
      }
      console.log(`[rewrite] ${table}.${column}: ${updated}/${rows.length} rows updated (${dialect})`);
    }
    // Serialized media JSON columns.
    const mediaColumns = [
      ['messages', 'image_url'],
      ['global_messages', 'image_url'],
      ['announcement_messages', 'image_url'],
    ];
    for (const [table, column] of mediaColumns) {
      const [rows] = await pool.execute(
        `SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE '%/storage/v1/object/%' LIMIT 50000`,
      );
      let updated = 0;
      for (const row of rows) {
        const next = rewriteSerializedMedia(row.value);
        if (next !== row.value) {
          await pool.execute(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [next, row.id]);
          updated += 1;
        }
      }
      console.log(`[rewrite] ${table}.${column}: ${updated}/${rows.length} rows updated (${dialect})`);
    }
  } finally {
    await pool.end();
  }
}

// ---------- main ----------

let totalFailed = 0;
for (const [sbBucket, u3Bucket] of Object.entries(BUCKET_MAP)) {
  totalFailed += await migrateBucket(sbBucket, u3Bucket);
}

if (REWRITE_URLS && !DRY_RUN) {
  console.log('Rewriting stored media URLs in the database…');
  await rewriteDatabaseUrls();
} else if (REWRITE_URLS) {
  console.log('(dry-run) skipping URL rewrite');
}

await rm(tempDir, { recursive: true, force: true });
if (totalFailed) {
  console.error(`Migration finished with ${totalFailed} failed object(s).`);
  process.exitCode = 1;
} else {
  console.log('Migration complete.');
}
