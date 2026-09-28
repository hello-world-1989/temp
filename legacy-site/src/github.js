// GitHub access that keeps working when the account is hidden from anonymous visitors
// (profile, raw files and release downloads all 404 unless signed in).
//
// With a token (Worker secret GH_TOKEN, a read-only token of the account):
//   raw.githubusercontent.com/<o>/<r>/<ref>/<path>   -> contents API (raw media type)
//   github.com/<o>/<r>/releases/download/<tag>/<name> -> release-asset API, which answers
//       with a short-lived signed URL; the file (and any Range) is fetched from that URL
// Without a token every call is a plain fetch(), exactly as before.

const RAW_RE = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;
const REL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/;
const API = 'https://api.github.com';
const CACHE_HOST = 'https://gh-cache.invalid';
const SMALL = 20 * 1024 * 1024; // only small files go through the Cache API (see fetchFile)

let token = '';
export function setGitHubToken(value) {
  token = typeof value === 'string' ? value.trim() : '';
}

const TYPES = {
  json: 'application/json; charset=utf-8', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', pdf: 'application/pdf', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
  woff: 'font/woff', woff2: 'font/woff2',
};
function typeOf(path) {
  const ext = path.split('/').pop().split('.').pop().toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

function apiHeaders(accept) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'end-gfw-site',
  };
}

async function cachedJson(key, ttl, load) {
  const cache = globalThis.caches?.default;
  const req = new Request(`${CACHE_HOST}/${key}`);
  const hit = cache && (await cache.match(req));
  if (hit) return hit.json();
  const data = await load();
  if (data != null && cache) {
    await cache.put(req, new Response(JSON.stringify(data), { headers: { 'Cache-Control': `public, max-age=${ttl}` } })).catch(() => {});
  }
  return data;
}

function ttlOf(init) {
  const t = Number(init?.cf?.cacheTtl);
  return Number.isFinite(t) && t > 0 ? t : 300;
}

// raw file through the contents API, kept in the Cache API under its public raw URL
async function rawViaApi(url, [, owner, repo, ref, path], init) {
  const cache = globalThis.caches?.default;
  const key = new Request(url);
  const hit = cache && (await cache.match(key));
  if (hit) return hit;
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: apiHeaders('application/vnd.github.raw+json'),
    signal: init?.signal,
  });
  if (!res.ok) {
    res.body?.cancel();
    return new Response('Not Found', { status: res.status === 404 ? 404 : 502, headers: { 'Cache-Control': 'no-store' } });
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {}
  const headers = { 'Content-Type': typeOf(decoded), 'Cache-Control': `public, max-age=${ttlOf(init)}` };
  const len = res.headers.get('content-length');
  if (len) headers['Content-Length'] = len;
  const out = new Response(res.body, { status: 200, headers });
  if (cache && len && Number(len) <= SMALL) await cache.put(key, out.clone()).catch(() => {});
  return out;
}

// release download: asset id from the (cached) release listing, then the signed URL
async function assetViaApi(url, [, owner, repo, tag, name], init) {
  let file = name;
  try {
    file = decodeURIComponent(name);
  } catch {}
  const assets = await cachedJson(`releases/${owner}/${repo}/${encodeURIComponent(tag)}`, 300, async () => {
    const res = await fetch(`${API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: apiHeaders('application/vnd.github+json') });
    if (!res.ok) {
      res.body?.cancel();
      return null;
    }
    const rel = await res.json();
    return (rel.assets || []).map((a) => ({ id: a.id, name: a.name }));
  });
  const asset = assets?.find((a) => a.name === file);
  if (!asset) return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const redirect = await fetch(`${API}/repos/${owner}/${repo}/releases/assets/${asset.id}`, {
    headers: apiHeaders('application/octet-stream'),
    redirect: 'manual',
  });
  const location = redirect.headers.get('location');
  redirect.body?.cancel();
  if (!location) return new Response('Bad Gateway', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  // The signed URL carries its own authorization; the token is never sent there
  const fwd = new Headers();
  for (const h of ['range', 'if-range']) {
    const v = new Headers(init?.headers).get(h);
    if (v) fwd.set(h, v);
  }
  return fetch(location, { method: init?.method || 'GET', headers: fwd, redirect: 'follow' });
}

export async function ghFetch(url, init = {}) {
  if (token) {
    const raw = String(url).match(RAW_RE);
    if (raw) return rawViaApi(String(url), raw, init);
    const rel = String(url).match(REL_RE);
    if (rel) return assetViaApi(String(url), rel, init);
  }
  return fetch(url, init);
}
