import test from 'node:test';
import assert from 'node:assert/strict';
import { handleLine, rewriteCookie, rewriteLocation, rewriteHtml } from '../src/line.js';

function env(handler) {
  const calls = [];
  return { calls, TAPLINE: { fetch: async (u, init) => { calls.push({ u, init }); return handler(u, init); } } };
}
const req = (path, init = {}) => new Request(`https://end-gfw.com${path}`, init);
const run = (e, path, init) => handleLine(req(path, init), new URL(`https://end-gfw.com${path}`), e);

test('only /line paths are handled', async () => {
  assert.equal(await run(env(() => new Response('')), '/share'), null);
  assert.equal(await run(env(() => new Response('')), '/lines'), null);
});

test('/line redirects to /line/', async () => {
  const r = await run(env(() => new Response('')), '/line');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/line/');
});

test('page is proxied with API paths and back bar rewritten', async () => {
  const e = env(() => new Response("<html><body><script>fetch(path, x); history.replaceState(null, '', '/');</script></body></html>", { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const r = await run(e, '/line/');
  const html = await r.text();
  assert.equal(new URL(e.calls[0].u).pathname, '/');
  assert.match(html, /fetch\('\/line' \+ path,/);
  assert.match(html, /history\.replaceState\(null, '', '\/line\/'\)/);
  assert.match(html, /返回大翻墙运动/);
});

test('admin, node, bot and webhook routes are blocked', async () => {
  for (const p of ['/line/admin/status', '/line/node/poll', '/line/bot/outbox', '/line/stripe/webhook']) {
    const e = env(() => new Response('secret'));
    const r = await run(e, p);
    assert.equal(r.status, 404, p);
    assert.equal(e.calls.length, 0);
  }
});

test('only the tapline cookie is forwarded, no IP', async () => {
  const e = env(() => Response.json({ me: null }));
  await run(e, '/line/api/me', { headers: { cookie: 'a=1; pi_sid=abc.def; b=2', 'cf-connecting-ip': '1.2.3.4' } });
  const h = e.calls[0].init.headers;
  assert.equal(h.get('cookie'), 'pi_sid=abc.def');
  assert.equal(h.get('cf-connecting-ip'), null);
});

test('POST from another origin is refused; own origin passes without Origin header', async () => {
  const e = env(() => Response.json({ ok: true }));
  const bad = await run(e, '/line/api/start', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
  assert.equal(bad.status, 403);
  const ok = await run(e, '/line/api/start', { method: 'POST', headers: { origin: 'https://end-gfw.com', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(ok.status, 200);
  assert.equal(e.calls[0].init.headers.get('origin'), null);
});

test('cookie path and redirects stay under /line', () => {
  assert.equal(rewriteCookie('pi_sid=x; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=10'), 'pi_sid=x; HttpOnly; Secure; SameSite=Lax; Max-Age=10; Path=/line');
  assert.equal(rewriteCookie('other=1; Path=/'), '');
  assert.equal(rewriteLocation('/?newkey=1'), '/line/?newkey=1');
  assert.equal(rewriteLocation('https://checkout.stripe.com/x'), 'https://checkout.stripe.com/x');
  assert.equal(rewriteHtml('<p>x</p>'), '<p>x</p>');
});
