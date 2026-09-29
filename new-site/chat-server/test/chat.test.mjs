// Tests for the chat service: browser crypto (run under Node's Web Crypto), the PROXY protocol
// parser, the TLS edge, certificate issuance (with a fake acme.sh) and the room protocol.
//   npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { openStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { createEdge, parseProxyHeader, isPublicIPv4 } from '../src/edge.js';
import { createCerts, createAcmeHandler } from '../src/certs.js';
import { createEntries } from '../src/entries.js';
import * as C from '../public/chat-crypto.js';
import * as V from '../public/chat-vault.js';
import { makeChallenge } from '../../board-server/src/pow.js';

const tmp = mkdtempSync(join(tmpdir(), 'chat-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// ---- crypto ---------------------------------------------------------------------------------

test('messages round-trip, are padded, and bind to their room', async () => {
  const key = C.randomBytes(32);
  const { aes, auth } = await C.roomKeys(key);
  assert.equal(auth.length, 32);
  const room = C.newRoomId();
  assert.match(room, /^[A-Za-z0-9]{16}$/);
  const short = await C.seal(aes, room, 'msg', { x: 'hi' });
  const longer = await C.seal(aes, room, 'msg', { x: 'x'.repeat(200) });
  assert.equal(short.length, longer.length, 'same padding bucket');
  assert.deepEqual(await C.open(aes, room, 'msg', short), { x: 'hi' });
  await assert.rejects(C.open(aes, C.newRoomId(), 'msg', short), 'other room');
  await assert.rejects(C.open(aes, room, 'meta', short), 'other kind');
  const other = await C.roomKeys(C.randomBytes(32));
  await assert.rejects(C.open(other.aes, room, 'msg', short), 'other key');
  const big = await C.seal(aes, room, 'msg', { x: '中'.repeat(4000) });
  assert.equal(big.length, 16 + 16384 + 16);
});

test('invite fragments parse and reject damaged links', () => {
  const room = C.newRoomId();
  const key = C.randomBytes(32);
  const owner = C.randomBytes(32);
  const f = C.parseFragment(C.fragment(room, key, owner));
  assert.equal(f.room, room);
  assert.deepEqual([...f.key], [...key]);
  assert.deepEqual([...f.owner], [...owner]);
  assert.equal(C.parseFragment(C.fragment(room, key)).owner, null);
  assert.equal(C.parseFragment(C.fragment(room, key).slice(0, -3)), null);
  assert.equal(C.parseFragment('#abc'), null);
});

test('signed messages verify; a changed message or a borrowed key does not', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const identity = { keys, pub, fp: await C.fingerprint(pub) };
  const room = C.newRoomId();
  const m = await C.makeMessage(room, identity, '小明', '你好');
  const ok = await C.checkMessage(room, m);
  assert.equal(ok.text, '你好');
  assert.equal(ok.fp, identity.fp);
  assert.match(ok.fp, /^[0-9a-f]{4}-[0-9a-f]{4}$/);
  await assert.rejects(C.checkMessage(room, { ...m, x: '改过' }));
  await assert.rejects(C.checkMessage(room, { ...m, n: '小红' }));
  await assert.rejects(C.checkMessage(C.newRoomId(), m), 'replayed into another room');
  const unsigned = await C.makeMessage(room, null, '匿名', 'x');
  assert.equal((await C.checkMessage(room, unsigned)).fp, null);
});

// ---- 保险箱 (vault), backups, transfers --------------------------------------------------------

test('vault: passphrase opens it, a wrong one does not; saving keeps the passphrase', async () => {
  const id = await C.newIdentity();
  const saved = await C.exportIdentity(id);
  const data = { identity: saved, nick: '小明', rooms: [{ room: C.newRoomId(), key: C.b64url(C.randomBytes(32)), owner: null, name: '群', added: 1 }] };
  const { box, raw } = await V.newBox('correct horse', data, 100000);
  assert.ok(V.isBox(box));
  assert.equal(JSON.stringify(box).includes('小明'), false, 'nothing readable in the box');
  await assert.rejects(V.openBox('wrong pass', box), /password/);
  const opened = await V.openBox('correct horse', box);
  assert.deepEqual(opened.data, data);
  assert.deepEqual([...opened.raw], [...raw]);
  // re-saving under the session key: same salt/iter, the passphrase still opens it
  const box2 = await V.lockBox(raw, { ...data, nick: '改名' }, box);
  assert.equal(box2.salt, box.salt);
  assert.equal((await V.openBox('correct horse', box2)).data.nick, '改名');
  // the identity survives the round trip with its fingerprint
  const back = await C.importIdentity(opened.data.identity);
  assert.equal(back.fp, id.fp);
  const room = C.newRoomId();
  const m = await C.makeMessage(room, back, 'n', 'x');
  assert.equal((await C.checkMessage(room, m)).fp, id.fp);
  // backup file format
  const file = V.backupFile(box);
  assert.deepEqual(V.readBackupFile(file), box);
  assert.throws(() => V.readBackupFile('{"type":"other"}'), /format/);
  assert.throws(() => V.readBackupFile('not json'), /format/);
});

test('vault contents are cleaned; transfers need the key from the link', async () => {
  const clean = V.cleanContents({ nick: 'x'.repeat(50), rooms: [{ room: 'bad' }, { room: 'a'.repeat(16), key: 'k'.repeat(43), owner: 'nope', name: 1 }, { room: 'a'.repeat(16), key: 'k'.repeat(43) }], identity: { pkcs8: 1 } });
  assert.equal(clean.nick.length, 20);
  assert.equal(clean.rooms.length, 1);
  assert.equal(clean.rooms[0].owner, null);
  assert.equal(clean.identity, null);
  const { key, blob } = await V.sealTransfer({ hello: '世界' });
  assert.deepEqual(await V.openTransfer(key, blob), { hello: '世界' });
  await assert.rejects(V.openTransfer(C.randomBytes(32), blob));
  const id = C.newRoomId();
  const t = V.parseTransfer(V.transferFragment(id, key));
  assert.equal(t.id, id);
  assert.deepEqual([...t.key], [...key]);
  assert.equal(V.parseTransfer(`#${id}.${C.b64url(key)}`), null, 'a room link is not a transfer link');
  assert.equal(C.parseFragment(V.transferFragment(id, key)), null, 'a transfer link is not a room link');
});

test('identity made before backups cannot be exported', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  assert.equal(await C.exportIdentity({ keys, pub, fp: '' }), null);
  assert.equal(await C.exportIdentity(null), null);
});

