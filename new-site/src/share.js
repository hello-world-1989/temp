// 加密分享 (encrypted file sharing), only on Workers that have the SHARE R2 binding.
//
// Files are encrypted in the browser (AES-GCM, public/assets/share-crypto.js) before upload;
// the key is in the link's #fragment, which browsers never send to the server, so this
// Worker and R2 only ever hold ciphertext.
//
//   POST /api/share                 upload (body = ciphertext) -> { id, expiresAt }
//   GET  /api/share/:id             { size, password, expiresAt }
//   GET  /api/share/:id/file        the ciphertext
//   POST /api/share/:id/delete      { token } -> deletes the file
//   /share, /s/:id                  the upload and receive pages
//
// A file is deleted when the recipient has decrypted it (the page sends the delete token,
// which is inside the encrypted file, so only someone holding the key can delete it) or
// after 7 days (checked on every read, and swept by the cron trigger).
// Fetching the ciphertext alone does not delete it: link scanners in chat apps would
// otherwise destroy files before the recipient opens them, and a wrong password would too.

export const MAX_FILE = 50 * 1024 * 1024;
// Encryption overhead: magic + flags + IV + header (name, type, delete token) + GCM tag
export const MAX_BODY = MAX_FILE + 64 * 1024;
export const TTL_MS = 7 * 24 * 3600 * 1000;

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

// Pages: strict CSP (no ads or any third-party script where the key is in the URL),
// no referrer, not indexed
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
};

export function isShareId(id) {
  return ID_RE.test(String(id || ''));
}

export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const key = (id) => `share/${id}`;
const expired = (obj, now = Date.now()) => now - obj.uploaded.getTime() > TTL_MS;

// Returns a Response for share paths, or null when the path is not ours
export async function handleShare(request, url, env) {
  const p = url.pathname;
  const isOurs = p === '/share' || p === '/share-get' || p.startsWith('/s/') || p === '/api/share' || p.startsWith('/api/share/');
  if (!isOurs) return null;
  // Not enabled on this deployment (production has no SHARE bucket yet)
  if (!env.SHARE) return 'disabled';

  if (p === '/share') return page(env, url, '/share');
  if (p === '/share-get') return 'disabled';
  if (p.startsWith('/s/')) {
    if (!isShareId(p.slice(3))) return 'disabled';
    return page(env, url, '/share-get');
  }

  if (p === '/api/share') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return upload(request, env);
  }

  const m = p.match(/^\/api\/share\/([A-Za-z0-9_-]{22})(\/file|\/delete)?$/);
  if (!m) return json({ error: '链接不正确' }, 404);
  const [, id, action] = m;

  if (await limited(env.SHARE_READ_LIMIT, request)) return json({ error: '请求太频繁，请稍后再试' }, 429);

  if (action === '/delete') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    const body = await request.json().catch(() => ({}));
    const token = String(body?.token || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return json({ error: '删除凭证不正确' }, 400);
    const obj = await env.SHARE.head(key(id));
    if (!obj) return json({ deleted: true });
    if (obj.customMetadata?.dh !== (await sha256hex(token))) return json({ error: '删除凭证不正确' }, 403);
    await env.SHARE.delete(key(id));
    return json({ deleted: true });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);

  if (!action) {
    const obj = await env.SHARE.head(key(id));
    if (!obj || expired(obj)) {
      if (obj) await env.SHARE.delete(key(id));
      return gone();
    }
    return json({
      size: obj.size,
      password: obj.customMetadata?.pw === '1',
      expiresAt: new Date(obj.uploaded.getTime() + TTL_MS).toISOString(),
    });
  }

  // /file
  const obj = await env.SHARE.get(key(id));
  if (!obj || expired(obj)) {
    if (obj) {
      obj.body.cancel();
      await env.SHARE.delete(key(id));
    }
    return gone();
  }
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

async function upload(request, env) {
  if (await limited(env.SHARE_UPLOAD_LIMIT, request)) return json({ error: '上传太频繁，请一分钟后再试' }, 429);
  const len = Number(request.headers.get('content-length'));
  if (!Number.isFinite(len) || len <= 0) return json({ error: '缺少文件' }, 411);
  if (len > MAX_BODY) return json({ error: `文件太大，最大 ${MAX_FILE / 1024 / 1024} MB` }, 413);
  const dh = String(request.headers.get('x-delete-hash') || '');
  if (!HASH_RE.test(dh)) return json({ error: '请求不完整' }, 400);
  const pw = request.headers.get('x-share-password') === '1' ? '1' : '0';
  if (!request.body) return json({ error: '缺少文件' }, 400);

  const id = newId();
  // FixedLengthStream gives R2 the length and fails the upload if the body is longer
  const body = request.body.pipeThrough(new FixedLengthStream(len));
  const obj = await env.SHARE.put(key(id), body, {
    customMetadata: { dh, pw },
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  return json({ id, size: obj.size, expiresAt: new Date(obj.uploaded.getTime() + TTL_MS).toISOString() }, 201);
}

// Hourly: delete anything older than 7 days (reads also refuse expired files)
export async function sweep(env, now = Date.now()) {
  if (!env.SHARE) return 0;
  let cursor;
  let removed = 0;
  do {
    const list = await env.SHARE.list({ prefix: 'share/', cursor, limit: 1000 });
    const old = list.objects.filter((o) => expired(o, now)).map((o) => o.key);
    if (old.length) {
      await env.SHARE.delete(old);
      removed += old.length;
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  if (removed) console.log('share sweep removed', removed);
  return removed;
}

async function page(env, url, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url)));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) out.headers.set(k, v);
  return out;
}

// Cloudflare rate limiting binding (per IP; the IP is not stored or logged by this code)
async function limited(binding, request) {
  if (!binding) return false;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try {
    const { success } = await binding.limit({ key: ip });
    return !success;
  } catch {
    return false;
  }
}

function gone() {
  return json({ error: '文件不存在：已被下载、已删除或已过期（7 天）' }, 404);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
