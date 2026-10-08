import { ghFetch, setGitHubToken } from './github.js';
import { handleShare } from './share.js';
import { handleBoard } from './board.js';
import { handleTapline } from './tapline.js';
// v2.end-gfw.com — Cloudflare Worker
// Static pages come from ./public (Workers Static Assets). This file serves the
// dynamic parts:
//   /api/plans, /api/user, /api/renew, /api/checkout  -> xrayr-next (subscription system)
//   /pay/success, /pay/cancel                          -> xrayr-next pages after Stripe
//   /api/apps, /api/news, /api/tweets                  -> public JSON on GitHub
//   /api/free                                          -> the website account's nodes (WEB_TOKEN)
//   /api/chat-mirrors                                  -> 加密聊天 relay addresses (xrayr-next)
//   /api/official-hosts                                -> addresses 加密分享 / 加密聊天 may run on
//   /chat, /chat/*, /chat/ws                           -> 加密聊天 on Debian-1-2 (CHAT_URL, Cloudflare Tunnel)
//   /tapline, /tapline/*                               -> 随开专线 (tapline Worker, service binding TAPLINE)
//   /download-app/*, /download-pdf/*, /news-resource/* -> GitHub files, cached at the edge
//
// xrayr-next is reached through its public subscription domains (XN_BASES), the
// same way subscription clients reach it, so this Worker holds no secrets.

const GITHUB_RAW = 'https://raw.githubusercontent.com/hello-world-1989';
const NEWS_SOURCES = ['bbc', 'dw', 'rfa', 'rfi', 'voa'];

