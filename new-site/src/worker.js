// v2.end-gfw.com — Cloudflare Worker
// Static pages come from ./public (Workers Static Assets). This file serves the
// dynamic parts:
//   /api/plans, /api/user, /api/renew, /api/checkout  -> xrayr-next (subscription system)
//   /pay/success, /pay/cancel                          -> xrayr-next pages after Stripe
//   /api/apps, /api/news, /api/tweets                  -> public JSON on GitHub
//   /api/free                                          -> free nodes (cn-news/end-gfw-free)
//   /download-app/*, /download-pdf/*, /news-resource/* -> GitHub files, cached at the edge
//
// xrayr-next is reached through its public subscription domains (XN_BASES), the
// same way subscription clients reach it, so this Worker holds no secrets.

const GITHUB_RAW = 'https://raw.githubusercontent.com/hello-world-1989';
const NEWS_SOURCES = ['bbc', 'dw', 'rfa', 'rfi', 'voa'];

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      const res = await route(request, url, env, ctx);
      return withSecurityHeaders(res);
    } catch (err) {
      console.error('request failed', url.pathname, err?.stack || err);
      return withSecurityHeaders(json({ error: '服务暂时不可用，请稍后再试' }, 502, 'no-store'));
    }
  },
};

async function route(request, url, env, ctx) {
  const p = url.pathname;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method not allowed' }, 405, 'no-store');
  }

  // --- subscription system (xrayr-next)
  if (p === '/api/plans') return cached(request, ctx, 300, () => xn(env, '/pay/plans'));
  if (p === '/api/user') {
    const token = url.searchParams.get('token') || '';
    if (!isToken(token)) return json({ error: '订阅 token 格式不正确' }, 400, 'no-store');
    return noStore(await xn(env, `/user?${qs({ token })}`));
  }
  if (p === '/api/renew') {
    const token = url.searchParams.get('token') || '';
    if (!isToken(token)) return json({ error: '订阅 token 格式不正确' }, 400, 'no-store');
    return noStore(await xn(env, `/plan/renew?${qs({ token })}`));
  }
  if (p === '/api/checkout') {
    const plan = url.searchParams.get('plan') || '';
    const email = (url.searchParams.get('email') || '').trim();
    const token = url.searchParams.get('token') || '';
    if (!/^\d{1,2}$/.test(plan)) return json({ error: '请选择套餐' }, 400, 'no-store');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400, 'no-store');
    if (token && !isToken(token)) return json({ error: '订阅 token 格式不正确' }, 400, 'no-store');
    const params = { plan, format: 'json', return: url.origin };
    if (email) params.email = email;
    if (token) params.token = token;
    return noStore(await xn(env, `/pay/checkout?${qs(params)}`));
  }
  if (p === '/pay/success' || p === '/pay/cancel') {
    const res = await xn(env, `${p}${url.search}`);
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('content-type') || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // --- content from GitHub
  if (p === '/api/free') {
    return cached(request, ctx, 300, async () => {
      const res = await fetch(`${GITHUB_RAW}/cn-news/main/end-gfw-free`);
      if (!res.ok) return json({ error: '免费节点暂时无法加载' }, 502, 'no-store');
      return json({ nodes: parseFreeNodes(await res.text()) }, 200, 'public, max-age=300');
    });
  }
  if (p === '/api/apps') {
    return cached(request, ctx, 1800, async () => {
      const res = await fetch(`${GITHUB_RAW}/temp/main/public/temp/vpn.json`);
      if (!res.ok) return json([], 502, 'no-store');
      return json(await res.json(), 200, 'public, max-age=600');
    });
  }
  if (p === '/api/news') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date=YYYY-MM-DD' }, 400, 'no-store');
    const path = date.replaceAll('-', '/');
    return cached(request, ctx, 600, async () => {
      const lists = await Promise.all(
        NEWS_SOURCES.map(async (id) => {
          const res = await fetch(`${GITHUB_RAW}/json/main/news/${path}/${id}.json`);
          return res.ok ? res.json().catch(() => []) : [];
        }),
      );
      const items = lists.flat().filter(Boolean).sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)));
      return json(items, 200, 'public, max-age=300');
    });
  }
  if (p === '/api/tweets') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date=YYYY-MM-DD' }, 400, 'no-store');
    return cached(request, ctx, 600, async () => {
      const res = await fetch(`${GITHUB_RAW}/json/main/tweet/${date.replaceAll('-', '/')}/whyyoutouzhele.json`);
      const items = res.ok ? await res.json().catch(() => []) : [];
      return json(Array.isArray(items) ? items : [], 200, 'public, max-age=300');
    });
  }

  // --- files (release downloads, news images)
  const file = matchFile(p);
  if (file) {
    if (!isSafeSubPath(file.rest)) return new Response('Bad path', { status: 400 });
    return fetchFile(request, ctx, `${file.base}/${file.rest}`, file.ttl);
  }

  // --- everything else is a static page (404.html for unknown paths)
  return env.ASSETS.fetch(request);
}

