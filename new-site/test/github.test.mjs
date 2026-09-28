import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ghFetch, setGitHubToken } from '../src/github.js';

function mock(handler, fn) {
  const saved = { fetch: globalThis.fetch, caches: globalThis.caches };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), headers: new Headers(init.headers), init };
    calls.push(call);
    return handler(call);
  };
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => void store.set(req.url, res),
    },
  };
  return fn(calls).finally(() => {
    Object.assign(globalThis, saved);
    setGitHubToken('');
  });
}

const RAW = 'https://raw.githubusercontent.com/hello-world-1989/temp/main/public/temp/vpn.json';
const REL = 'https://github.com/hello-world-1989/temp/releases/download/android/android-outline.zip';

test('without a token, GitHub URLs are fetched as before', () =>
  mock(
    () => new Response('ok'),
    async (calls) => {
      setGitHubToken('');
      await ghFetch(RAW);
      assert.equal(calls[0].url, RAW);
      assert.equal(calls[0].headers.get('authorization'), null);
    },
  ));

test('raw files go through the contents API and are cached', () =>
  mock(
    () => new Response('[{"os":"android"}]', { headers: { 'content-length': '18' } }),
    async (calls) => {
      setGitHubToken('secret');
      const res = await ghFetch(RAW, { cf: { cacheTtl: 300 } });
      assert.equal(calls[0].url, 'https://api.github.com/repos/hello-world-1989/temp/contents/public/temp/vpn.json?ref=main');
      assert.equal(calls[0].headers.get('authorization'), 'Bearer secret');
      assert.equal(calls[0].headers.get('accept'), 'application/vnd.github.raw+json');
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.deepEqual(await res.json(), [{ os: 'android' }]);
      const again = await ghFetch(RAW, { cf: { cacheTtl: 300 } });
      assert.equal(calls.length, 1, 'second read comes from the cache');
      assert.deepEqual(await again.json(), [{ os: 'android' }]);
    },
  ));

test('a missing raw file is a 404', () =>
  mock(
    () => new Response('nope', { status: 404 }),
    async () => {
      setGitHubToken('secret');
      assert.equal((await ghFetch(RAW)).status, 404);
    },
  ));

test('release downloads use the signed URL without the token, with Range passed on', () =>
  mock(
    ({ url }) => {
      if (url.endsWith('/releases/tags/android')) return Response.json({ assets: [{ id: 7, name: 'android-outline.zip' }] });
      if (url.endsWith('/releases/assets/7')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.example/blob?sig=x' } });
      return new Response('abc', { status: 206, headers: { 'content-range': 'bytes 5-7/8' } });
    },
    async (calls) => {
      setGitHubToken('secret');
      const res = await ghFetch(REL, { headers: { Range: 'bytes=5-', 'If-Range': '"e"' } });
      assert.equal(res.status, 206);
      const signed = calls.find((c) => c.url.startsWith('https://release-assets.example/'));
      assert.ok(signed);
      assert.equal(signed.headers.get('authorization'), null, 'token never goes to the signed URL');
      assert.equal(signed.headers.get('range'), 'bytes=5-');
      assert.equal(signed.headers.get('if-range'), '"e"');
      assert.equal(calls.find((c) => c.url.endsWith('/assets/7')).init.redirect, 'manual');
    },
  ));

test('an unknown release file is a 404', () =>
  mock(
    () => Response.json({ assets: [{ id: 7, name: 'other.zip' }] }),
    async () => {
      setGitHubToken('secret');
      assert.equal((await ghFetch(REL)).status, 404);
    },
  ));
