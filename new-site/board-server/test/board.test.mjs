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
import sharp from 'sharp';
import { createApp, cleanup, cleanText, cleanDate, rid } from '../src/app.js';
import { parseAdmins, tgAdmins } from '../src/config.js';
import { leadingZeroBits, checkPow, makeChallenge } from '../src/pow.js';
import { createTelegram, REASONS } from '../src/telegram.js';

pg.types.setTypeParser(1082, (v) => v);

const KEY = 'k'.repeat(40);
const ADMIN_TOKEN = 'admin-token-for-tests';
const skip = !process.env.DATABASE_URL && 'DATABASE_URL not set';

let db, server, base, filesDir, config, events, app, tgBot;
const schema = `t_${rid(8).toLowerCase()}`;

before(async () => {
  photo = await makePhoto();
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
    queued: async (kind, n, id) => {
      events.push(['queued', kind, n]);
      await tgBot?.queued(kind, n, id);
    },
    changed: async (kind, id, info) => tgBot?.changed(kind, id, info),
  };
  app = createApp({ db, config, publisher });
  server = http.createServer(app);
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

// Real photos made with sharp: EXIF with the phone model and GPS, an ICC profile, and extra
// bytes after the image (like a phone's depth map). Solid colours keep them small.
let photo;
async function makePhoto({ width = 640, height = 480, orientation } = {}) {
  const exif = { IFD0: { Model: 'SECRET-PHONE-MODEL', Make: 'SECRET-MAKER' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '39/1 54/1 30/1' } };
  const img = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 90, b: 40 } } })
    .withExif(exif)
    .withMetadata(orientation ? { orientation } : {})
    .withIccProfile('p3')
    .jpeg({ quality: 90 })
    .toBuffer();
  return Buffer.concat([img, Buffer.from('TRAILER-SECRET')]);
}
const jpegWithExif = () => photo;

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