// The free subscription is base64 of one share link per line; keep the
// protocols the home page lists and give each a readable name
const FREE_PROTOCOLS = { 'vless://': 'VLESS', 'ss://': 'Shadowsocks', 'hysteria2://': 'Hysteria2' };
function parseFreeNodes(b64) {
  let text = '';
  try {
    text = atob(b64.replace(/\s+/g, ''));
  } catch {
    return [];
  }
  const nodes = [];
  for (const line of text.split(/\r?\n/)) {
    const uri = line.trim();
    const prefix = Object.keys(FREE_PROTOCOLS).find((k) => uri.startsWith(k));
    if (!prefix || uri.length > 2048) continue;
    const hash = uri.indexOf('#');
    let name = '';
    try {
      name = hash >= 0 ? decodeURIComponent(uri.slice(hash + 1)) : '';
    } catch {}
    nodes.push({ protocol: FREE_PROTOCOLS[prefix], name: name.slice(0, 80), uri });
  }
  return nodes;
}

const FILES = [
  { prefix: '/download-app/', base: 'https://github.com/hello-world-1989/temp/releases/download', ttl: 21600 },
  { prefix: '/download-pdf/', base: 'https://github.com/hello-world-1989/whyyoutouzhele/releases/download', ttl: 21600 },
  { prefix: '/news-resource/', base: `${GITHUB_RAW}/resource/main`, ttl: 604800 },
];

function matchFile(pathname) {
  for (const f of FILES) {
    if (pathname.startsWith(f.prefix)) {
      return { ...f, rest: decodeURIComponent(pathname.slice(f.prefix.length)) };
    }
  }
  return null;
}

// Reject ".." and "." segments so a path cannot walk out of the intended repo
function isSafeSubPath(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length < 512 &&
    !/[\\\u0000-\u001f]/.test(p) &&
    !p.split('/').some((seg) => seg === '' || seg === '..' || seg === '.')
  );
}

async function fetchFile(request, ctx, target, ttl) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const upstream = await fetch(target, { redirect: 'follow', cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!upstream.ok) {
    return new Response('文件暂时无法下载，请稍后再试', {
      status: upstream.status === 404 ? 404 : 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  headers.set('Cache-Control', `public, max-age=3600, s-maxage=${ttl}`);
  const res = new Response(upstream.body, { status: 200, headers });
  // Cache API ignores responses over its size limit; downloads still stream through
  ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

// --- xrayr-next through its public subscription domains, with failover
async function xn(env, pathAndQuery) {
  const bases = String(env.XN_BASES || '')
    .split(',')
    .map((b) => b.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  let last;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}${pathAndQuery}`, {
        headers: { Accept: 'application/json, text/html' },
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      // 5xx or an edge block: try the next domain
      if (res.status >= 500) {
        last = res;
        continue;
      }
      return res;
    } catch (err) {
      last = err;
    }
  }
  if (last instanceof Response) return last;
  throw last || new Error('XN_BASES is empty');
}

async function cached(request, ctx, ttl, produce) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await produce();
  if (res.ok) {
    const copy = new Response(res.body, res);
    copy.headers.set('Cache-Control', `public, max-age=${Math.min(ttl, 300)}, s-maxage=${ttl}`);
    ctx.waitUntil(cache.put(key, copy.clone()).catch(() => {}));
    return copy;
  }
  return res;
}

function noStore(res) {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  // Only pass on what the page needs from the upstream response
  for (const h of [...out.headers.keys()]) {
    if (!['content-type', 'cache-control', 'content-length'].includes(h)) out.headers.delete(h);
  }
  return out;
}

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

function json(data, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  });
}

const isToken = (t) => /^[A-Za-z0-9-]{8,64}$/.test(t);

const qs = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

export { parseFreeNodes, isSafeSubPath, isToken };
