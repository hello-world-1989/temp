import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFreeNodes, isSafeSubPath, isToken } from '../src/worker.js';

test('file paths cannot leave the intended repo', () => {
  assert.equal(isSafeSubPath('android/android-nthlink.zip'), true);
  assert.equal(isSafeSubPath('tweet/image/a/2026/09/26/1_0.jpg'), true);
  for (const bad of ['../x', 'a/../../b', './a', 'a//b', 'a\\b', '', 'a/\u0000']) {
    assert.equal(isSafeSubPath(bad), false, bad);
  }
});

test('subscription tokens', () => {
  assert.equal(isToken('2db985f6-1234-4abc-8def-0123456789ab'), true);
  assert.equal(isToken('short'), false);
  assert.equal(isToken('abc&days=365'), false);
});

test('free nodes are parsed from the base64 subscription', () => {
  const lines = [
    'vless://u@1.2.3.4:443?security=reality#end-gfw-sgn1-VLESS',
    'hysteria2://u@1.2.3.4:443/?sni=x#end-gfw-sgn1-HY2',
    'ss://abc=@1.2.3.4:8443#%E5%85%8D%E8%B4%B9',
    'javascript:alert(1)',
    '',
  ];
  const nodes = parseFreeNodes(btoa(lines.join('\r\n')));
  assert.deepEqual(nodes.map((n) => n.protocol), ['VLESS', 'Hysteria2', 'Shadowsocks']);
  assert.equal(nodes[0].name, 'end-gfw-sgn1-VLESS');
  assert.equal(nodes[2].name, '免费');
  assert.deepEqual(parseFreeNodes('%%%not base64'), []);
});

test('check-in accepts a token or a whole subscription link', async () => {
  const { extractToken } = await import('../src/worker.js');
  assert.equal(extractToken('2db985f6-1234-4abc-8def-0123456789ab'), '2db985f6-1234-4abc-8def-0123456789ab');
  assert.equal(extractToken('https://sub2.example.net/sub?token=2db985f6-1234-4abc-8def-0123456789ab'), '2db985f6-1234-4abc-8def-0123456789ab');
  assert.equal(extractToken('https://x/api/v1/client/subscribe?foo=1&token=abcdefgh12'), 'abcdefgh12');
  assert.equal(extractToken('not a token!'), '');
});

// --- resumable downloads (fetchFile)
import { fetchFile } from '../src/worker.js';

function withUpstream(handler, fn) {
  const calls = [];
  const saved = { fetch: globalThis.fetch, caches: globalThis.caches };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    return handler(new Headers(init?.headers));
  };
  const puts = [];
  globalThis.caches = { default: { match: async () => undefined, put: async (k, r) => puts.push(r) } };
  const ctx = { waitUntil: (p) => p };
  return fn(ctx, calls, puts).finally(() => Object.assign(globalThis, saved));
}

const FILE = 'https://github.com/o/r/releases/download/android/a.zip';
const meta = { 'content-type': 'application/zip', etag: '"abc"', 'last-modified': 'Mon, 28 Sep 2026 05:26:00 GMT' };

test('range requests are passed through and answered with 206', () =>
  withUpstream(
    (h) => new Response('world', { status: 206, headers: { ...meta, 'content-length': '5', 'content-range': 'bytes 6-10/11' } }),
    async (ctx, calls, puts) => {
      const req = new Request('https://x/download-app/android/a.zip', { headers: { Range: 'bytes=6-', 'If-Range': '"abc"' } });
      const res = await fetchFile(req, ctx, FILE, 21600);
      assert.equal(calls[0].headers.get('range'), 'bytes=6-');
      assert.equal(calls[0].headers.get('if-range'), '"abc"');
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 6-10/11');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(res.headers.get('etag'), '"abc"');
      assert.equal(await res.text(), 'world');
      assert.equal(puts.length, 0);
    },
  ));

test('full downloads advertise ranges and validators', () =>
  withUpstream(
    () => new Response('hello world', { status: 200, headers: { ...meta, 'content-length': '11' } }),
    async (ctx, calls, puts) => {
      const res = await fetchFile(new Request('https://x/download-app/android/a.zip'), ctx, FILE, 21600);
      assert.equal(calls[0].headers.get('range'), null);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(res.headers.get('last-modified'), meta['last-modified']);
      assert.equal(res.headers.get('content-range'), null);
      assert.equal(puts.length, 1); // small full file goes to the Cache API
    },
  ));

test('a range past the end is 416', () =>
  withUpstream(
    () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */11' } }),
    async (ctx) => {
      const req = new Request('https://x/download-app/android/a.zip', { headers: { Range: 'bytes=99-' } });
      const res = await fetchFile(req, ctx, FILE, 21600);
      assert.equal(res.status, 416);
      assert.equal(res.headers.get('content-range'), 'bytes */11');
    },
  ));

test('一键清除: /wipe and /chat/wipe clear site data and leave for a neutral site', async () => {
  const worker = (await import('../src/worker.js')).default;
  for (const path of ['/wipe', '/chat/wipe']) {
    const res = await worker.fetch(new Request(`https://end-gfw.com${path}`), {}, {});
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('clear-site-data'), '"cache", "cookies", "storage"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const html = await res.text();
    assert.match(html, /http-equiv="refresh" content="0;url=https:\/\/www\.bing\.com\/"/);
    assert.doesNotMatch(html, /翻墙|end-gfw|加密/);
  }
});