test('telegram reviewers', () => {
  assert.deepEqual([...tgAdmins('bob:42, eve:x, :7,carol:1234567')], [['42', 'bob'], ['1234567', 'carol']]);
  assert.deepEqual([...tgAdmins('', '42')], [['42', 'telegram']]); // private chat: its own reviewer
  assert.equal(tgAdmins('', '-1001').size, 0); // group: must be listed
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
  assert.equal(stored.includes('SECRET-PHONE-MODEL'), false);
  assert.equal(stored.includes('SECRET-MAKER'), false);
  assert.equal(stored.includes('TRAILER-SECRET'), false);
  assert.deepEqual([...stored.subarray(0, 2)], [0xff, 0xd8]);
  const m = await sharp(stored).metadata();
  assert.equal(m.exif, undefined);
  assert.equal(m.icc, undefined);
  assert.equal(m.xmp, undefined);
  assert.equal(m.format, 'jpeg');

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

test('images are resized, rotated upright and re-encoded', { skip }, async () => {
  const d = await call('POST', '/api/board/drafts', { body: { pow: await pow('post') } });
  const dk = { 'x-draft-key': d.data.draftKey };
  const put = (raw) => call('PUT', `/api/board/drafts/${d.data.draftId}/images`, { raw, headers: dk });

  const big = await put(await makePhoto({ width: 4000, height: 3000 }));
  assert.equal(big.status, 201, JSON.stringify(big.data));
  const bigMeta = await sharp(readFileSync(join(filesDir, big.data.imageId))).metadata();
  assert.deepEqual([bigMeta.width, bigMeta.height], [2048, 1536]);

  // Orientation 6 = rotate 90 degrees: stored upright, with no orientation tag left
  const turned = await put(await makePhoto({ width: 400, height: 200, orientation: 6 }));
  assert.equal(turned.status, 201, JSON.stringify(turned.data));
  const tMeta = await sharp(readFileSync(join(filesDir, turned.data.imageId))).metadata();
  assert.deepEqual([tMeta.width, tMeta.height, tMeta.orientation], [200, 400, undefined]);

  // Small images are not enlarged; PNG stays PNG (new draft: the test limit is 2 images)
  const d2 = await call('POST', '/api/board/drafts', { body: { pow: await pow('post') } });
  const put2 = (raw) => call('PUT', `/api/board/drafts/${d2.data.draftId}/images`, { raw, headers: { 'x-draft-key': d2.data.draftKey } });
  const png = await sharp({ create: { width: 300, height: 100, channels: 4, background: '#08f' } }).png().toBuffer();
  const p = await put2(png);
  assert.equal(p.status, 201);
  assert.equal(p.data.type, 'image/png');
  const pMeta = await sharp(readFileSync(join(filesDir, p.data.imageId))).metadata();
  assert.deepEqual([pMeta.format, pMeta.width, pMeta.height], ['png', 300, 100]);
});

test('view counts', { skip }, async () => {
  const s = await submit({ title: '浏览次数' });
  const id = s.data.postId;
  // Views of a post that is not published are not counted
  assert.equal((await call('POST', `/api/board/posts/${id}/view`)).status, 202);
  await app.flushViews();
  await call('POST', `/api/board/admin/posts/${id}`, { headers: admin, body: { action: 'approve' } });
  assert.equal((await call('GET', `/api/board/posts/${id}`)).data.views, 0);
  for (let i = 0; i < 3; i++) await call('POST', `/api/board/posts/${id}/view`);
  assert.equal(await app.flushViews(), 1);
  assert.equal((await call('GET', `/api/board/posts/${id}`)).data.views, 3);
  const list = await call('GET', '/api/board/posts');
  assert.equal(list.data.items.find((i) => i.id === id).views, 3);
  assert.equal(await app.flushViews(), 0); // nothing pending
  assert.equal((await call('POST', '/api/board/posts/../view')).status, 404);
});

// A fake Telegram API: records every call, answers like the real one
function fakeTelegram() {
  const calls = [];
  let next = 100;
  const fetchImpl = async (url, { body, signal }) => {
    const method = url.split('/').pop();
    assert.match(url, /^https:\/\/api\.telegram\.org\/botTEST-TOKEN\//);
    const data = body instanceof FormData ? Object.fromEntries(body.entries()) : JSON.parse(body);
    calls.push({ method, data });
    const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
    if (method === 'getUpdates') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    if (method === 'getMe') return ok({ id: 999, is_bot: true });
    if (method === 'sendMessage' || method === 'sendPhoto') return ok({ message_id: next++ });
    if (method === 'sendMediaGroup') return ok(JSON.parse(data.media).map(() => ({ message_id: next++ })));
    return ok(true);
  };
  return { calls, fetchImpl };
}
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('review in Telegram', { skip }, async () => {
  const tgApi = fakeTelegram();
  const tgConfig = { ...config, telegram: { token: 'TEST-TOKEN', chatId: '-1001', admins: new Map([['42', 'bob']]) } };
  tgBot = createTelegram({ config: tgConfig, db, review: app.review, fetchImpl: tgApi.fetchImpl, log: { error() {} } });
  const running = tgBot.start();
  await until(() => tgApi.calls.some((c) => c.method === 'getUpdates'));
  const chat = { id: -1001, type: 'supergroup' };
  const since = () => tgApi.calls.length;
  const after = (n, method) => tgApi.calls.slice(n).filter((c) => c.method === method);
  const press = (data, message_id, from = 42) => tgBot.onUpdate({ update_id: 1, callback_query: { id: 'q', from: { id: from }, data, message: { message_id, chat } } });
  try {
    // New post with a photo: photo (spoiler) and text with buttons, no forwarding, no receipt
    let n = since();
    const s = await submit({ title: '电报审核测试', body: '这是一段发给审核群的事件描述。' }, [jpegWithExif()]);
    const { postId } = s.data;
    const main = await until(() => after(n, 'sendMessage').find((c) => c.data.text.includes(postId)));
    const photo = after(n, 'sendPhoto')[0];
    assert.equal(photo.data.has_spoiler, 'true');
    assert.equal(photo.data.protect_content, 'true');
    assert.equal(main.data.chat_id, '-1001');
    assert.equal(main.data.protect_content, true);
    assert.match(main.data.text, /电报审核测试/);
    assert.match(main.data.text, /这是一段发给审核群的事件描述/);
    assert.equal(main.data.text.includes(s.data.receipt), false);
    assert.deepEqual(main.data.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`p:${postId}:a`, `p:${postId}:r`]);
    const mainId = Number((await db.query("select message_id from tg_messages where target = $1 and main", [`post:${postId}`])).rows[0].message_id);

    // Someone who is not a reviewer cannot decide
    n = since();
    await press(`p:${postId}:a`, mainId, 7);
    assert.match(after(n, 'answerCallbackQuery')[0].data.text, /没有审核权限/);
    assert.equal((await app.review.getPost(postId)).status, 'pending');

    // Reject with a preset reason: logged as the reviewer; the content leaves the chat
    await press(`p:${postId}:r`, mainId);
    n = since();
    await press(`p:${postId}:r0`, mainId);
    const rejected = await app.review.getPost(postId);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectReason, REASONS[0]);
    assert.equal((await db.query("select admin from mod_log where target = $1 order by id desc limit 1", [`post:${postId}`])).rows[0].admin, 'tg:bob');
    const edit = await until(() => after(n, 'editMessageText')[0]);
    assert.equal(edit.data.message_id, mainId);
    assert.match(edit.data.text, /已拒绝（tg:bob）/);
    assert.equal(edit.data.text.includes('电报审核测试'), false);
    assert.equal(edit.data.text.includes('事件描述'), false);
    assert.equal(after(n, 'deleteMessage').length, 1); // the photo
    assert.equal((await db.query('select count(*)::int as n from tg_messages where target = $1', [`post:${postId}`])).rows[0].n, 0);

    // A second press on an old message changes nothing
    n = since();
    await press(`p:${postId}:a`, mainId);
    assert.match(after(n, 'answerCallbackQuery')[0].data.text, /已经处理过了/);
    assert.equal((await app.review.getPost(postId)).status, 'rejected');

    // Reason written by the reviewer, as a reply to the bot's prompt
    n = since();
    const s2 = await submit({ title: '第二条' });
    const main2 = await until(() => after(n, 'sendMessage').find((c) => c.data.text.includes(s2.data.postId)));
    n = since();
    await press(`p:${s2.data.postId}:rc`, 1);
    const prompt = after(n, 'sendMessage')[0];
    assert.equal(prompt.data.reply_markup.force_reply, true);
    await tgBot.onUpdate({ update_id: 2, message: { message_id: 555, chat, from: { id: 42 }, text: '请补充照片', reply_to_message: { from: { id: 999 }, text: prompt.data.text } } });
    assert.equal((await app.review.getPost(s2.data.postId)).rejectReason, '请补充照片');
    assert.ok(main2);

    // Approve: the message keeps title and public link
    n = since();
    const s3 = await submit({ title: '第三条' });
    await until(() => after(n, 'sendMessage').find((c) => c.data.text.includes(s3.data.postId)));
    n = since();
    await press(`p:${s3.data.postId}:a`, 1);
    assert.equal((await app.review.getPost(s3.data.postId)).status, 'published');
    const ok = await until(() => after(n, 'editMessageText')[0]);
    assert.match(ok.data.text, new RegExp(`已通过.*\\n第三条\\nhttps://example.test/board/e/${s3.data.postId}`));

    // Comments: sent with buttons, rejected from Telegram
    n = since();
    const c = await call('POST', `/api/board/posts/${s3.data.postId}/comments`, { body: { body: '电报评论', nickname: '某人', pow: await pow('comment') } });
    const cm = await until(() => after(n, 'sendMessage').find((x) => x.data.text.includes(c.data.commentId)));
    assert.match(cm.data.text, /电报评论/);
    n = since();
    await press(`c:${c.data.commentId}:x`, 1);
    assert.equal((await app.review.getComment(c.data.commentId)).status, 'rejected');
    const ce = await until(() => after(n, 'editMessageText')[0]);
    assert.equal(ce.data.text.includes('电报评论'), false);

    // Decided on the web page, or withdrawn by the author: the chat follows
    n = since();
    const s4 = await submit({ title: '第四条' });
    await until(() => after(n, 'sendMessage').find((x) => x.data.text.includes(s4.data.postId)));
    n = since();
    await call('POST', '/api/board/withdraw', { body: { receipt: s4.data.receipt } });
    const we = await until(() => after(n, 'editMessageText')[0]);
    assert.match(we.data.text, /作者撤回/);
    assert.equal(we.data.text.includes('第四条'), false);

    n = since();
    const s5 = await submit({ title: '第五条' });
    await until(() => after(n, 'sendMessage').find((x) => x.data.text.includes(s5.data.postId)));
    n = since();
    await call('POST', `/api/board/admin/posts/${s5.data.postId}`, { headers: admin, body: { action: 'reject', reason: '不实' } });
    assert.match((await until(() => after(n, 'editMessageText')[0])).data.text, /已拒绝（alice）/);

    // /pending sends the queue again
    n = since();
    const s6 = await submit({ title: '第六条' });
    await until(() => after(n, 'sendMessage').find((x) => x.data.text.includes(s6.data.postId)));
    n = since();
    await tgBot.onUpdate({ update_id: 3, message: { message_id: 556, chat, from: { id: 42 }, text: '/pending' } });
    assert.ok(after(n, 'sendMessage').some((x) => x.data.text.includes(s6.data.postId)));
    assert.ok(after(n, 'deleteMessage').length >= 1); // the old copy
  } finally {
    tgBot.stop();
    await running;
    tgBot = undefined;
  }
});
