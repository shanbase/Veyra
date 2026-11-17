import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Short-lived bearer tickets let the standalone call server (a different
// origin, e.g. calls.go.altare.global) authenticate callers without the
// httpOnly session cookie, which browsers never send cross-site. The main API
// mints them behind normal session auth; the call server only verifies the
// HMAC — no DB lookup needed for auth itself.
//
// CALL_TICKET_SECRET must be set on BOTH the API server (to sign) and the
// call server (to verify). It is a dedicated secret, independent of
// MESSAGE_ENCRYPTION_KEY, so call tickets can be rotated separately.

const TTL_SECONDS = 60;

function secret() {
  return String(process.env.CALL_TICKET_SECRET || '');
}

export function callTicketsEnabled() {
  return secret().length >= 16;
}

const b64url = (value) => Buffer.from(value).toString('base64url');

function sign(payload) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function signCallTicket(userId) {
  if (!callTicketsEnabled()) throw new Error('CALL_TICKET_SECRET is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: userId, iat: now, exp: now + TTL_SECONDS }));
  return `${payload}.${sign(payload)}`;
}

export function verifyCallTicket(token) {
  if (!callTicketsEnabled() || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims?.sub || typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return String(claims.sub);
  } catch {
    return null;
  }
}

export function newCallTicketSecret() {
  return randomBytes(32).toString('base64url');
}