// ---- PROXY protocol / addresses ------------------------------------------------------------

test('PROXY v1 and v2 headers', () => {
  const tlsHello = Buffer.from([0x16, 0x03, 0x01, 0x00]);
  assert.deepEqual(parseProxyHeader(tlsHello), { done: true, dst: null, rest: tlsHello });
  const v1 = Buffer.concat([Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 5555 8443\r\n'), tlsHello]);
  const r1 = parseProxyHeader(v1);
  assert.equal(r1.dst, '5.6.7.8');
  assert.deepEqual(r1.rest, tlsHello);
  assert.deepEqual(parseProxyHeader(v1.subarray(0, 10)), { done: false });
  const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
  const v2 = Buffer.concat([sig, Buffer.from([0x21, 0x11, 0x00, 12, 1, 2, 3, 4, 9, 8, 7, 6, 0x15, 0xb3, 0x20, 0xfb]), tlsHello]);
  const r2 = parseProxyHeader(v2);
  assert.equal(r2.dst, '9.8.7.6');
  assert.deepEqual(r2.rest, tlsHello);
  assert.throws(() => parseProxyHeader(Buffer.from('GET / HTTP/1.1\r\n')));
});

test('public IPv4 check', () => {
  for (const ip of ['8.8.8.8', '45.76.1.2', '203.0.114.1']) assert.ok(isPublicIPv4(ip), ip);
  for (const ip of ['10.0.0.1', '172.20.1.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', '0.1.2.3', '224.0.0.1', '::1', 'x']) assert.ok(!isPublicIPv4(ip), ip);
});

// ---- certificates --------------------------------------------------------------------------

function selfSigned(dir, cn, days = 5) {
  mkdirSync(dir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', String(days), '-subj', `/CN=${cn}`, '-addext', `subjectAltName=IP:${cn}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'fullchain.pem')], { stdio: 'ignore' });
}

test('certificates: check-in issues once, failures back off, rate limit, stale mirrors are dropped', async () => {
  const base = mkdtempSync(join(tmp, 'certs-'));
  const config = { ...loadConfig({ DATA_DIR: base, ACME_SH: '/fake/acme.sh', ISSUE_PER_HOUR: '3' }) };
  const store = openStore(':memory:');
  let t = Date.parse('2026-10-01T00:00:00Z');
  const calls = [];
  const failFor = new Set(['9.9.9.9']);
  const run = async (cmd, args) => {
    const ip = args[args.indexOf('-d') + 1];
    calls.push(ip);
    if (failFor.has(ip)) throw new Error('validation failed');
    selfSigned(join(config.acmeHome, `${ip}_ecc`), ip);
    execFileSync('cp', [join(config.acmeHome, `${ip}_ecc`, 'fullchain.pem'), join(config.acmeHome, `${ip}_ecc`, 'fullchain.cer')]);
    execFileSync('cp', [join(config.acmeHome, `${ip}_ecc`, 'key.pem'), join(config.acmeHome, `${ip}_ecc`, `${ip}.key`)]);
  };
  const certs = createCerts({ store, config, now: () => t, run });
  const settle = async () => {
    for (let i = 0; i < 100 && !certs.idle(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  certs.seen('10.0.0.1'); // private: ignored
  certs.seen('45.76.1.2');
  certs.seen('45.76.1.2');
  await settle();
  assert.deepEqual(calls, ['45.76.1.2']);
  assert.ok(certs.context('45.76.1.2'));
  assert.equal(certs.status('45.76.1.2'), 'ok');
  certs.seen('45.76.1.2');
  await settle();
  assert.equal(calls.length, 1, 'valid certificate: no new order');

  certs.seen('9.9.9.9');
  await settle();
  assert.equal(certs.status('9.9.9.9'), 'failed');
  certs.seen('9.9.9.9');
  await settle();
  assert.equal(calls.filter((c) => c === '9.9.9.9').length, 1, 'backs off after a failure');

  certs.seen('1.1.1.1'); // third attempt this hour
  certs.seen('1.0.0.1'); // over the limit
  await settle();
  assert.ok(!calls.includes('1.0.0.1'));

  t += 8 * 86400_000; // mirrors silent for longer than MIRROR_DAYS
  certs.renewAll();
  assert.equal(store.mirrors().length, 0);
  assert.equal(certs.context('45.76.1.2'), null);
});

test('ACME port serves challenges and check-ins, nothing else', async () => {
  const base = mkdtempSync(join(tmp, 'acme-'));
  const config = loadConfig({ DATA_DIR: base });
  mkdirSync(join(config.webroot, '.well-known', 'acme-challenge'), { recursive: true });
  writeFileSync(join(config.webroot, '.well-known', 'acme-challenge', 'tok_abcdefghij'), 'tok.thumb');
  const seen = [];
  const server = http.createServer(createAcmeHandler({ certs: { seen: (ip) => seen.push(ip), status: () => 'pending' }, config }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const r1 = await fetch(`${url}/.well-known/acme-challenge/tok_abcdefghij`);
  assert.equal(await r1.text(), 'tok.thumb');
  assert.equal((await fetch(`${url}/.well-known/acme-challenge/../../x`)).status, 404);
  const hello = await (await fetch(`${url}/.well-known/end-gfw-chat/hello`)).json();
  assert.equal(hello.ip, '127.0.0.1');
  assert.deepEqual(seen, ['127.0.0.1']);
  assert.equal((await fetch(`${url}/chat`)).status, 404);
  server.close();
});

// ---- invite link backups ---------------------------------------------------------------------

test('chat addresses for invite links: site, mirror nodes, relays; junk dropped; last good list kept', async () => {
  let up = true;
  const replies = {
    '/api/share/mirrors': { mirrors: ['https://1.2.3.4', 'https://5.6.7.8', 'http://9.9.9.9', 'https://evil.example', 'nope'], site: ['https://end-gfw.com'] },
    '/api/chat-mirrors': { mirrors: [{ url: 'https://1.2.3.4:8443/chat', region: '首尔' }, { url: 'https://1.2.3.4:9999/chat' }, { url: 'javascript:alert(1)' }] },
  };
  const fetchImpl = async (url) => {
    if (!up) throw new Error('down');
    const path = new URL(url).pathname;
    return new Response(JSON.stringify(replies[path]), { status: 200 });
  };
  const e = createEntries({ siteUrl: 'https://end-gfw.com/', fetchImpl });
  assert.deepEqual(e.list(), [{ url: 'https://end-gfw.com/chat', label: '主站' }], 'before the first refresh');
  await e.refresh();
  assert.deepEqual(e.list(), [
    { url: 'https://end-gfw.com/chat', label: '主站' },
    { url: 'https://1.2.3.4/chat', label: '镜像 首尔' },
    { url: 'https://5.6.7.8/chat', label: '镜像 5.6.7.8' },
    { url: 'https://1.2.3.4:8443/chat', label: '直连 首尔' },
  ]);
  up = false;
  await assert.rejects(e.refresh());
  assert.equal(e.list().length, 4, 'kept');
  assert.deepEqual(createEntries({ siteUrl: '' }).list(), []);
});

// ---- the service -----------------------------------------------------------------------------

let store, app, web, edge, base, tlsPort, config, clock;
const POW_BITS = 4;

before(async () => {
  const dir = mkdtempSync(join(tmp, 'app-'));
  config = loadConfig({ DATA_DIR: dir, POW_BITS_CREATE: String(POW_BITS), SEND_BURST: '5', MAX_ROOM_MESSAGES: '3', MAX_TTL_SECONDS: '3600', POLL_WAIT_SECONDS: '1' });
  store = openStore(join(dir, 'chat.db'));
  clock = { off: 0 };
  app = createApp({ store, config, entries: { list: () => [{ url: 'https://end-gfw.com/chat', label: '主站' }] }, now: () => Date.now() + clock.off });
  web = http.createServer(app.handler);
  web.on('upgrade', app.upgrade);
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${web.address().port}`;
  // TLS edge with a certificate for 127.0.0.1 (the "mirror" address in these tests)
  selfSigned(join(config.certDir, '127.0.0.1'), '127.0.0.1');
  const certs = createCerts({ store, config, run: async () => assert.fail('no issuance in tests') });
  edge = createEdge({ httpServer: web, certs, config });
  await new Promise((r) => edge.listen(0, '127.0.0.1', r));
  tlsPort = edge.address().port;
});

after(() => {
  for (const ws of app?.wss.clients || []) ws.terminate();
  web?.close();
  edge?.close();
  store?.close();
});

async function solvedPow() {
  const { challenge, bits } = await (await fetch(`http://${base}/chat/api/pow`)).json();
  return C.proofOfWork(challenge, bits);
}

async function makeRoom() {
  const room = C.newRoomId();
  const key = C.randomBytes(32);
  const owner = C.randomBytes(32);
  const { aes, auth } = await C.roomKeys(key);
  const meta = await C.seal(aes, room, 'meta', { name: '测试', ttl: 60 });
  const res = await fetch(`http://${base}/chat/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: room, auth: await C.sha256b64(auth), owner: await C.sha256b64(owner), meta: C.b64url(meta), pow: await solvedPow() }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return { room, key, owner, aes, auth };
}

// A WebSocket client that collects what it receives
function client(url = `ws://${base}/chat/ws`, opts = {}) {
  const ws = new WebSocket(url, opts);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
  });
  const next = (pred, ms = 3000) => {
    const found = inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timeout waiting; got ${JSON.stringify(inbox.slice(-3))}`)), ms);
    });
  };
  const opened = new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  return { ws, inbox, next, opened, closed, send: (o) => ws.send(JSON.stringify(o)) };
}

async function enter(r, extra) {
  const c = client(...(extra || []));
  await c.opened;
  c.send({ t: 'auth', room: r.room, token: C.b64url(r.auth) });
  await c.next((m) => m.t === 'ready');
  return c;
}

async function post(c, r, text, opts = {}) {
  const token = C.randomBytes(32);
  const ct = await C.seal(r.aes, r.room, 'msg', await C.makeMessage(r.room, null, 'n', text));
  const ref = Math.floor(Math.random() * 1e9);
  c.send({ t: 'send', ref, ct: C.b64url(ct), ttl: opts.ttl ?? 60, burn: opts.burn ?? 0, dh: await C.sha256b64(token) });
  const m = await c.next((x) => x.t === 'msg' && x.ref === ref);
  return { ...m, token };
}

test('page is served with a strict policy; unknown paths are 404', async () => {
  const res = await fetch(`http://${base}/chat`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  for (const p of ['/chat/assets/chat.js', '/chat/assets/chat-crypto.js', '/chat/assets/chat.css', '/chat/assets/qrcode.js']) assert.equal((await fetch(`http://${base}${p}`)).status, 200, p);
  assert.equal((await fetch(`http://${base}/chat/assets/../src/app.js`)).status, 404);
  assert.equal((await fetch(`http://${base}/`, { redirect: 'manual' })).headers.get('location'), '/chat');
  assert.deepEqual(await (await fetch(`http://${base}/chat/api/entries`)).json(), { entries: [{ url: 'https://end-gfw.com/chat', label: '主站' }] });
});

test('creating a room needs a fresh proof of work and well-formed fields', async () => {
  const room = C.newRoomId();
  const body = { id: room, auth: C.b64url(C.randomBytes(32)), owner: C.b64url(C.randomBytes(32)), meta: C.b64url(C.randomBytes(40)) };
  const postRoom = (b) => fetch(`http://${base}/chat/api/rooms`, { method: 'POST', body: JSON.stringify(b) });
  assert.equal((await postRoom({ ...body, pow: { challenge: 'x', nonce: '1' } })).status, 400);
  const pow = await solvedPow();
  assert.equal((await postRoom({ ...body, pow })).status, 400, 'meta must be a ciphertext blob');
  const meta = C.b64url(await C.seal((await C.roomKeys(C.randomBytes(32))).aes, room, 'meta', {}));
  const pow2 = await solvedPow();
  assert.equal((await postRoom({ ...body, meta, pow: pow2 })).status, 200);
  assert.equal((await postRoom({ ...body, meta, pow: pow2 })).status, 400, 'challenge used twice');
  assert.equal((await postRoom({ ...body, meta, pow: await solvedPow() })).status, 409, 'id taken');
  // wrong purpose / too few bits
  const weak = makeChallenge(Buffer.alloc(32), 'room', 1);
  assert.equal((await postRoom({ ...body, id: C.newRoomId(), meta, pow: { challenge: weak, nonce: '0' } })).status, 400);
});

test('only holders of the room key get in; the server holds ciphertext only', async () => {
  const r = await makeRoom();
  const bad = client();
  await bad.opened;
  bad.send({ t: 'auth', room: r.room, token: C.b64url(C.randomBytes(32)) });
  assert.equal((await bad.next((m) => m.t === 'error')).code, 'room');
  assert.equal(await bad.closed, 4000);

  const a = await enter(r);
  const b = await enter(r);
  await a.next((m) => m.t === 'online' && m.n === 2);
  const sent = await post(a, r, '机密内容 secret-marker');
  const got = await b.next((m) => m.t === 'msg' && m.id === sent.id);
  assert.equal(got.ref, undefined, 'ref only goes back to the sender');
  const plain = await C.open(r.aes, r.room, 'msg', C.fromB64url(got.ct));
  assert.equal(plain.x, '机密内容 secret-marker');

  // Nothing readable in the database
  store.checkpoint();
  const raw = readFileSync(join(config.dataDir, 'chat.db'));
  assert.equal(raw.indexOf(Buffer.from('secret-marker')), -1);
  assert.equal(raw.indexOf(Buffer.from('测试')), -1, 'room name is encrypted');

  // Late joiner gets the history
  const c = await enter(r);
  const ready = c.inbox.find((m) => m.t === 'ready');
  assert.equal(ready.msgs.length, 1);
  const meta = await C.open(r.aes, r.room, 'meta', C.fromB64url(ready.meta));
  assert.equal(meta.name, '测试');
  for (const x of [a, b, c]) x.ws.close();
});

test('撤回 needs the delete token; 阅后即焚 starts when someone reads; expiry deletes', async () => {
  const r = await makeRoom();
  const a = await enter(r);
  const b = await enter(r);
  const m1 = await post(a, r, 'one');
  b.send({ t: 'del', id: m1.id, token: C.b64url(C.randomBytes(32)) });
  assert.equal((await b.next((m) => m.t === 'error' && m.code === 'denied')).code, 'denied');
  a.send({ t: 'del', id: m1.id, token: C.b64url(m1.token) });
  await b.next((m) => m.t === 'del' && m.id === m1.id);
  assert.equal(store.getMessage(r.room, m1.id), undefined);

  const m2 = await post(a, r, 'burn', { ttl: 3600, burn: 10 });
  const t0 = Date.now();
  b.send({ t: 'read', ids: [m2.id] });
  const exp = await a.next((m) => m.t === 'exp' && m.id === m2.id);
  assert.ok(exp.exp <= t0 + 10_000 + 500 && exp.exp >= t0 + 9_000, 'counts down from the read');
  clock.off = 11_000;
  app.sweep();
  await a.next((m) => m.t === 'del' && m.id === m2.id);
  clock.off = 0;

  const m3 = await post(a, r, 'plain', { ttl: 10 });
  b.send({ t: 'read', ids: [m3.id] }); // not a burn message: no change
  clock.off = 11_000;
  app.sweep();
  await b.next((m) => m.t === 'del' && m.id === m3.id);
  clock.off = 0;
  a.ws.close();
  b.ws.close();
});

test('limits: ttl range, message size, rate, room size', async () => {
  const r = await makeRoom();
  const a = await enter(r);
  const ct = C.b64url(await C.seal(r.aes, r.room, 'msg', { x: 1 }));
  const dh = C.b64url(C.randomBytes(32));
  a.send({ t: 'send', ct, ttl: 7200, dh }); // over MAX_TTL_SECONDS
  assert.match((await a.next((m) => m.t === 'error')).message, /销毁时间/);
  a.inbox.length = 0;
  a.send({ t: 'send', ct: C.b64url(C.randomBytes(40)), ttl: 60, dh }); // not a blob
  assert.equal((await a.next((m) => m.t === 'error')).code, 'bad');
  a.inbox.length = 0;
  for (let i = 0; i < 6; i++) a.send({ t: 'send', ct, ttl: 60, dh });
  assert.equal((await a.next((m) => m.t === 'error' && m.code === 'slow')).code, 'slow');
  // MAX_ROOM_MESSAGES = 3: the oldest were dropped
  const b = await enter(r);
  assert.equal(b.inbox.find((m) => m.t === 'ready').msgs.length, 3);
  a.ws.close();
  b.ws.close();
});

test('only the owner token destroys a room, and everyone is told', async () => {
  const r = await makeRoom();
  const a = await enter(r);
  const b = await enter(r);
  await post(a, r, 'x');
  b.send({ t: 'destroy', owner: C.b64url(C.randomBytes(32)) });
  assert.equal((await b.next((m) => m.t === 'error')).code, 'denied');
  b.send({ t: 'destroy', owner: C.b64url(r.owner) });
  await a.next((m) => m.t === 'gone');
  assert.equal(await a.closed, 4010);
  assert.equal(store.getRoom(r.room), undefined);
  assert.equal(store.history(r.room, 0, Date.now(), 10).length, 0);
});

test('idle rooms are deleted', async () => {
  const r = await makeRoom();
  clock.off = (config.roomIdleDays + 1) * 86400_000;
  app.sweepRooms();
  clock.off = 0;
  assert.equal(store.getRoom(r.room), undefined);
});

test('TLS edge: through a PROXY header or without one, page and WebSocket work', async () => {
  const ca = readFileSync(join(config.certDir, '127.0.0.1', 'fullchain.pem'));
  for (const header of ['PROXY TCP4 198.51.100.7 127.0.0.1 40000 8443\r\n', '']) {
    const body = await new Promise((resolve, reject) => {
      const raw = net.connect(tlsPort, '127.0.0.1', () => {
        if (header) raw.write(header);
        const s = tls.connect({ socket: raw, ca, servername: undefined, checkServerIdentity: () => undefined }, () => {
          s.write('GET /chat/api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
        });
        let out = '';
        s.on('data', (d) => (out += d));
        s.on('end', () => resolve(out));
        s.on('error', reject);
      });
    });
    assert.match(body, /^HTTP\/1.1 200/);
    assert.match(body, /"ok":true/);
  }
  // WebSocket over the edge (no PROXY header), certificate checked against the test CA
  const r = await makeRoom();
  const c = await enter(r, [`wss://127.0.0.1:${tlsPort}/chat/ws`, { ca, checkServerIdentity: () => undefined }]);
  assert.ok(c.inbox.find((m) => m.t === 'ready'));
  c.ws.close();
  // Garbage instead of TLS / PROXY is dropped
  const dropped = await new Promise((resolve) => {
    const s = net.connect(tlsPort, '127.0.0.1', () => s.write('GET / HTTP/1.1\r\n\r\n'));
    s.on('close', () => resolve(true));
    s.on('error', () => {});
  });
  assert.ok(dropped);
});

test('transfer slots: proof of work, one download only, gone after 10 minutes', async () => {
  const upload = async (blob) => {
    const { challenge, bits } = await (await fetch(`http://${base}/chat/api/pow?for=transfer`)).json();
    assert.equal(bits, config.powBitsTransfer);
    return fetch(`http://${base}/chat/api/transfer`, { method: 'POST', body: JSON.stringify({ blob, pow: await C.proofOfWork(challenge, bits) }) });
  };
  const take = (id) => fetch(`http://${base}/chat/api/transfer/take`, { method: 'POST', body: JSON.stringify({ id }) });
  const { key, blob } = await V.sealTransfer({ rooms: [] });
  // a room challenge does not work for transfers
  const roomPow = await solvedPow();
  assert.equal((await fetch(`http://${base}/chat/api/transfer`, { method: 'POST', body: JSON.stringify({ blob: C.b64url(blob), pow: roomPow }) })).status, 400);
  assert.equal((await upload(C.b64url(C.randomBytes(64)))).status, 400, 'not a transfer blob');
  const res = await upload(C.b64url(blob));
  assert.equal(res.status, 200);
  const { id, exp } = await res.json();
  assert.ok(exp > Date.now() + 9 * 60_000);
  const got = await take(id);
  assert.equal(got.status, 200);
  assert.deepEqual(await V.openTransfer(key, C.fromB64url((await got.json()).blob)), { rooms: [] });
  assert.equal((await take(id)).status, 404, 'only once');
  const second = await (await upload(C.b64url(blob))).json();
  clock.off = 11 * 60_000;
  assert.equal((await take(second.id)).status, 404, 'expired');
  app.sweep();
  clock.off = 0;
  assert.equal(store.transferCount(), 0);
});

test('long polling: same room protocol as WebSockets, both directions', async () => {
  const api = async (path, body) => {
    const res = await fetch(`http://${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const r = await makeRoom();
  const bad = await api('/chat/api/poll/join', { room: r.room, token: C.b64url(C.randomBytes(32)) });
  assert.equal(bad.status, 404);
  assert.equal(bad.data.code, 'room');
  const j = await api('/chat/api/poll/join', { room: r.room, token: C.b64url(r.auth) });
  assert.equal(j.status, 200);
  assert.equal(j.data.ready.t, 'ready');
  const { cid } = j.data;
  assert.match(cid, /^[A-Za-z0-9]{16}$/);

  // the join's own online count is queued; after that, nothing new: the request is held, then
  // answered empty (POLL_WAIT_SECONDS = 1)
  assert.deepEqual((await api('/chat/api/poll', { cid })).data.events, [{ t: 'online', n: 1 }]);
  const t0 = Date.now();
  const empty = await api('/chat/api/poll', { cid });
  assert.ok(Date.now() - t0 >= 900);
  assert.deepEqual(empty.data.events, []);

  // a WebSocket member's message reaches the poller while its request is waiting
  const w = await enter(r);
  assert.deepEqual((await api('/chat/api/poll', { cid })).data.events, [{ t: 'online', n: 2 }]);
  const waiting = api('/chat/api/poll', { cid });
  await new Promise((res) => setTimeout(res, 100));
  const sent = await post(w, r, 'from websocket');
  const got = await waiting;
  assert.deepEqual(got.data.events.map((e) => [e.t, e.id, e.ref]), [['msg', sent.id, undefined]]);

  // the poller sends: the WebSocket member gets it, the poller's own copy carries its ref
  const ct = C.b64url(await C.seal(r.aes, r.room, 'msg', await C.makeMessage(r.room, null, 'p', 'from poll')));
  const act = await api('/chat/api/poll/act', { cid, t: 'send', ref: 7, ct, ttl: 60, dh: C.b64url(C.randomBytes(32)) });
  assert.deepEqual(act.data.events, []);
  const seen = await w.next((m) => m.t === 'msg' && m.ref === undefined && m.id > sent.id);
  const mine = await api('/chat/api/poll', { cid });
  assert.ok(mine.data.events.some((e) => e.t === 'msg' && e.id === seen.id && e.ref === 7));
  // errors come back to the poller only
  const denied = await api('/chat/api/poll/act', { cid, t: 'destroy', owner: C.b64url(C.randomBytes(32)) });
  assert.equal(denied.data.events[0].code, 'denied');

  // destroying the room reaches the poller, then its id is gone
  w.send({ t: 'destroy', owner: C.b64url(r.owner) });
  const gone = await api('/chat/api/poll', { cid });
  assert.ok(gone.data.events.some((e) => e.t === 'gone'));
  assert.equal((await api('/chat/api/poll', { cid })).status, 404);
});

test('long polling: a client that stops asking is dropped from the room', async () => {
  const r = await makeRoom();
  const w = await enter(r);
  const j = await (await fetch(`http://${base}/chat/api/poll/join`, { method: 'POST', body: JSON.stringify({ room: r.room, token: C.b64url(r.auth) }) })).json();
  await w.next((m) => m.t === 'online' && m.n === 2);
  clock.off = 61_000;
  app.heartbeat();
  clock.off = 0;
  await w.next((m) => m.t === 'online' && m.n === 1);
  assert.equal((await fetch(`http://${base}/chat/api/poll`, { method: 'POST', body: JSON.stringify({ cid: j.cid }) })).status, 404);
  w.ws.close();
});

test('store: expired messages and spent challenges are purged', () => {
  const s = openStore(':memory:');
  s.addRoom({ id: 'a'.repeat(16), authHash: Buffer.alloc(32), ownerHash: Buffer.alloc(32), meta: Buffer.alloc(40), now: 1 });
  s.addMessage('a'.repeat(16), { ts: 1, exp: 100, burn: 0, delHash: Buffer.alloc(32), ct: Buffer.alloc(40) }, 10);
  s.addMessage('a'.repeat(16), { ts: 1, exp: 300, burn: 0, delHash: Buffer.alloc(32), ct: Buffer.alloc(40) }, 10);
  assert.ok(s.usePow(Buffer.from('h'), 150));
  assert.ok(!s.usePow(Buffer.from('h'), 150));
  assert.deepEqual(s.purgeExpired(200), [{ room: 'a'.repeat(16), id: 1 }]);
  assert.equal(s.history('a'.repeat(16), 0, 200, 10).length, 1);
  assert.ok(s.usePow(Buffer.from('h'), 150), 'spent challenge forgotten after it expired');
  s.close();
});
