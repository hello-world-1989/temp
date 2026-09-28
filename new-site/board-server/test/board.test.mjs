// End-to-end tests against a real PostgreSQL (DATABASE_URL); each run uses its own schema.
//   DATABASE_URL=postgres://board:devpass@127.0.0.1/board npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApp, cleanup, cleanText, cleanDate, rid } from '../src/app.js';
import { parseAdmins } from '../src/config.js';
import { leadingZeroBits, checkPow, makeChallenge } from '../src/pow.js';

pg.types.setTypeParser(1082, (v) => v);

const KEY = 'k'.repeat(40);
const ADMIN_TOKEN = 'admin-token-for-tests';
const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';

let db, server, base, filesDir, config, events;
const schema = `t_${rid(8).toLowerCase()}`;

before(async () => {
  if (skip) return;
  const setup = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await setup.connect();
  await setup.query(`create schema ${schema}`);
  await setup.end();
  db = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  await db.query(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  filesDir = mkdtempSync(join(tmpdir(), 'board-files-'));
  config = {
    boardKey: KEY,
    admins: parseAdmins(`alice:${createHash('sha256').update(ADMIN_TOKEN).digest('hex')}`),
    filesDir,
    siteUrl: 'https://example.test',
    maxImages: 2,
    maxImageBytes: 100_000,
    diskQuotaBytes: 1e9,
    maxDrafts: 50,
    maxPendingPosts: 50,
    maxPendingComments: 50,
    powBits: { post: 6, comment: 5, report: 4 },
    commentPremod: true,
    purgeDays: 7,
  };
  events = [];
  const publisher = {
    published: async (p) => events.push(['published', p.id]),
    unpublished: async (id) => events.push(['unpublished', id]),
    queued: async (kind, n) => events.push(['queued', kind, n]),
  };
  server = http.createServer(createApp({ db, config, publisher }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (skip) return;
  server.close();
  await db.query(`drop schema ${schema} cascade`);
  await db.end();
  rmSync(filesDir, { recursive: true, force: true });
});

async function call(method, path, { body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-board-key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

function solve(challenge, bits) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(36);
    if (leadingZeroBits(createHash('sha256').update(challenge + nonce).digest()) >= bits) return nonce;
  }
}
async function pow(purpose) {
  const { data } = await call('GET', `/api/board/pow?for=${purpose}`);
  return { challenge: data.challenge, nonce: solve(data.challenge, data.bits) };
}

// A tiny JPEG with an EXIF segment (carrying a fake GPS marker) and trailing bytes
function jpegWithExif() {
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('MM\0*\0\0\0\x08\0\0GPS-SECRET', 'latin1')]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const sos = Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0x56, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sos, Buffer.from('TRAILER-SECRET')]);
}

