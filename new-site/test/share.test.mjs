import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptFile, decryptFile, b64url, fromB64url, sha256hex } from '../public/assets/share-crypto.js';
import { handleShare, sweep, isShareId, newId, MAX_BODY, TTL_MS } from '../src/share.js';

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
  env.SHARE.store.set('share/cccccccccccccccccccccc', { key: 'share/cccccccccccccccccccccc', size: 1, uploaded: new Date(Date.now() - TTL_MS - 1000), customMetadata: {}, data: new Uint8Array(1) });
  assert.equal(await sweep(env), 1);
  assert.deepEqual([...env.SHARE.store.keys()], ['share/bbbbbbbbbbbbbbbbbbbbbb']);

  assert.equal(await call({}, '/share'), 'disabled');
  assert.equal(await call({}, '/api/share/bbbbbbbbbbbbbbbbbbbbbb'), 'disabled');
  assert.equal(await call({}, '/news'), null);
});
