// end-gfw.com (old site) as a Cloudflare Worker, replacing the Express server in
// src/proxy.js. Same URLs and responses:
//   static pages          temp repo main:public/temp, read from GitHub at request time
//   GitHub data routes    news, tweets, events, files, downloads (no secrets needed)
//   /tweet-page... pages  the same Handlebars views, precompiled at build
//   /node, /host          mirror registry in KV (was server memory)
//   secret/MongoDB routes forwarded to the end-gfw-legacy-api Lambda (LEGACY_API)
// The tweet-queue API (/api/add-url etc., sqlite) is not carried over.
import Handlebars from 'handlebars/runtime.js';
import templates from './templates.js';

const RAW = 'https://raw.githubusercontent.com/hello-world-1989';
const SITE = `${RAW}/temp/main/public/temp`;
const NEWS_SOURCES = ['bbc', 'dw', 'rfa', 'rfi', 'voa'];

// Routes answered by the Lambda (need a secret or MongoDB)
const LAMBDA_ROUTES = new Set(['/ss-key', '/ss-key1', '/renew-plan', '/renew-email', '/apple-account', '/ip-check', '/search-tweet', '/event']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization',
};

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  mp4: 'video/mp4', pdf: 'application/pdf', zip: 'application/zip', apk: 'application/vnd.android.package-archive',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', md: 'text/markdown; charset=utf-8',
};
const mimeOf = (p, fallback = 'application/octet-stream') => MIME[(p.split('.').pop() || '').toLowerCase()] || fallback;

// --- Handlebars (helpers as in proxy.js)
const H = Handlebars.create();
H.registerHelper('tweetContent', (content, link, id) => {
  const url = (typeof link === 'string' && link) || `https://x.com/whyyoutouzhele/status/${id}`;
  const safe = H.escapeExpression(url);
  const a = (t) => `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:text-blue-700 underline">${t}</a>`;
  return new H.SafeString(H.escapeExpression(content ?? '').replace(/查看引用原文/g, a('查看引用原文')).replace(/查看原文/g, a('查看原文')));
});
H.registerHelper('foo', () => 'FOO!');
H.registerHelper('mod', (a, b) => a % b);
H.registerHelper('gt', (a, b) => a > b);
H.registerHelper('eq', (a, b) => a === b);
H.registerHelper('lt', (a, b) => a < b);
const T = Object.fromEntries(Object.entries(templates).map(([k, spec]) => [k, H.template(spec)]));
const render = (view, data) =>
  new Response(T.layout({ body: T[view](data) }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });

// --- input checks (as in proxy.js)
function isSafeSubPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length < 512 && !/[\\\u0000-\u001f]/.test(p) && !p.split('/').some((s) => s === '..' || s === '.');
}
const NAME_RE = /^[\w.-]{1,80}$/;
function validTweetQuery({ year, month, day, endDay }, names = []) {
  if (!/^\d{4}$/.test(year ?? '')) return false;
  for (const v of [month, day, endDay]) if (v != null && v !== '' && v !== 'undefined' && !/^\d{1,2}$/.test(v)) return false;
  return names.every((n) => NAME_RE.test(n ?? '') && n !== '.' && n !== '..');
}
const present = (v) => v != null && v !== '' && v !== 'undefined';

const json = (data, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache } });
const notFound = () => json({ success: false, error: 'Endpoint not found', message: 'Not Found' }, 404);
const missing = (names) => json({ success: false, error: `Missing required parameters: ${names}`, message: 'Validation Error' }, 400);

// GitHub raw, cached at the edge
async function raw(url, ttl = 600) {
  return fetch(url, { cf: { cacheTtl: ttl, cacheEverything: true }, signal: AbortSignal.timeout(15000) });
}
async function rawJson(url, fallback = null, ttl = 600) {
  try {
    const res = await raw(url, ttl);
    return res.ok ? await res.json() : fallback;
  } catch {
    return fallback;
  }
}

function processTweetItem(item) {
  const images = item?.images?.split(',') ?? [];
  if (item?.videos) images.push(...item.videos.split(','));
  item.allImages = images.filter(Boolean);
  return item;
}

async function tweetsFor({ year, month, day, endDay, id }) {
  const base = `${RAW}/json/main/tweet/${year}${present(month) ? `/${month}` : ''}${present(day) ? `/${day}` : ''}`;
  const result = [...((await rawJson(`${base}/${id}.json`, [])) ?? [])];
  if (present(month) && present(day) && present(endDay)) {
    for (let i = parseInt(day) + 1; i <= parseInt(endDay); i++) {
      const d = String(i).padStart(2, '0');
      result.push(...((await rawJson(`${RAW}/json/main/tweet/${year}/${month}/${d}/${id}.json`, [])) ?? []));
    }
  }
  return result;
}

