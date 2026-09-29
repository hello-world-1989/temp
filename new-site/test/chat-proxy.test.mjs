// 加密聊天 through the Worker: /chat, /chat/* and the /chat/ws WebSocket go to CHAT_URL with
// nothing that identifies the visitor; the page CSP names the address the browser used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { isMirrorHost } from '../src/worker.js';

const CHAT_URL = 'https://chat-store.example';
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self' wss://chat-store.example ws://chat-store.example; frame-ancestors 'none'";
const assets = { fetch: async () => new Response('not found page', { status: 404 }) };

async function call(req, env = { CHAT_URL, ASSETS: assets }, upstream = () => new Response('ok')) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const c = { url: String(url), method: init.method || 'GET', headers: new Headers(init.headers), body: init.body ? await new Response(init.body).text() : undefined };
    calls.push(c);
    return upstream(c);
  };
  try {
    const res = await worker.fetch(req, env, { waitUntil: () => {} });
    return { res, calls };
  } finally {
    globalThis.fetch = saved;
  }
}

const page = () =>
  new Response('<html>chat</html>', { headers: { 'content-type': 'text/html', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' } });

test('chat page: proxied without visitor data; CSP names this address', async () => {
  const req = new Request('https://end-gfw.com/chat?x=1', {
    headers: { cookie: 'a=b', 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '9.9.9.9', 'true-client-ip': '9.9.9.9', accept: 'text/html' },
  });
  const { res, calls } = await call(req, undefined, page);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CHAT_URL}/chat?x=1`);
  for (const h of ['cookie', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip']) assert.equal(calls[0].headers.get(h), null, h);
  assert.equal(calls[0].headers.get('accept'), 'text/html');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /wss:\/\/end-gfw\.com ws:\/\/end-gfw\.com/);
  assert.doesNotMatch(csp, /chat-store/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer', 'the page keeps its own policy');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('chat page through a mirror: CSP names the mirror (IP or domain); junk is ignored', async () => {
  for (const [xn, want] of [
    ['203.0.113.7', 'wss://203.0.113.7 '],
    ['mirror.example.org', 'wss://mirror.example.org '],
    ["x; script-src 'unsafe-inline'", 'wss://end-gfw.com '],
    ['a b', 'wss://end-gfw.com '],
  ]) {
    const { res, calls } = await call(new Request('https://end-gfw.com/chat', { headers: { 'x-xn-host': xn } }), undefined, page);
    assert.equal(calls[0].headers.get('x-xn-host'), null, 'not passed on');
    assert.ok(res.headers.get('content-security-policy').includes(want), `${xn} -> ${res.headers.get('content-security-policy')}`);
  }
  assert.ok(isMirrorHost('1.2.3.4') && isMirrorHost('a-b.example.com'));
  assert.ok(!isMirrorHost('') && !isMirrorHost('evil.com;') && !isMirrorHost('*.example.com') && !isMirrorHost('localhost'));
});

test('chat API: long-poll requests pass through with their body', async () => {
  const body = JSON.stringify({ cid: 'abcdefghijkmnpqr' });
  const { res, calls } = await call(
    new Request('https://end-gfw.com/chat/api/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
    undefined,
    () => new Response('{"events":[]}', { headers: { 'content-type': 'application/json' } }),
  );
  assert.equal(calls[0].url, `${CHAT_URL}/chat/api/poll`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, body);
  assert.deepEqual(await res.json(), { events: [] });
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('chat WebSocket: only upgrade requests, forwarded as-is to /chat/ws', async () => {
  const plain = await call(new Request('https://end-gfw.com/chat/ws'));
  assert.equal(plain.res.status, 426);
  assert.equal(plain.calls.length, 0);
  const up = await call(new Request('https://end-gfw.com/chat/ws?x=1', { headers: { upgrade: 'websocket', 'cf-connecting-ip': '9.9.9.9' } }), undefined, () => new Response('switched'));
  assert.equal(up.calls[0].url, `${CHAT_URL}/chat/ws`);
  assert.equal(up.calls[0].headers.get('upgrade'), 'websocket');
  assert.equal(up.calls[0].headers.get('cf-connecting-ip'), null);
  assert.equal(await up.res.text(), 'switched');
});

test('without CHAT_URL, /chat is the site 404', async () => {
  const { res, calls } = await call(new Request('https://end-gfw.com/chat'), { ASSETS: assets });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});
