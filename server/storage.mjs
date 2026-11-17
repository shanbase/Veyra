import { AwsClient } from 'aws4fetch';

// File-storage provider switch.
//
// USE_SUPABASESTORAGE: anything other than 'false' keeps Supabase Storage
// (the default, including when the variable is unset). Setting it to 'false'
// routes uploads/reads through Altare U3 (S3-compatible) buckets whose
// credentials are injected per bucket by `altr u3 attach` as
// <PREFIX>_ENDPOINT / _REGION / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY.
//
// Supabase is still required for Realtime and presence either way — this only
// governs object storage.
export function supabaseStorageEnabled() {
  return String(process.env.USE_SUPABASESTORAGE ?? 'true').trim().toLowerCase() !== 'false';
}

export function u3StorageEnabled() {
  return !supabaseStorageEnabled();
}

// Logical bucket name (what the API and clients use) -> env prefix injected
// by `altr u3 attach <bucket> Veyra --prefix <PREFIX>`.
const U3_PREFIX = {
  avatars: 'AVATARS',
  banners: 'BANNERS',
  'chat-images': 'CHAT_IMAGES',
  'chat-videos': 'CHAT_VIDEOS',
  'chat-voice': 'CHAT_VOICE',
};

// U3 bucket name -> logical name, used to map stored object URLs back to the
// bucket names clients send to /api/storage/chat-read.
export const U3_BUCKET_ALIASES = {
  'veyra-avatars': 'avatars',
  'veyra-banners': 'banners',
  'veyra-chat-images': 'chat-images',
  'veyra-chat-videos': 'chat-videos',
  'veyra-chat-voice': 'chat-voice',
};

export function u3Config(bucket) {
  const prefix = U3_PREFIX[bucket];
  if (!prefix) return null;
  const read = (key) => String(process.env[`${prefix}_${key}`] || '').trim();
  const endpoint = read('ENDPOINT').replace(/\/+$/, '');
  const name = read('BUCKET');
  const accessKeyId = read('ACCESS_KEY_ID');
  const secretAccessKey = read('SECRET_ACCESS_KEY');
  if (!endpoint || !name || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    region: read('REGION') || 'asia',
    bucket: name,
    accessKeyId,
    secretAccessKey,
  };
}

function u3Client(cfg) {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: 's3',
  });
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// Canonical public address for an object. For public buckets (avatars,
// banners) this URL serves the file directly; for private chat buckets it is
// only a stable identifier — /api/storage/chat-read swaps in a presigned GET.
export function u3ObjectUrl(bucket, path) {
  const cfg = u3Config(bucket);
  if (!cfg) return null;
  return `https://${cfg.bucket}.u3.altare.global/${encodePath(path)}`;
}

// Presigned S3 PUT for direct browser uploads.
export async function u3PresignUpload(bucket, path, expiresSeconds = 900) {
  const cfg = u3Config(bucket);
  if (!cfg) return null;
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${encodePath(path)}`);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const signed = await u3Client(cfg).sign(url, {
    method: 'PUT',
    aws: { signQuery: true },
  });
  return signed.url;
}

// Presigned S3 GET for authorized viewers (chat-read membership checks run
// before this is called).
export async function u3PresignDownload(bucket, path, expiresSeconds = 3600) {
  const cfg = u3Config(bucket);
  if (!cfg) return null;
  const url = new URL(`${cfg.endpoint}/${cfg.bucket}/${encodePath(path)}`);
  url.searchParams.set('X-Amz-Expires', String(expiresSeconds));
  const signed = await u3Client(cfg).sign(url, {
    method: 'GET',
    aws: { signQuery: true },
  });
  return signed.url;
}
