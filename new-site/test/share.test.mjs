import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptFile, decryptFile, b64url, fromB64url, sha256hex } from '../public/assets/share-crypto.js';
import { handleShare, shareStore, isShareId, newId, MAX_BODY, TTL_MS } from '../src/share.js';

globalThis.FixedLengthStream ??= class extends TransformStream {
  constructor() {
    super();
  }
};

const file = (text, name = '文件.txt') => new File([text], name, { type: 'text/plain' });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

test('encrypt / decrypt round trip, without and with a password', async () => {
  const a = await encryptFile(file('hello 世界'));
  const da = await decryptFile(await bytesOf(a.blob), a.linkKey);
  assert.equal(new TextDecoder().decode(da.data), 'hello 世界');
  assert.equal(da.name, '文件.txt');
  assert.equal(da.deleteToken, a.deleteToken);

  const b = await encryptFile(file('secret'), 'pässword');
  const bb = await bytesOf(b.blob);
  assert.equal(bb[4], 1);
  await assert.rejects(decryptFile(bb, b.linkKey, 'wrong'), /password/);
  await assert.rejects(decryptFile(bb, b.linkKey), /password/);
  const other = crypto.getRandomValues(new Uint8Array(32));
  await assert.rejects(decryptFile(bb, other, 'pässword'), /password/);
  assert.equal(new TextDecoder().decode((await decryptFile(bb, b.linkKey, 'pässword')).data), 'secret');

  // Clearing the password flag (authenticated) breaks decryption
  const tampered = bb.slice();
  tampered[4] = 0;
  await assert.rejects(decryptFile(tampered, b.linkKey), /password/);
});

test('ciphertext does not contain the file name or content', async () => {
  const e = await encryptFile(file('plain-marker', 'name-marker.txt'));
  const s = new TextDecoder('latin1').decode(await bytesOf(e.blob));
  assert.ok(!s.includes('plain-marker') && !s.includes('name-marker'));
});

test('ids and base64url', () => {
  const id = newId();
  assert.ok(isShareId(id), id);
  assert.ok(!isShareId('../../etc'));
  const k = crypto.getRandomValues(new Uint8Array(32));
  assert.deepEqual(fromB64url(b64url(k)), k);
});

// --- handler with an in-memory R2 bucket
function fakeBucket() {
  const store = new Map();
  return {
    store,
    async put(key, body, opts) {
      const data = new Uint8Array(await new Response(body).arrayBuffer());
      const obj = { key, size: data.length, uploaded: new Date(), customMetadata: opts.customMetadata, data };
      store.set(key, obj);
      return obj;
    },
    async head(key) {
      return store.get(key) || null;
    },
    async get(key) {
      const o = store.get(key);
      return o ? { ...o, body: new Response(o.data).body } : null;
    },
    async delete(keys) {
      for (const k of [].concat(keys)) store.delete(k);
    },
    async list({ prefix }) {
      return { objects: [...store.values()].filter((o) => o.key.startsWith(prefix)), truncated: false };
    },
  };
}

const call = (env, path, init) => {
  const url = new URL(path, 'https://share-preview.end-gfw.com');
  return handleShare(new Request(url, init), url, env);
};

test('upload, info, download, delete with the token only', async () => {
  const env = { SHARE: fakeBucket() };
  const e = await encryptFile(file('abc'), 'pw');
  const body = await bytesOf(e.blob);
  const up = await call(env, '/api/share', {
    method: 'POST',
    body,
    headers: { 'content-length': String(body.length), 'x-delete-hash': await sha256hex(e.deleteToken), 'x-share-password': '1' },
  });
  assert.equal(up.status, 201);
  const { id } = await up.json();

  const info = await (await call(env, `/api/share/${id}`)).json();
  assert.equal(info.password, true);
  assert.equal(info.size, body.length);

  const got = new Uint8Array(await (await call(env, `/api/share/${id}/file`)).arrayBuffer());
  assert.deepEqual(got, body);
  // Fetching the ciphertext does not delete it
  assert.equal((await call(env, `/api/share/${id}`)).status, 200);

  const bad = await call(env, `/api/share/${id}/delete`, { method: 'POST', body: JSON.stringify({ token: b64url(new Uint8Array(32)) }) });
  assert.equal(bad.status, 403);
  const ok = await call(env, `/api/share/${id}/delete`, { method: 'POST', body: JSON.stringify({ token: e.deleteToken }) });
  assert.equal(ok.status, 200);
  assert.equal((await call(env, `/api/share/${id}/file`)).status, 404);
});