// Where 加密分享 and 加密聊天 may run. Third-party mirrors can change page scripts (and steal
// the keys in the links), so the pages refuse to run anywhere else; this site's own node IPs
// are added from xrayr-next (/api/official-hosts).
const OFFICIAL_HOSTS = [
  'end-gfw.com',
  'www.end-gfw.com',
  'v2.end-gfw.com',
  'share-preview.end-gfw.com',
  'board-preview.end-gfw.com',
];

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export default {
  async fetch(request, env, ctx) {
    setGitHubToken(env.GH_TOKEN);
    const url = new URL(request.url);
    try {
      // 加密聊天 WebSocket: handed back untouched (a 101 response cannot be rebuilt)
      if (url.pathname === '/chat/ws' && env.CHAT_URL) return await chatSocket(request, env);
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
  // 一键清除 (public/assets/panic.js): answered here, also for /chat/wipe, so it works even
  // when the chat service is down
  if (p === '/wipe' || p === '/chat/wipe') return wipeResponse();
  // 加密聊天 (Debian-1-2 through the Cloudflare Tunnel end-gfw-chat)
  if (p === '/chat' || p.startsWith('/chat/')) return chatProxy(request, url, env);
  // 随开专线 (src/tapline.js): the tapline Worker through the TAPLINE service binding
  const tapline = await handleTapline(request, url, env);
  if (tapline) return tapline;
  // 加密分享 (src/share.js); 'disabled' where the Worker has no SHARE bucket
  const share = await handleShare(request, url, env, { mirrorIps: () => mirrorIps(env) });
  if (share === 'disabled') return notFound(request, env, url);
  if (share) return share;
  // 事件墙 (src/board.js); off unless BOARD_URL and the BOARD_KEY secret are set
  const board = await handleBoard(request, url, env);
  if (board) return board;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // CORS preflight and the like for the old site's APIs
    if (!p.startsWith('/api/') && !p.startsWith('/pay/')) return oldSite(request, env, url);
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
  // Google site verification (same files as the old site; answered here because
  // the asset server redirects *.html to clean URLs)
  const verify = { '/google3265592cabe77d27.html': 'google3265592cabe77d27.html', '/googlebe5a4faac22676fb.html': 'googlebe5a4faac22676fb.html' }[p];
  if (verify) {
    return new Response(`google-site-verification: ${verify}`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // --- check-in (签到). ID: new-system tokens first, unknown ones go to the previous
  // system (same order as the old site). Email: keeps the address on the mail list
  // that the auto-reply answers. Both extend to at most 4 days from today.
  if (p === '/api/checkin/id') {
    const token = extractToken(url.searchParams.get('token'));
    if (!token) return json({ error: '请填写订阅链接或 token' }, 400, 'no-store');
    const res = await xn(env, `/plan/renew?${qs({ token })}`);
    if (res.ok) {
      const user = await res.json().catch(() => ({}));
      return json({ renewed: true, system: 'v2', expiresAt: user.expiresAt ?? null }, 200, 'no-store');
    }
    if (res.status !== 404) return json({ error: '签到失败，请稍后再试' }, 502, 'no-store');
    const old = await legacy(env, `/renew-plan?${qs({ token })}`);
    if (old?.renewed) return json({ renewed: true, system: 'v1', expiresAt: null }, 200, 'no-store');
    return json({ error: '没有找到这个订阅，请检查 token 是否完整' }, 404, 'no-store');
  }
  if (p === '/api/checkin/email') {
    const email = (url.searchParams.get('email') || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return json({ error: '邮箱格式不正确' }, 400, 'no-store');
    const data = await legacy(env, `/renew-email?${qs({ email })}`);
    if (data?.renewed) return json({ renewed: true, expiresAt: data.expiryDate ?? null }, 200, 'no-store');
    if (data?.error === 'Email not found') {
      return json({ error: '这个邮箱还没有领取过节点。请先发邮件领取节点（见常见问题“怎么通过邮件领取节点”），之后再来签到' }, 404, 'no-store');
    }
    return json({ error: '签到失败，请稍后再试' }, 502, 'no-store');
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
  // The old tweet page's links open the new tweets page for the same day
  if (p === '/tweet-page') {
    const q = url.searchParams;
    const id = q.get('id');
    const [y, m, d] = [q.get('year'), q.get('month'), q.get('day')];
    // Only a single day maps onto the new page; month views (events page) stay on the old one
    if ((!id || id === 'whyyoutouzhele') && !q.get('endDay') && /^\d{4}$/.test(y || '') && /^\d{1,2}$/.test(m || '') && /^\d{1,2}$/.test(d || '')) {
      return Response.redirect(`${url.origin}/tweets?date=${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, 302);
    }
  }

  // The old events pages (events.html, events2022.html, ...) open the new one
  const ev = p.match(/^\/events(\d{4})?\.html$/);
  if (ev) return Response.redirect(`${url.origin}/events${ev[1] ? `?year=${ev[1]}` : ''}`, 301);
  // Monthly keywords for the events timeline (old site's /event, via the legacy Lambda)
  if (p === '/api/events') {
    const year = url.searchParams.get('year') || '';
    if (!/^20\d{2}$/.test(year)) return json({ error: 'year=YYYY' }, 400, 'no-store');
    return cached(request, ctx, 3600, async () => {
      const data = await legacy(env, `/event?year=${year}`);
      return Array.isArray(data) ? json(data, 200, 'public, max-age=3600') : json([], 502, 'no-store');
    });
  }

  // "分站首页": one of the mirrors (https://<ip>/ on the website account's servers), at random
  if (p === '/mirror') {
    const token = encodeURIComponent(String(env.WEB_TOKEN || ''));
    const res = token ? await xn(env, `/sub?token=${token}`).catch(() => null) : null;
    const mirrors = res && res.ok ? pickFree(parseFreeNodes(await res.text()), 99).mirrors : [];
    if (!mirrors.length) return Response.redirect(`${url.origin}/#mirrors`, 302);
    return new Response(null, {
      status: 302,
      headers: { Location: mirrors[Math.floor(Math.random() * mirrors.length)], 'Cache-Control': 'no-store' },
    });
  }

  // Addresses 加密分享 and 加密聊天 run on: this site's domains, its mirror node IPs and the chat relays
  if (p === '/api/official-hosts') {
    return cached(request, ctx, 120, async () => {
      const ips = [...((await mirrorIps(env).catch(() => null)) || [])];
      let chat = [];
      try {
        const res = await xn(env, '/chat/mirrors');
        if (res.ok) chat = ((await res.json()).mirrors || []).map((m) => hostOfUrl(m?.url)).filter(Boolean);
      } catch {}
      return json({ hosts: [...new Set([...OFFICIAL_HOSTS, ...ips, ...chat])] }, 200, 'public, max-age=120');
    });
  }

  // 加密聊天 relays (xrayr-next GET /chat/mirrors): https://<node IP>:8443/chat
  if (p === '/api/chat-mirrors') {
    return cached(request, ctx, 120, async () => {
      const res = await xn(env, '/chat/mirrors');
      if (!res.ok) return json({ error: '聊天入口暂时无法加载' }, 502, 'no-store');
      const data = await res.json().catch(() => ({}));
      const mirrors = (Array.isArray(data.mirrors) ? data.mirrors : [])
        .filter((m) => /^https:\/\/\d{1,3}(\.\d{1,3}){3}:8443\/chat$/.test(String(m?.url || '')))
        .map((m) => ({ url: m.url, region: String(m.region || '').slice(0, 20) }));
      return json({ mirrors }, 200, 'public, max-age=120');
    });
  }

  // The website's own shared account (WEB_TOKEN): its nodes
  if (p === '/api/free') {
    return cached(request, ctx, 300, async () => {
      const token = encodeURIComponent(String(env.WEB_TOKEN || ''));
      if (!token) return json({ error: '免费节点暂时无法加载' }, 502, 'no-store');
      const res = await xn(env, `/sub?token=${token}`);
      if (!res.ok) return json({ error: '免费节点暂时无法加载' }, 502, 'no-store');
      // Nodes only: the subscription domains are not shown to visitors
      return json(pickFree(parseFreeNodes(await res.text())), 200, 'public, max-age=300');
    });
  }
  if (p === '/api/apps') {
    return cached(request, ctx, 1800, async () => {
      const res = await ghFetch(`${GITHUB_RAW}/temp/main/public/temp/vpn.json`);
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
          const res = await ghFetch(`${GITHUB_RAW}/json/main/news/${path}/${id}.json`);
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
      const res = await ghFetch(`${GITHUB_RAW}/json/main/tweet/${date.replaceAll('-', '/')}/whyyoutouzhele.json`);
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

  // --- everything the new site does not have: the old site (end-gfw-legacy Worker)
  return oldSite(request, env, url);
}

// Old pages and APIs (why.html, events, /tweet-page, /ss-key, /renew-plan, /node, ...)
// keep working on this domain. Only paths without a new-site page or route get here.
async function oldSite(request, env, url) {
  if (env.LEGACY) {
    const res = await env.LEGACY.fetch(request);
    if (res.status !== 404) {
      // Ads on every page: the old pages only load AdSense on end-gfw.com itself;
      // ads.js skips loading when a page already did
      if ((res.headers.get('content-type') || '').startsWith('text/html')) {
        return new HTMLRewriter()
          .on('head', { element: (el) => el.append('<script src="/assets/ads.js" async></script>', { html: true }) })
          // The old pages' donation links point at the old Stripe page; send them to the sponsor page
          .on('a[href*="buy.stripe.com"]', { element: (el) => el.setAttribute('href', '/plans') })
          .transform(res);
      }
      return res;
    }
  }
  return notFound(request, env, url);
}

async function notFound(request, env, url) {
  const page = await env.ASSETS.fetch(new Request(new URL('/404', url), request));
  return new Response(page.body, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// IPs of the website account's servers, which also serve this site as mirrors
// (https://<ip>/ proxies to end-gfw.com). Cached per isolate for 5 minutes.
let mirrorCache = { at: 0, ips: new Set() };
async function mirrorIps(env) {
  if (Date.now() - mirrorCache.at < 300_000) return mirrorCache.ips;
  const token = encodeURIComponent(String(env.WEB_TOKEN || ''));
  const res = token ? await xn(env, `/sub?token=${token}`).catch(() => null) : null;
  if (!res || !res.ok) return mirrorCache.ips;
  const ips = new Set(pickFree(parseFreeNodes(await res.text()), 99).mirrors.map((m) => new URL(m).hostname));
  mirrorCache = { at: Date.now(), ips };
  return ips;
}

// The free subscription is base64 of one share link per line; keep the
// protocols the home page lists and give each a readable name
const FREE_PROTOCOLS = { 'vless://': 'VLESS', 'ss://': 'Shadowsocks', 'hysteria2://': 'Hysteria2' };
// Two of the account's servers, rotating daily: a VLESS and an SS node from each, and each
// server's IP as a mirror of this site (the nodes serve it on https://<ip>/)
function pickFree(nodes, count = 2) {
  const hostOf = (uri) => (uri.match(/@\[?([\d.]+)\]?:/) || [])[1] || '';
  const hosts = [...new Set(nodes.map((n) => hostOf(n.uri)).filter(Boolean))].sort();
  const day = Math.floor(Date.now() / 86_400_000);
  const chosen = hosts.length <= count ? hosts : Array.from({ length: count }, (_, i) => hosts[(day + i) % hosts.length]);
  const pick = (proto) => chosen.map((h) => nodes.find((n) => hostOf(n.uri) === h && n.protocol === proto)).filter(Boolean);
  const picked = [...pick('VLESS'), ...pick('Shadowsocks')];
  return { nodes: picked, mirrors: chosen.map((h) => `https://${h}/`) };
}

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

// Resumable downloads: Range / If-Range go through to the subrequest. Cloudflare's cache slices the
// range out of the cached file (or GitHub answers it), and the 206 + Content-Range come back as-is.
// ETag / Last-Modified are passed on because browsers only resume when they can check the file
// has not changed (If-Range); a changed file comes back as a full 200.
async function fetchFile(request, ctx, target, ttl) {
  const range = request.headers.get('range');
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  // The Cache API only holds full small files; range requests skip it
  if (!range) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const fwd = new Headers();
  if (range) fwd.set('Range', range);
  const ifRange = request.headers.get('if-range');
  if (range && ifRange) fwd.set('If-Range', ifRange);
  const upstream = await ghFetch(target, { headers: fwd, redirect: 'follow', cf: { cacheTtl: ttl, cacheEverything: true } });
  if (upstream.status === 416) {
    upstream.body?.cancel();
    const headers = { 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const cr = upstream.headers.get('content-range');
    if (cr) headers['Content-Range'] = cr;
    return new Response(null, { status: 416, headers });
  }
  if (!upstream.ok) {
    upstream.body?.cancel();
    return new Response('文件暂时无法下载，请稍后再试', {
      status: upstream.status === 404 ? 404 : 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const partial = upstream.status === 206;
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  const len = upstream.headers.get('content-length');
  if (len) headers.set('Content-Length', len);
  for (const h of ['content-range', 'etag', 'last-modified']) {
    const v = upstream.headers.get(h);
    if (v && (h !== 'content-range' || partial)) headers.set(h, v);
  }
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', `public, max-age=3600, s-maxage=${ttl}`);
  const res = new Response(upstream.body, { status: partial ? 206 : 200, headers });
  // Only small full files go through the Cache API. clone() tees the body: with a slow client the
  // cache side runs ahead and the gap is buffered in the Worker's 128 MB memory, which large
  // downloads would blow. Large files are still edge-cached by the fetch() above (cacheEverything).
  if (!range && !partial && len && Number(len) <= 20 * 1024 * 1024) {
    ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  }
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

const hostOfUrl = (u) => {
  try {
    return new URL(String(u)).hostname;
  } catch {
    return '';
  }
};

// 一键清除: Clear-Site-Data makes the browser drop this address's HTTP cache, cookies and
// storage; the page carries nothing that names the site and moves on to a neutral one.
export const WIPE_TARGET = 'https://www.bing.com/';
export function wipeResponse() {
  const html = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${WIPE_TARGET}"><title></title><a href="${WIPE_TARGET}">&#8203;</a>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Clear-Site-Data': '"cache", "cookies", "storage"',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

// Request headers for the chat service: nothing that identifies the visitor
function chatHeaders(request) {
  const h = new Headers(request.headers);
  for (const k of ['cookie', 'x-forwarded-for', 'x-real-ip', 'x-xn-host', 'cf-connecting-ip', 'true-client-ip']) h.delete(k);
  return h;
}

// 加密聊天 page, assets and API. The page's CSP names the WebSocket host; the service sees its
// tunnel hostname, so that is swapped for the address the browser used (this domain, or the
// IP or domain a mirror reports in X-Xn-Host: its own nodes and mirror.sh mirrors send it).
async function chatProxy(request, url, env) {
  if (!env.CHAT_URL) return notFound(request, env, url);
  const target = new URL(url.pathname + url.search, env.CHAT_URL);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await fetch(target, {
    method: request.method,
    headers: chatHeaders(request),
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });
  const out = new Response(res.body, res);
  const csp = out.headers.get('content-security-policy');
  if (csp) {
    const xn = request.headers.get('x-xn-host') || '';
    const host = isMirrorHost(xn) ? xn : url.host;
    const inner = new URL(env.CHAT_URL).host;
    out.headers.set('content-security-policy', csp.replaceAll(`wss://${inner}`, `wss://${host}`).replaceAll(`ws://${inner}`, `ws://${host}`));
  }
  if (!out.headers.has('cache-control')) out.headers.set('cache-control', 'no-store');
  return out;
}

// An IPv4 address or a plain domain name, nothing that could add to the CSP
export const isMirrorHost = (h) =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(h));

async function chatSocket(request, env) {
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('expected a WebSocket', { status: 426 });
  }
  return fetch(new URL('/chat/ws', env.CHAT_URL), { method: 'GET', headers: chatHeaders(request) });
}

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  // Defaults only: a response that sets its own (the chat page's no-referrer) keeps it
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

function json(data, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  });
}

// The old site's routes that need secrets or MongoDB (Lambda end-gfw-legacy-api)
async function legacy(env, pathAndQuery) {
  try {
    const res = await fetch(`${String(env.LEGACY_API || '').replace(/\/+$/, '')}${pathAndQuery}`, { signal: AbortSignal.timeout(15000) });
    return await res.json();
  } catch {
    return null;
  }
}

// A bare token, or any subscription link that carries ?token=
function extractToken(input) {
  const v = String(input || '').trim();
  if (isToken(v)) return v;
  const m = v.match(/[?&]token=([A-Za-z0-9-]{8,64})/);
  return m ? m[1] : '';
}

const isToken = (t) => /^[A-Za-z0-9-]{8,64}$/.test(t);

const qs = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

export { parseFreeNodes, isSafeSubPath, isToken, extractToken, fetchFile };
