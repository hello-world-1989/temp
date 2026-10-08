// 随开专线 at /tapline: the paid-instance Worker (tapline), reached through the service binding
// TAPLINE, so visitors stay on this site's address (end-gfw.com, v2, mirror node IPs) and the
// tapline domain is never shown.
//
//   /tapline         -> 301 /tapline/   (old /line, /line/* -> 301 to the same place under /tapline)
//   /tapline/        -> tapline /         (login + dashboard page)
//   /tapline/auth    -> tapline /auth     (login link from the mail, if it points here)
//   /tapline/api/*   -> tapline /api/*
//   /tapline/c/*     -> tapline /c/*      (copy page for a node's links)
//
// tapline's admin, node, bot and Stripe webhook routes are not reachable through here.
// Only tapline's own cookie (pi_sid) is passed on; no visitor IP, no other cookies.

export const LINE_PREFIX = '/tapline';
// First address (2026-10-09, a few minutes): kept as a redirect
const OLD_PREFIX = '/line';
const ALLOWED = [/^\/$/, /^\/auth$/, /^\/api\/[a-z0-9/-]+$/, /^\/c\/[A-Za-z0-9_-]+$/];
const COOKIE = 'pi_sid';

export async function handleTapline(request, url, env) {
  const p = url.pathname;
  if (p === OLD_PREFIX || p.startsWith(`${OLD_PREFIX}/`)) {
    return new Response(null, { status: 301, headers: { Location: `${LINE_PREFIX}${p.slice(OLD_PREFIX.length) || '/'}${url.search}` } });
  }
  if (p !== LINE_PREFIX && !p.startsWith(`${LINE_PREFIX}/`)) return null;
  if (!env.TAPLINE) return text('随开专线暂时不可用', 503);
  if (p === LINE_PREFIX) return new Response(null, { status: 301, headers: { Location: `${LINE_PREFIX}/${url.search}` } });

  const upstreamPath = p.slice(LINE_PREFIX.length);
  if (!ALLOWED.some((re) => re.test(upstreamPath))) return text('页面不存在', 404);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  // tapline checks Origin against its own address; this Worker does that check for the
  // address the visitor actually used, then leaves Origin out
  if (hasBody && !sameSite(request, url)) return text('bad origin', 403);

  const headers = new Headers();
  for (const h of ['accept', 'content-type', 'accept-language']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const sid = readCookie(request.headers.get('cookie'), COOKIE);
  if (sid) headers.set('cookie', `${COOKIE}=${sid}`);

  const target = new URL(upstreamPath + url.search, 'https://tapline.internal');
  const res = await env.TAPLINE.fetch(target.href, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });

  const out = new Headers();
  for (const h of ['content-type', 'cache-control', 'referrer-policy', 'x-robots-tag']) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has('cache-control')) out.set('cache-control', 'no-store');
  // tapline sets its cookie for "/"; here it belongs to /tapline only
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of cookies) {
    const v = rewriteCookie(c);
    if (v) out.append('set-cookie', v);
  }
  const loc = res.headers.get('location');
  if (loc) out.set('location', rewriteLocation(loc));

  let body = res.body;
  if ((res.headers.get('content-type') || '').includes('text/html')) {
    body = rewriteHtml(await res.text());
    out.set('x-robots-tag', 'noindex');
  }
  return new Response(body, { status: res.status, headers: out });
}

// The page calls its API with absolute paths ('/api/me') and resets the address bar to '/'
// plus a small bar back to the main site, since tapline's page has no site menu
const BACK_BAR = '<div style="max-width:640px;margin:0 auto;padding:12px 16px 0;font-size:14px"><a href="/" style="color:inherit;opacity:.75;text-decoration:none">\u2190 返回大翻墙运动</a></div>';
export function rewriteHtml(html) {
  return html
    .replace(/<body([^>]*)>/i, `<body$1>${BACK_BAR}`)
    .replace(/fetch\(path,/g, `fetch('${LINE_PREFIX}' + path,`)
    .replace(/history\.replaceState\(null, '', '\/'\)/g, `history.replaceState(null, '', '${LINE_PREFIX}/')`);
}

export function rewriteCookie(c) {
  if (!new RegExp(`^${COOKIE}=`).test(c)) return '';
  return c.replace(/;\s*Path=[^;]*/i, '') + `; Path=${LINE_PREFIX}`;
}

// Same-site redirects ("/", "/?newkey=1") stay under /tapline; anything else is left alone
export function rewriteLocation(loc) {
  if (loc.startsWith('/') && !loc.startsWith('//')) return LINE_PREFIX + loc;
  return loc;
}

function sameSite(request, url) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  if (origin === url.origin) return true;
  // Mirror nodes proxy this site and report the address the visitor used
  const xn = request.headers.get('x-xn-host') || '';
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(xn) && origin === `https://${xn}`;
}

function readCookie(header, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(header || '');
  return m ? m[1] : null;
}

function text(msg, status) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