test('limits, expiry and disabled deployments', async () => {
  const env = { SHARE: fakeBucket() };
  const big = await call(env, '/api/share', { method: 'POST', body: 'x', headers: { 'content-length': String(MAX_BODY + 1), 'x-delete-hash': 'a'.repeat(64) } });
  assert.equal(big.status, 413);
  const noHash = await call(env, '/api/share', { method: 'POST', body: 'x', headers: { 'content-length': '1' } });
  assert.equal(noHash.status, 400);

  env.SHARE.store.set('share/aaaaaaaaaaaaaaaaaaaaaa', { key: 'share/aaaaaaaaaaaaaaaaaaaaaa', size: 1, uploaded: new Date(Date.now() - TTL_MS - 1000), customMetadata: {}, data: new Uint8Array(1) });
  env.SHARE.store.set('share/bbbbbbbbbbbbbbbbbbbbbb', { key: 'share/bbbbbbbbbbbbbbbbbbbbbb', size: 1, uploaded: new Date(), customMetadata: {}, data: new Uint8Array(1) });
  assert.equal((await call(env, '/api/share/aaaaaaaaaaaaaaaaaaaaaa/file')).status, 404);
  assert.ok(!env.SHARE.store.has('share/aaaaaaaaaaaaaaaaaaaaaa'));
  assert.deepEqual([...env.SHARE.store.keys()], ['share/bbbbbbbbbbbbbbbbbbbbbb']);

  assert.equal(await call({}, '/share'), 'disabled');
  assert.equal(await call({}, '/api/share/bbbbbbbbbbbbbbbbbbbbbb'), 'disabled');
  assert.equal(await call({}, '/news'), null);
});

test('rate limits apply per IP, except for requests from mirror nodes', async () => {
  let calls = 0;
  const deny = { limit: async () => (calls++, { success: false }) };
  const env = { SHARE: fakeBucket(), SHARE_READ_LIMIT: deny, SHARE_UPLOAD_LIMIT: deny };
  const opts = { mirrorIps: async () => new Set(['9.9.9.9']) };
  const req = (ip) => {
    const url = new URL('https://x/api/share/bbbbbbbbbbbbbbbbbbbbbb');
    return handleShare(new Request(url, { headers: { 'cf-connecting-ip': ip } }), url, env, opts);
  };
  assert.equal((await req('1.1.1.1')).status, 429);
  assert.equal((await req('9.9.9.9')).status, 404); // not limited here, file just missing
  assert.equal(calls, 1);

  const m = new URL('https://x/api/share/mirrors');
  const off = await (await handleShare(new Request(m), m, env, opts)).json();
  assert.deepEqual(off, { mirrors: [], site: [] });
  const on = await (await handleShare(new Request(m), m, { ...env, SHARE_MIRROR_LINKS: '1', SHARE_SITE_URL: 'https://end-gfw.com/' }, opts)).json();
  assert.deepEqual(on, { mirrors: ['https://9.9.9.9'], site: ['https://end-gfw.com'] });
});

test('the storage server client', async () => {
  const saved = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const h = new Headers(init.headers);
    seen.push({ url, method: init.method || 'GET', key: h.get('x-store-key'), dh: h.get('x-meta-dh') });
    if (init.method === 'PUT') {
      await new Response(init.body).arrayBuffer();
      return Response.json({ size: 3, uploaded: 1700000000000 }, { status: 201 });
    }
    if (url.endsWith('/f/missingmissingmissing1')) return new Response('{}', { status: 404 });
    const headers = { 'x-size': '3', 'x-uploaded': '1700000000000', 'x-meta-dh': 'd'.repeat(64), 'x-meta-pw': '1' };
    if (init.method === 'HEAD') return new Response(null, { headers });
    if (init.method === 'DELETE') return Response.json({ deleted: true });
    return new Response('abc', { headers });
  };
  try {
    assert.equal(shareStore({}), null);
    const st = shareStore({ SHARE_STORE_URL: 'https://store.example/', SHARE_STORE_KEY: 'k'.repeat(40) });
    const put = await st.put('share/aaaaaaaaaaaaaaaaaaaaaa', new Response('abc').body, { customMetadata: { dh: 'd'.repeat(64), pw: '1' } });
    assert.equal(put.size, 3);
    assert.equal(put.uploaded.getTime(), 1700000000000);
    const head = await st.head('share/aaaaaaaaaaaaaaaaaaaaaa');
    assert.deepEqual(head.customMetadata, { dh: 'd'.repeat(64), pw: '1' });
    assert.equal(await st.head('share/missingmissingmissing1'), null);
    const got = await st.get('share/aaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(await new Response(got.body).text(), 'abc');
    await st.delete('share/aaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(seen[0].url, 'https://store.example/f/aaaaaaaaaaaaaaaaaaaaaa');
    assert.ok(seen.every((c) => c.key === 'k'.repeat(40)));
    assert.equal(seen[0].dh, 'd'.repeat(64));
  } finally {
    globalThis.fetch = saved;
  }
});

test('photo metadata is removed (GPS, camera, comments, trailing images), orientation kept', async () => {
  const { readFileSync } = await import('node:fs');
  const { stripMetadata } = await import('../public/assets/share-meta.js');
  for (const f of ['a.jpg', 'p.jpg', 'm.jpg', 'a.png', 'a.webp']) {
    const src = readFileSync(new URL(`fixtures/${f}`, import.meta.url));
    assert.ok(src.toString('latin1').includes('SECRET'), f);
    const { file, cleaned } = await stripMetadata(new File([src], f));
    const out = Buffer.from(await file.arrayBuffer()).toString('latin1');
    assert.ok(cleaned, f);
    assert.ok(!out.includes('SECRET'), f);
    if (f.endsWith('.jpg')) {
      assert.ok(out.includes('Exif\0\0MM'), `${f} keeps orientation`);
      assert.ok(out.endsWith('\xff\xd9'), `${f} ends at the main image`);
    }
  }
  const other = new File(['%PDF-1.4 author'], 'x.pdf');
  assert.equal((await stripMetadata(other)).cleaned, false);
});