async function submit(fields = {}, images = []) {
  const d = await call('POST', '/api/board/drafts', { body: { pow: await pow('post') } });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  const dk = { 'x-draft-key': d.data.draftKey };
  const ids = [];
  for (const img of images) {
    const r = await call('PUT', `/api/board/drafts/${d.data.draftId}/images`, { raw: img, headers: { ...dk, 'Content-Type': 'image/jpeg' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    ids.push(r.data.imageId);
  }
  const s = await call('POST', `/api/board/drafts/${d.data.draftId}/submit`, {
    headers: dk,
    body: { title: '某地发生的事', body: '这是一段足够长的事件描述，写清楚发生了什么。', category: '维权', place: '某市', happenedOn: '2026-09-20', ...fields },
  });
  return { ...s, draft: d.data, imageIds: ids };
}

test('text cleaning', () => {
  assert.equal(cleanText(' a‮b\u0000c ', 10), 'abc');
  assert.equal(cleanText('a\r\n\r\n\r\n\r\nb', 10, { multiline: true }), 'a\n\nb');
  assert.equal(cleanText('a\nb', 10), 'a b');
  assert.throws(() => cleanText('', 10, { required: true }), /请填写/);
  assert.throws(() => cleanText('一二三', 2), /不能超过 2/);
  assert.equal(cleanDate('2026-02-28'), '2026-02-28');
  assert.throws(() => cleanDate('2026-02-30'));
  assert.throws(() => cleanDate('2999-01-01'));
});

test('proof of work', () => {
  const secret = Buffer.from('s');
  const c = makeChallenge(secret, 'post', 8);
  const nonce = solve(c, 8);
  assert.equal(checkPow(secret, 'post', 8, { challenge: c, nonce }).ok, true);
  assert.equal(checkPow(secret, 'comment', 8, { challenge: c, nonce }).ok, false); // other purpose
  assert.equal(checkPow(secret, 'post', 9, { challenge: c, nonce }).ok, false); // too easy
  assert.equal(checkPow(Buffer.from('x'), 'post', 8, { challenge: c, nonce }).ok, false); // forged
  assert.equal(checkPow(secret, 'post', 8, { challenge: c, nonce }, Date.now() + 11 * 60e3).error, 'expired');
});

test('requests without the Worker key are refused', { skip }, async () => {
  const r = await fetch(`${base}/api/board/meta`);
  assert.equal(r.status, 403);
  const w = await fetch(`${base}/api/board/meta`, { headers: { 'x-board-key': 'wrong' } });
  assert.equal(w.status, 403);
});

test('submit, review, publish, comment, withdraw', { skip }, async () => {
  const s = await submit({}, [jpegWithExif()]);
  assert.equal(s.status, 201, JSON.stringify(s.data));
  const { postId, receipt } = s.data;

  // Metadata and trailing data are gone from the stored file
  const stored = readFileSync(join(filesDir, s.imageIds[0]));
  assert.equal(stored.includes('GPS-SECRET'), false);
  assert.equal(stored.includes('TRAILER-SECRET'), false);
  assert.deepEqual([...stored.subarray(0, 2)], [0xff, 0xd8]);

  // Pending: not public, image not public, visible to its author by receipt
  assert.equal((await call('GET', `/api/board/posts/${postId}`)).status, 404);
  assert.equal((await call('GET', `/api/board/img/${s.imageIds[0]}`)).status, 404);
  assert.equal((await call('GET', '/api/board/posts')).data.items.length, 0);
  const st = await call('POST', '/api/board/status', { body: { receipt } });
  assert.equal(st.data.status, 'pending');
  assert.deepEqual(events.at(-1), ['queued', 'post', 1]);

  // Admin: needs a token; sees the queue and the image
  assert.equal((await call('GET', '/api/board/admin/queue')).status, 401);
  assert.equal((await call('GET', '/api/board/admin/queue', { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const q = await call('GET', '/api/board/admin/queue', { headers: admin });
  assert.equal(q.data.items.length, 1);
  assert.equal(q.data.items[0].id, postId);
  assert.equal((await call('GET', `/api/board/admin/img/${s.imageIds[0]}`, { headers: admin })).status, 200);

  // Edit + approve in one go: publishes, exports, logs
  const ap = await call('POST', `/api/board/admin/posts/${postId}`, { headers: admin, body: { action: 'approve', place: '某省某市' } });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.equal(ap.data.status, 'published');
  assert.equal(ap.data.place, '某省某市');
  assert.equal(ap.data.edited, false); // edits before publishing are not flagged
  assert.deepEqual(events.at(-1), ['published', postId]);
  const pub = await call('GET', `/api/board/posts/${postId}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.data.happenedOn, '2026-09-20');
  assert.equal(pub.data.images.length, 1);
  assert.equal(pub.data.status, undefined); // no admin fields in public JSON
  const img = await call('GET', `/api/board/img/${s.imageIds[0]}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  const list = await call('GET', '/api/board/posts');
  assert.equal(list.data.items[0].id, postId);
  assert.equal(list.data.items[0].cover, s.imageIds[0]);

  // Comments wait for review
  const c = await call('POST', `/api/board/posts/${postId}/comments`, { body: { body: '我也在现场', nickname: '路人', pow: await pow('comment') } });
  assert.equal(c.status, 201);
  assert.equal(c.data.status, 'pending');
  assert.equal((await call('GET', `/api/board/posts/${postId}`)).data.comments.length, 0);
  const cq = await call('GET', '/api/board/admin/queue?type=comments', { headers: admin });
  assert.equal(cq.data.items[0].postTitle, '某地发生的事');
  assert.equal((await call('POST', `/api/board/admin/comments/${c.data.commentId}`, { headers: admin, body: { action: 'approve' } })).status, 200);
  const withComment = await call('GET', `/api/board/posts/${postId}`);
  assert.equal(withComment.data.comments[0].body, '我也在现场');

  // A challenge works once
  const p = await pow('comment');
  assert.equal((await call('POST', `/api/board/posts/${postId}/comments`, { body: { body: 'x1', pow: p } })).status, 201);
  assert.equal((await call('POST', `/api/board/posts/${postId}/comments`, { body: { body: 'x2', pow: p } })).status, 409);

  // Reports show up in the admin queue
  assert.equal((await call('POST', '/api/board/report', { body: { target: 'post', id: postId, pow: await pow('report') } })).status, 200);
  const rq = await call('GET', '/api/board/admin/queue?status=reported', { headers: admin });
  assert.equal(rq.data.items[0].reports, 1);

  // Editing after publishing is flagged
  const ed = await call('POST', `/api/board/admin/posts/${postId}`, { headers: admin, body: { action: 'edit', title: '新标题' } });
  assert.equal(ed.data.edited, true);

  // The author withdraws: gone from the site, files deleted, export removed
  assert.equal((await call('POST', '/api/board/withdraw', { body: { receipt } })).status, 200);
  assert.equal((await call('GET', `/api/board/posts/${postId}`)).status, 404);
  assert.equal(readdirSync(filesDir).length, 0);
  assert.deepEqual(events.at(-1), ['unpublished', postId]);

  const log = await call('GET', '/api/board/admin/log', { headers: admin });
  assert.deepEqual(log.data.items.map((i) => i.action).reverse(), ['edit', 'approve', 'approve', 'edit']);
  assert.equal(log.data.items[0].admin, 'alice');
});

test('rejecting shows the reason to the author; purge deletes it later', { skip }, async () => {
  const s = await submit({ title: '会被拒绝的' }, [jpegWithExif()]);
  const r = await call('POST', `/api/board/admin/posts/${s.data.postId}`, { headers: admin, body: { action: 'reject', reason: '无法核实' } });
  assert.equal(r.data.status, 'rejected');
  const st = await call('POST', '/api/board/status', { body: { receipt: s.data.receipt } });
  assert.equal(st.data.rejectReason, '无法核实');
  await db.query("update posts set updated_at = now() - interval '8 days' where id = $1", [s.data.postId]);
  const res = await cleanup(db, config);
  assert.equal(res.posts, 1);
  assert.equal((await call('POST', '/api/board/status', { body: { receipt: s.data.receipt } })).status, 404);
  assert.equal(readdirSync(filesDir).length, 0);
});

test('draft limits and validation', { skip }, async () => {
  const d = await call('POST', '/api/board/drafts', { body: { pow: await pow('post') } });
  const dk = { 'x-draft-key': d.data.draftKey };
  const put = (raw) => call('PUT', `/api/board/drafts/${d.data.draftId}/images`, { raw, headers: dk });
  assert.equal((await put(Buffer.from('<html>not an image'))).status, 415);
  assert.equal((await put(Buffer.alloc(200_000, 1))).status, 413);
  assert.equal((await put(jpegWithExif())).status, 201);
  const second = await put(jpegWithExif());
  assert.equal(second.status, 201);
  assert.equal((await put(jpegWithExif())).status, 400); // maxImages 2
  assert.equal((await call('DELETE', `/api/board/drafts/${d.data.draftId}/images/${second.data.imageId}`, { headers: dk })).status, 200);
  // Wrong draft key
  assert.equal((await call('PUT', `/api/board/drafts/${d.data.draftId}/images`, { raw: jpegWithExif(), headers: { 'x-draft-key': 'x' } })).status, 404);
  // Missing or too short body
  const bad = await call('POST', `/api/board/drafts/${d.data.draftId}/submit`, { headers: dk, body: { title: 't', body: '短' } });
  assert.equal(bad.status, 400);
  // No proof of work, no draft
  assert.equal((await call('POST', '/api/board/drafts', { body: {} })).status, 400);
});

test('list paging', { skip }, async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const s = await submit({ title: `分页 ${i}` });
    await call('POST', `/api/board/admin/posts/${s.data.postId}`, { headers: admin, body: { action: 'approve' } });
    ids.push(s.data.postId);
  }
  const p1 = await call('GET', '/api/board/posts?limit=2');
  assert.equal(p1.data.items.length, 2);
  assert.ok(p1.data.nextCursor);
  const p2 = await call('GET', `/api/board/posts?limit=2&cursor=${p1.data.nextCursor}`);
  const seen = [...p1.data.items, ...p2.data.items].map((i) => i.id);
  for (const id of ids) assert.ok(seen.includes(id));
  assert.equal(new Set(seen).size, seen.length);
  const cat = await call('GET', `/api/board/posts?category=${encodeURIComponent('抗议')}`);
  assert.equal(cat.data.items.length, 0);
});
