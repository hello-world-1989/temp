// Proof of work instead of a captcha: no third-party script, nothing about the visitor
// is recorded. The server hands out a signed challenge; the browser finds a nonce so that
// SHA-256(challenge + nonce) starts with `bits` zero bits. Each challenge works once.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000;

export function makeChallenge(secret, purpose, bits, now = Date.now()) {
  const payload = `${purpose}.${bits}.${now + TTL_MS}.${randomBytes(12).toString('base64url')}`;
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

// -> { ok: true, hash, expiresAt } or { ok: false, error }
export function checkPow(secret, purpose, minBits, pow, now = Date.now()) {
  const challenge = typeof pow?.challenge === 'string' ? pow.challenge : '';
  const nonce = typeof pow?.nonce === 'string' ? pow.nonce : '';
  if (!challenge || challenge.length > 200 || !/^[0-9a-z]{1,16}$/i.test(nonce)) return { ok: false, error: 'bad' };
  const i = challenge.lastIndexOf('.');
  const payload = challenge.slice(0, i);
  const sig = Buffer.from(challenge.slice(i + 1), 'base64url');
  const want = createHmac('sha256', secret).update(payload).digest();
  if (i < 0 || sig.length !== want.length || !timingSafeEqual(sig, want)) return { ok: false, error: 'bad' };
  const [p, bitsStr, expStr] = payload.split('.');
  const bits = Number(bitsStr);
  const exp = Number(expStr);
  if (p !== purpose || !(bits >= minBits)) return { ok: false, error: 'bad' };
  if (!(exp > now)) return { ok: false, error: 'expired' };
  const digest = createHash('sha256').update(challenge + nonce).digest();
  if (leadingZeroBits(digest) < bits) return { ok: false, error: 'bad' };
  return { ok: true, hash: createHash('sha256').update(challenge).digest(), expiresAt: new Date(exp) };
}
