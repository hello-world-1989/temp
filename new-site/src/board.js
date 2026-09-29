// 事件墙 (board): pages are static (/board, /board-submit, /board-status, /board-admin,
// /board-post); /board/e/<id> is served the /board-post page. /api/board/* goes to the
// board service on Debian-1-2 (BOARD_URL, via Cloudflare Tunnel) with the shared key BOARD_KEY (Worker secret).
//
// Only what the service needs is forwarded: no IP, no cookies, no user agent. The admin
// token (Authorization) is forwarded for /api/board/admin/* only.

const FORWARD = ['content-type', 'content-length', 'x-draft-key', 'accept'];
const PASS_BACK = ['content-type', 'content-length', 'cache-control', 'content-security-policy', 'content-disposition'];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE']);

export const isBoardId = (s) => /^[A-Za-z0-9]{8,32}$/.test(s);

// -> Response, or null when the path is not the board's (or the board is not configured)
export async function handleBoard(request, url, env) {
  const p = url.pathname;

  const post = p.match(/^\/board\/e\/([^/]+)\/?$/);
  if (post) {
    if (!env.BOARD_URL || !isBoardId(post[1])) return null;
    const page = await env.ASSETS.fetch(new Request(new URL('/board-post', url), { headers: request.headers }));
    return new Response(page.body, { status: page.status, headers: page.headers });
  }

  if (!p.startsWith('/api/board/')) return null;
  if (!env.BOARD_URL) return null;
  // Configured for this Worker but the secret is missing: say so instead of falling through
  if (!env.BOARD_KEY) return boardJson({ error: '事件墙还没配置好：Worker 缺少 BOARD_KEY 密钥' }, 503);
  if (!METHODS.has(request.method)) return boardJson({ error: 'method not allowed' }, 405);

  const headers = new Headers({ 'x-board-key': env.BOARD_KEY });
  for (const h of FORWARD) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (p.startsWith('/api/board/admin/')) {
    const auth = request.headers.get('authorization');
    if (auth) headers.set('authorization', auth);
  }

  // Published images are cached at the edge (the service answers 404 once a post is removed;
  // cached copies expire within the hour)
  const isImage = request.method === 'GET' && /^\/api\/board\/img\/[A-Za-z0-9]+$/.test(p);
  let upstream;
  try {
    upstream = await fetch(`${env.BOARD_URL.replace(/\/$/, '')}${p}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      ...(isImage ? { cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 3600, '400-599': 0 } } } : {}),
    });
  } catch {
    return boardJson({ error: '事件墙暂时无法连接，请稍后再试' }, 502);
  }
  const out = new Headers();
  for (const h of PASS_BACK) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has('cache-control')) out.set('Cache-Control', 'no-store');
  if (upstream.status >= 500 && !(out.get('content-type') || '').includes('json')) {
    upstream.body?.cancel();
    return boardJson({ error: `事件墙暂时不可用，请稍后再试（${upstream.status}）` }, 502);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function boardJson(data, status) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
