import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBoard } from '../src/board.js';

const env = { BOARD_URL: 'https://board.example/', BOARD_KEY: 'secret-key' };

function withFetch(fn, respond = () => new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'x=1' } })) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return Promise.resolve(fn(calls)).finally(() => (globalThis.fetch = orig));
}

test('board is off without BOARD_URL / BOARD_KEY', async () => {
  const req = new Request('https://site/api/board/meta');
  assert.equal(await handleBoard(req, new URL(req.url), {}), null);
  const missing = await handleBoard(req, new URL(req.url), { BOARD_URL: 'x' });
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /BOARD_KEY/);
  const other = new Request('https://site/api/plans');
  assert.equal(await handleBoard(other, new URL(other.url), env), null);
});

test('forwards only what the service needs, adds the key', () =>
  withFetch(async (calls) => {
    const req = new Request('https://site/api/board/drafts/abcdefgh12/submit?x=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-draft-key': 'dk',
        'CF-Connecting-IP': '1.2.3.4',
        'X-Forwarded-For': '1.2.3.4',
        Cookie: 'a=b',
        'User-Agent': 'UA',
        Authorization: 'Bearer admin',
      },
      body: '{}',
    });
    const res = await handleBoard(req, new URL(req.url), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(calls[0].url, 'https://board.example/api/board/drafts/abcdefgh12/submit?x=1');
    const h = calls[0].init.headers;
    assert.equal(h.get('x-board-key'), 'secret-key');
    assert.equal(h.get('x-draft-key'), 'dk');
    for (const bad of ['cf-connecting-ip', 'x-forwarded-for', 'cookie', 'user-agent', 'authorization']) assert.equal(h.get(bad), null, bad);
  }));

test('admin token goes to admin paths only; images are edge-cached', () =>
  withFetch(async (calls) => {
    const a = new Request('https://site/api/board/admin/queue', { headers: { Authorization: 'Bearer t' } });
    await handleBoard(a, new URL(a.url), env);
    assert.equal(calls[0].init.headers.get('authorization'), 'Bearer t');
    assert.equal(calls[0].init.cf, undefined);
    const i = new Request('https://site/api/board/img/abcdefgh12');
    await handleBoard(i, new URL(i.url), env);
    assert.equal(calls[1].init.cf.cacheEverything, true);
  }));

test('upstream failures', async () => {
  await withFetch(async () => {
    const req = new Request('https://site/api/board/meta');
    const res = await handleBoard(req, new URL(req.url), env);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /暂时不可用/);
  }, () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
  // The service's own JSON errors (e.g. a full queue) reach the page
  await withFetch(async () => {
    const req = new Request('https://site/api/board/meta');
    const res = await handleBoard(req, new URL(req.url), env);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /太多/);
  }, () => new Response('{"error":"待审核的投稿太多"}', { status: 503, headers: { 'Content-Type': 'application/json' } }));
  await withFetch(async () => {
    const req = new Request('https://site/api/board/meta');
    const res = await handleBoard(req, new URL(req.url), env);
    assert.equal(res.status, 502);
  }, () => {
    throw new Error('down');
  });
});

test('/board/e/<id> serves the event page', async () => {
  const assets = { fetch: async (r) => new Response(`page for ${new URL(r.url).pathname}`, { headers: { 'Content-Type': 'text/html' } }) };
  const req = new Request('https://site/board/e/abcdefgh12');
  const res = await handleBoard(req, new URL(req.url), { ...env, ASSETS: assets });
  assert.equal(await res.text(), 'page for /board-post');
  const bad = new Request('https://site/board/e/..%2F');
  assert.equal(await handleBoard(bad, new URL(bad.url), { ...env, ASSETS: assets }), null);
});