async function streamFile(target, contentType, cacheControl) {
  const up = await fetch(target, { redirect: 'follow', cf: { cacheTtl: 21600, cacheEverything: true } });
  if (!up.ok) return new Response('Download failed', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  const headers = { 'Content-Type': contentType, 'Cache-Control': cacheControl };
  const len = up.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  return new Response(up.body, { headers });
}

// TCP reachability check (net.Socket in the old server)
async function isPortReachable(hostname, port, timeout = 5000) {
  try {
    const { connect } = await import('cloudflare:sockets');
    const socket = connect({ hostname, port: Number(port) });
    const ok = await Promise.race([socket.opened.then(() => true), new Promise((r) => setTimeout(() => r(false), timeout))]);
    socket.close().catch(() => {});
    return ok;
  } catch {
    return false;
  }
}

// --- mirror registry: KV keys host:<ip>, the host record kept in the key's metadata
const HOST_TTL = 3 * 3600;
async function listHosts(env) {
  const { keys } = await env.MIRRORS.list({ prefix: 'host:' });
  return keys.map((k) => k.metadata).filter(Boolean).sort((a, b) => (a.updatedTime > b.updatedTime ? -1 : 1));
}
async function saveMirror(env, ip, port, extraExpiry = 0) {
  const key = `host:${ip}`;
  const existing = await env.MIRRORS.getWithMetadata(key);
  const now = Date.now();
  // Nodes report every 10 minutes; only write when the record is getting old (KV write quota)
  if (existing.metadata && now - (existing.metadata.seenAt ?? 0) < 3600 * 1000) return 'updated';
  let confirmedPort = port;
  if (!existing.metadata && !(await isPortReachable(ip, port))) {
    if (await isPortReachable(ip, 80)) confirmedPort = 80;
    else return 'fail';
  }
  const host = { ip, port: Number(existing.metadata?.port ?? confirmedPort), updatedTime: now + extraExpiry, status: existing.metadata?.status ?? 'unknown', seenAt: now };
  await env.MIRRORS.put(key, '1', { metadata: host, expirationTtl: HOST_TTL });
  return 'success';
}

async function lambda(env, url, request) {
  const res = await fetch(`${env.LEGACY_API.replace(/\/+$/, '')}${url.pathname}${url.search}`, {
    headers: { 'x-client-ip': request.headers.get('cf-connecting-ip') || '' },
    signal: AbortSignal.timeout(28000),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function route(request, url, env) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);

  if (LAMBDA_ROUTES.has(p) || p.startsWith('/url-check/')) return lambda(env, url, request);

  switch (p) {
    case '/github': {
      const res = await raw(`${RAW}/cn-news/main/server.txt`, 300).catch(() => null);
      return new Response(res?.ok ? await res.text() : '', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    case '/youtube': case '/wiki': case '/nitter': case '/searchx':
      return json(await rawJson(`${RAW}/accessible/main${p}.json`, ''), 200, 'public, max-age=300');
    case '/obfs4':
      return json(await rawJson(`${RAW}/cn-news/main/obfs4.json`, ''), 200, 'public, max-age=300');
    case '/pdf':
      return json(await rawJson(`${RAW}/whyyoutouzhele/main/pdf.json`, ''), 200, 'public, max-age=300');
    case '/vpn-data':
      return json(await rawJson(`${SITE}/vpn.json`, '', 300));
    case '/ee-data':
      return json(await rawJson(`${RAW}/temp/main/ee.json`, '', 300));
    case '/host':
      return json((await listHosts(env)).slice(0, 2).map(({ seenAt, ...h }) => h));
    case '/report':
      return json({ reported: false });
    case '/check-status':
      return json({ status: await isPortReachable('baidu.com', 80, 3000), timestamp: new Date().toISOString() });
    case '/node': {
      const { ip, port } = q;
      if (!ip || !port) return json({ error: 'Missing required parameters: ip, port' });
      const callerIp = request.headers.get('cf-connecting-ip');
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || !/^\d{1,5}$/.test(String(port)) || (callerIp && callerIp !== ip)) {
        return json({ error: 'Forbidden' }, 403);
      }
      await saveMirror(env, ip, Number(port));
      return json({ ip, port });
    }
    case '/news-data': {
      const { year, month, day } = q;
      if (!year || !month || !day || !validTweetQuery(q)) return json([]);
      const lists = await Promise.all(NEWS_SOURCES.map((id) => rawJson(`${RAW}/json/main/news/${year}/${month}/${day}/${id}.json`, [])));
      return json(lists.flat().filter(Boolean), 200, 'public, max-age=300');
    }
    case '/tweet': {
      if (!q.year || !q.id) return json({ error: 'Missing required parameters: year, id' });
      if (!validTweetQuery(q, [q.id])) return json({ error: 'Invalid parameters' }, 400);
      return json(await tweetsFor(q), 200, 'public, max-age=300');
    }
    case '/tweet-page-7': {
      const result = [];
      for (let i = 0; i < 3; i++) {
        const d = new Date(Date.now() - i * 86400000);
        const [y, m, dd] = [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')];
        result.push(...((await rawJson(`${RAW}/json/main/tweet/${y}/${m}/${dd}/whyyoutouzhele.json`, [])) ?? []));
      }
      return render('tweet', { tweets: result.sort((a, b) => (a.createdDate > b.createdDate ? -1 : 1)).map(processTweetItem) });
    }
    case '/tweet-page': {
      if (!q.year || !q.id || !validTweetQuery(q, [q.id])) return render('tweet', { tweets: [] });
      const sortFn = present(q.day) ? (a, b) => (a.createdDate > b.createdDate ? -1 : 1) : (a, b) => (a.views < b.views ? 1 : -1);
      return render('tweet', { tweets: (await tweetsFor(q)).sort(sortFn).map(processTweetItem) });
    }
    case '/search-tweet-page': {
      if (!q.keyword) return render('tweet', { tweets: [] });
      const res = await lambda(env, new URL(`/search-tweet?keyword=${encodeURIComponent(q.keyword)}`, url), request);
      const tweets = res.ok ? await res.json().catch(() => []) : [];
      return render('tweet', { tweets: (Array.isArray(tweets) ? tweets : []).sort((a, b) => (a.createdDate > b.createdDate ? -1 : 1)).map(processTweetItem) });
    }
    case '/news-page': {
      const { year, month, day, sourceId, newsId } = q;
      if (!year || !month || !day || !sourceId || !newsId || !validTweetQuery(q, [sourceId])) return render('news', { news: [] });
      const list = (await rawJson(`${RAW}/json/main/news/${year}/${month}/${day}/${sourceId}.json`, [])) ?? [];
      return render('news', { news: list.filter((n) => n.id == newsId) });
    }
  }

  // Files proxied from GitHub
  const files = [
    ['/download-pdf/', (r) => streamFile(`https://github.com/hello-world-1989/whyyoutouzhele/releases/download/${r}`, mimeOf(r, 'application/zip'), 'public, max-age=3600, s-maxage=21600')],
    ['/download-app/', (r) => streamFile(`https://github.com/hello-world-1989/temp/releases/download/${r}`, mimeOf(r), 'public, max-age=3600, s-maxage=21600')],
    ['/news-resource/', (r) => streamFile(`${RAW}/resource/main/${r}`, mimeOf(r, 'image/jpeg'), 'public, max-age=86400, s-maxage=604800, immutable')],
    ['/resource/', (r) => streamFile(`${RAW}/resource/main/${r}`, mimeOf(r, 'image/jpeg'), 'public, max-age=86400, s-maxage=604800, immutable')],
  ];
  for (const [prefix, handle] of files) {
    if (p.startsWith(prefix)) {
      const rest = decodeURIComponent(p.slice(prefix.length));
      return isSafeSubPath(rest) ? handle(rest) : new Response('Bad path', { status: 400 });
    }
  }

  // The tweet-queue API needed the server's sqlite database; not carried over
  if (p.startsWith('/api/')) return notFound();

  // Static site
  let path = decodeURIComponent(p);
  if (path.endsWith('/')) path += 'index.html';
  if (path.startsWith('/custom/')) path = path.replace('/custom/', '/custom.example/') + '.example';
  if (!isSafeSubPath(path.slice(1))) return notFound();
  const res = await raw(`${SITE}${path}`, 300).catch(() => null);
  if (!res?.ok) return notFound();
  const type = mimeOf(path.replace(/\.example$/, ''));
  return new Response(res.body, {
    headers: { 'Content-Type': type, 'Cache-Control': type.startsWith('text/html') ? 'public, max-age=300' : 'public, max-age=3600' },
  });
}

async function hourly(env) {
  // Drop mirrors that are not reachable from China (periodicCheckReachable)
  for (const host of await listHosts(env)) {
    const res = await fetch(`${env.LEGACY_API.replace(/\/+$/, '')}/ip-check?ip=${host.ip}&port=${host.port}`).catch(() => null);
    const status = res?.ok ? (await res.json().catch(() => ({})))?.status : 'fail';
    if (status !== 'success') await env.MIRRORS.delete(`host:${host.ip}`);
  }
  // The node published in cn-news end-gfw-together-ss (getEndGFWMirror)
  const res = await raw(`${RAW}/cn-news/main/end-gfw-together-ss`, 300).catch(() => null);
  if (!res?.ok) return;
  let lines = [];
  try {
    lines = atob((await res.text()).trim()).split('\r\n');
  } catch {
    return;
  }
  const ss = lines.filter((l) => l.startsWith('ss://') && l.includes('end-gfw')).pop();
  const ip = ss?.split('@')?.[1]?.split(':')?.[0];
  if (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) await saveMirror(env, ip, 8081, Date.now());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response('OK', { headers: CORS });
    let res;
    try {
      res = request.method === 'GET' || request.method === 'HEAD' ? await route(request, url, env) : notFound();
    } catch (err) {
      console.error(url.pathname, err?.message);
      res = json({ success: false, error: 'Internal error', message: 'Error occurred' }, 500);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(hourly(env));
  },
};

export { isSafeSubPath, validTweetQuery, processTweetItem, mimeOf };
