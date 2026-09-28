// 事件墙 API. Mounted under /api/board/ on the site's Worker, which adds the shared key
// (x-board-key) and forwards nothing that identifies the visitor. Everything here is
// written so that the database never holds IP addresses, user agents or accounts.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, unlink, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kindOf, stripJpeg, stripPng, stripWebp } from '../../public/assets/share-meta.js';
import { CATEGORIES } from './config.js';
import { checkPow, makeChallenge } from './pow.js';

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const STRIP = { jpeg: stripJpeg, png: stripPng, webp: stripWebp };
const LIMITS = { title: 80, body: 5000, place: 60, nickname: 20, comment: 1000, reason: 200 };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function rid(n) {
  const bytes = randomBytes(n * 2);
  let out = '';
  for (let i = 0; out.length < n && i < bytes.length; i++) {
    if (bytes[i] < 224) out += ALPHABET[bytes[i] % 56]; // 224 = 4 * 56, no modulo bias
  }
  return out.length === n ? out : rid(n);
}

const sha256 = (s) => createHash('sha256').update(s).digest();
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9]{8,32}$/.test(s);

// Plain text only: control characters and bidi overrides removed, NFC, trimmed, length in
// characters. Pages render it with textContent, so no markup is ever interpreted.
export function cleanText(value, max, { multiline = false, required = false, label = '内容' } = {}) {
  let s = typeof value === 'string' ? value : '';
  s = s.normalize('NFC').replace(/\r\n?/g, '\n');
  s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '');
  if (!multiline) s = s.replace(/\n/g, ' ');
  else s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  if (required && !s) throw new HttpError(400, `请填写${label}`);
  if ([...s].length > max) throw new HttpError(400, `${label}不能超过 ${max} 个字`);
  return s;
}

export function cleanDate(value, now = new Date()) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, '日期格式不正确');
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new HttpError(400, '日期格式不正确');
  if (d.getUTCFullYear() < 1900 || d.getTime() > now.getTime() + 2 * 86400000) throw new HttpError(400, '日期不正确');
  return value;
}

function send(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length, ...headers });
  res.end(body);
}

async function readBody(req, max) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > max) throw new HttpError(413, '文件太大');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, '文件太大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, 64 * 1024);
  try {
    const v = JSON.parse(buf.toString('utf8') || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new HttpError(400, '请求格式不正确');
}

const safeEq = (a, b) => a.length === b.length && timingSafeEqual(a, b);

// Row -> public JSON
function postJson(row, images = [], { admin = false } = {}) {
  const out = {
    id: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    place: row.place,
    happenedOn: row.happened_on ? fmtDate(row.happened_on) : null,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    edited: row.edited,
    images: images.map((im) => ({ id: im.id, type: im.mime, size: im.size })),
  };
  if (admin) Object.assign(out, { status: row.status, createdAt: row.created_at.toISOString(), rejectReason: row.reject_reason, reports: row.reports });
  return out;
}

function commentJson(row, { admin = false } = {}) {
  const out = { id: row.id, nickname: row.nickname, body: row.body, publishedAt: row.published_at ? row.published_at.toISOString() : null };
  if (admin) Object.assign(out, { postId: row.post_id, postTitle: row.post_title, status: row.status, createdAt: row.created_at.toISOString(), reports: row.reports });
  return out;
}

// pg returns DATE as a local-time Date; format it back without a timezone shift
const fmtDate = (d) => (typeof d === 'string' ? d : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

export function createApp({ db, config, publisher, now = () => Date.now() }) {
  const boardKey = Buffer.from(config.boardKey || '');
  const powSecret = createHmac('sha256', config.boardKey || 'dev').update('board-pow').digest();
  const filesDir = config.filesDir;
  const bg = (p) => p.catch((err) => console.error('background task failed', err.message));

  async function spendPow(purpose, pow) {
    const r = checkPow(powSecret, purpose, config.powBits[purpose], pow, now());
    if (!r.ok) throw new HttpError(r.error === 'expired' ? 409 : 400, r.error === 'expired' ? '验证已过期，请重试' : '验证失败，请刷新页面重试');
    const ins = await db.query('insert into pow_used (h, expires_at) values ($1, $2) on conflict do nothing', [r.hash, r.expiresAt]);
    if (ins.rowCount !== 1) throw new HttpError(409, '验证已使用，请重试');
  }

  async function draftFor(req, id) {
    if (!isId(id)) throw new HttpError(404, '草稿不存在');
    const key = String(req.headers['x-draft-key'] || '');
    const { rows } = await db.query('select key_hash from drafts where id = $1 and expires_at > now()', [id]);
    if (!rows[0] || !key || !safeEq(sha256(key), rows[0].key_hash)) throw new HttpError(404, '草稿不存在或已过期，请重新投稿');
    return id;
  }

  function adminName(req) {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const name = token && config.admins.get(sha256(token).toString('hex'));
    if (!name) throw new HttpError(401, '需要管理员口令');
    return name;
  }

  const log = (admin, action, target, note = '') =>
    db.query('insert into mod_log (admin, action, target, note) values ($1, $2, $3, $4)', [admin, action, target, String(note).slice(0, 300)]);

  async function imagesOf(postId) {
    return (await db.query('select id, mime, size from images where post_id = $1 order by pos, created_at', [postId])).rows;
  }

  async function removeFiles(ids) {
    await Promise.all(ids.map((id) => unlink(join(filesDir, id)).catch(() => {})));
  }

  async function deleteImages(where, params) {
    const { rows } = await db.query(`delete from images where ${where} returning id`, params);
    await removeFiles(rows.map((r) => r.id));
    return rows.length;
  }

  async function pendingCount(table) {
    return Number((await db.query(`select count(*)::int as n from ${table} where status = 'pending'`)).rows[0].n);
  }

  async function publishedPost(id) {
    if (!isId(id)) return null;
    const { rows } = await db.query("select * from posts where id = $1 and status = 'published'", [id]);
    return rows[0] || null;
  }

  // ---------- public ----------

  async function meta(req, res) {
    send(res, 200, {
      categories: CATEGORIES,
      limits: LIMITS,
      maxImages: config.maxImages,
      maxImageBytes: config.maxImageBytes,
      commentPremod: config.commentPremod,
    }, { 'Cache-Control': 'public, max-age=300' });
  }

  async function pow(req, res, url) {
    const purpose = url.searchParams.get('for');
    if (!(purpose in config.powBits)) throw new HttpError(400, 'bad purpose');
    const bits = config.powBits[purpose];
    send(res, 200, { challenge: makeChallenge(powSecret, purpose, bits, now()), bits });
  }

  async function createDraft(req, res) {
    const input = await readJson(req);
    const active = (await db.query('select count(*)::int as n from drafts where expires_at > now()')).rows[0].n;
    if (active >= config.maxDrafts) throw new HttpError(503, '投稿人数太多，请稍后再试');
    if ((await pendingCount('posts')) >= config.maxPendingPosts) throw new HttpError(503, '待审核的投稿太多，请稍后再试');
    await spendPow('post', input.pow);
    const id = rid(12);
    const key = rid(32);
    await db.query("insert into drafts (id, key_hash, expires_at) values ($1, $2, now() + interval '3 hours')", [id, sha256(key)]);
    send(res, 201, { draftId: id, draftKey: key, maxImages: config.maxImages, maxImageBytes: config.maxImageBytes });
  }

  async function addImage(req, res, draftId) {
    await draftFor(req, draftId);
    const { rows } = await db.query('select count(*)::int as n from images where draft_id = $1', [draftId]);
    if (rows[0].n >= config.maxImages) throw new HttpError(400, `最多 ${config.maxImages} 张图片`);
    const used = Number((await db.query('select coalesce(sum(size), 0)::bigint as n from images')).rows[0].n);
    if (used >= config.diskQuotaBytes) throw new HttpError(503, '存储空间已满，请稍后再试');
    const raw = await readBody(req, config.maxImageBytes);
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
    const kind = kindOf(bytes);
    if (!kind) throw new HttpError(415, '只支持 JPEG、PNG、WebP 图片');
    let clean;
    try {
      // Again on the server, in case the page's own cleaning was skipped
      clean = Buffer.from(STRIP[kind](bytes));
    } catch {
      throw new HttpError(415, '图片文件损坏，无法读取');
    }
    const id = rid(20);
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    const tmp = join(filesDir, `.${id}.tmp`);
    await writeFile(tmp, clean, { mode: 0o600 });
    await rename(tmp, join(filesDir, id));
    await db.query('insert into images (id, draft_id, pos, mime, size) values ($1, $2, $3, $4, $5)', [id, draftId, rows[0].n, MIME[kind], clean.length]);
    send(res, 201, { imageId: id, type: MIME[kind], size: clean.length });
  }

  async function removeDraftImage(req, res, draftId, imageId) {
    await draftFor(req, draftId);
    if (!isId(imageId)) throw new HttpError(404, '图片不存在');
    await deleteImages('id = $1 and draft_id = $2', [imageId, draftId]);
    send(res, 200, { ok: true });
  }

  async function submitDraft(req, res, draftId) {
    await draftFor(req, draftId);
    const input = await readJson(req);
    const title = cleanText(input.title, LIMITS.title, { required: true, label: '标题' });
    const body = cleanText(input.body, LIMITS.body, { multiline: true, required: true, label: '正文' });
    const place = cleanText(input.place, LIMITS.place, { label: '地点' });
    const happenedOn = cleanDate(input.happenedOn, new Date(now()));
    const category = CATEGORIES.includes(input.category) ? input.category : '其他';
    if ([...body].length < 10) throw new HttpError(400, '正文太短，请写清楚发生了什么');
    if ((await pendingCount('posts')) >= config.maxPendingPosts) throw new HttpError(503, '待审核的投稿太多，请稍后再试');

    const id = rid(10);
    const receipt = rid(24);
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(
        "insert into posts (id, status, title, body, category, place, happened_on, receipt_hash) values ($1, 'pending', $2, $3, $4, $5, $6, $7)",
        [id, title, body, category, place, happenedOn, sha256(receipt)],
      );
      await client.query('update images set post_id = $1, draft_id = null where draft_id = $2', [id, draftId]);
      await client.query('delete from drafts where id = $1', [draftId]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    bg(pendingCount('posts').then((n) => publisher.queued('post', n)));
    send(res, 201, { postId: id, receipt, status: 'pending' });
  }

  async function listPosts(req, res, url) {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
    const category = url.searchParams.get('category');
    const cursor = url.searchParams.get('cursor') || '';
    const params = [limit + 1];
    const where = ["p.status = 'published'"];
    if (category && CATEGORIES.includes(category)) {
      params.push(category);
      where.push(`p.category = $${params.length}`);
    }
    const m = cursor.match(/^(\d{13})_([A-Za-z0-9]{8,32})$/);
    if (m) {
      params.push(new Date(Number(m[1])), m[2]);
      where.push(`(p.published_at, p.id) < ($${params.length - 1}, $${params.length})`);
    }
    const { rows } = await db.query(
      `select p.id, p.title, p.category, p.place, p.happened_on, p.published_at, left(p.body, 140) as excerpt,
              (select count(*)::int from comments c where c.post_id = p.id and c.status = 'published') as comments,
              (select i.id from images i where i.post_id = p.id order by i.pos, i.created_at limit 1) as cover,
              (select count(*)::int from images i where i.post_id = p.id) as image_count
         from posts p where ${where.join(' and ')}
        order by p.published_at desc, p.id desc limit $1`,
      params,
    );
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      place: r.place,
      happenedOn: r.happened_on ? fmtDate(r.happened_on) : null,
      publishedAt: r.published_at.toISOString(),
      excerpt: r.excerpt,
      comments: r.comments,
      cover: r.cover,
      images: r.image_count,
    }));
    const last = items[items.length - 1];
    send(res, 200, { items, nextCursor: more && last ? `${new Date(last.publishedAt).getTime()}_${last.id}` : null }, { 'Cache-Control': 'no-cache' });
  }

  async function getPost(req, res, id) {
    const post = await publishedPost(id);
    if (!post) throw new HttpError(404, '没有找到这条事件，可能还在审核或已被删除');
    const comments = (await db.query("select * from comments where post_id = $1 and status = 'published' order by published_at, id limit 500", [id])).rows;
    send(res, 200, { ...postJson(post, await imagesOf(id)), comments: comments.map((c) => commentJson(c)) }, { 'Cache-Control': 'no-cache' });
  }

  async function sendImage(res, id, where, cacheControl) {
    if (!isId(id)) throw new HttpError(404, '图片不存在');
    const { rows } = await db.query(`select i.id, i.mime from images i join posts p on p.id = i.post_id where i.id = $1 and ${where}`, [id]);
    if (!rows[0]) throw new HttpError(404, '图片不存在');
    let data;
    try {
      data = await readFile(join(filesDir, rows[0].id));
    } catch {
      throw new HttpError(404, '图片不存在');
    }
    res.writeHead(200, {
      'Content-Type': rows[0].mime,
      'Content-Length': data.length,
      'Cache-Control': cacheControl,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
    });
    res.end(data);
  }

  async function addComment(req, res, postId) {
    const post = await publishedPost(postId);
    if (!post) throw new HttpError(404, '没有找到这条事件');
    const input = await readJson(req);
    const body = cleanText(input.body, LIMITS.comment, { multiline: true, required: true, label: '评论' });
    const nickname = cleanText(input.nickname, LIMITS.nickname, { label: '昵称' });
    if ((await pendingCount('comments')) >= config.maxPendingComments) throw new HttpError(503, '待审核的评论太多，请稍后再试');
    await spendPow('comment', input.pow);
    const id = rid(12);
    const receipt = rid(24);
    const status = config.commentPremod ? 'pending' : 'published';
    await db.query(
      `insert into comments (id, post_id, status, nickname, body, receipt_hash, published_at) values ($1, $2, $3, $4, $5, $6, ${status === 'published' ? 'now()' : 'null'})`,
      [id, postId, status, nickname, body, sha256(receipt)],
    );
    if (status === 'pending') bg(pendingCount('comments').then((n) => publisher.queued('comment', n)));
    send(res, 201, { commentId: id, receipt, status });
  }

  async function byReceipt(receipt) {
    if (typeof receipt !== 'string' || !/^[A-Za-z0-9]{24}$/.test(receipt.trim())) throw new HttpError(400, '回执码格式不正确');
    const h = sha256(receipt.trim());
    const post = (await db.query('select id, status, title, reject_reason, created_at, published_at from posts where receipt_hash = $1', [h])).rows[0];
    if (post) return { kind: 'post', row: post };
    const c = (await db.query('select c.id, c.status, c.post_id, c.created_at, c.published_at, p.title from comments c join posts p on p.id = c.post_id where c.receipt_hash = $1', [h])).rows[0];
    if (c) return { kind: 'comment', row: c };
    throw new HttpError(404, '没有找到这个回执码。被拒绝或撤回的内容会在 7 天后彻底删除。');
  }

  async function status(req, res) {
    const { kind, row } = await byReceipt((await readJson(req)).receipt);
    send(res, 200, {
      kind,
      id: row.id,
      postId: kind === 'post' ? row.id : row.post_id,
      title: row.title,
      status: row.status,
      rejectReason: kind === 'post' ? row.reject_reason : '',
      submittedOn: row.created_at.toISOString().slice(0, 10),
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
    });
  }

  // The author can take their own post or comment down at any time
  async function withdraw(req, res) {
    const { kind, row } = await byReceipt((await readJson(req)).receipt);
    if (row.status === 'withdrawn') return send(res, 200, { ok: true });
    if (kind === 'post') {
      await db.query("update posts set status = 'withdrawn', title = '', body = '', place = '', updated_at = now() where id = $1", [row.id]);
      await deleteImages('post_id = $1', [row.id]);
      await db.query("update comments set status = 'removed', updated_at = now() where post_id = $1", [row.id]);
      if (row.status === 'published') bg(publisher.unpublished(row.id));
    } else {
      await db.query("update comments set status = 'withdrawn', body = '', nickname = '', updated_at = now() where id = $1", [row.id]);
    }
    send(res, 200, { ok: true });
  }

  async function report(req, res) {
    const input = await readJson(req);
    const table = input.target === 'comment' ? 'comments' : input.target === 'post' ? 'posts' : null;
    if (!table || !isId(input.id)) throw new HttpError(400, '参数不正确');
    await spendPow('report', input.pow);
    const r = await db.query(`update ${table} set reports = reports + 1 where id = $1 and status = 'published'`, [input.id]);
    if (!r.rowCount) throw new HttpError(404, '内容不存在');
    send(res, 200, { ok: true });
  }

  // ---------- admin ----------

  async function adminQueue(req, res, url) {
    const type = url.searchParams.get('type') === 'comments' ? 'comments' : 'posts';
    const st = url.searchParams.get('status') || 'pending';
    if (!['pending', 'published', 'rejected', 'removed', 'reported'].includes(st)) throw new HttpError(400, 'bad status');
    const where = st === 'reported' ? "x.status = 'published' and x.reports > 0" : 'x.status = $1';
    const order = st === 'reported' ? 'x.reports desc, x.created_at' : st === 'pending' ? 'x.created_at' : 'x.updated_at desc';
    const params = st === 'reported' ? [] : [st];
    if (type === 'posts') {
      const { rows } = await db.query(`select x.* from posts x where ${where} order by ${order} limit 100`, params);
      const items = [];
      for (const r of rows) items.push(postJson(r, await imagesOf(r.id), { admin: true }));
      send(res, 200, { items, pending: { posts: await pendingCount('posts'), comments: await pendingCount('comments') } });
    } else {
      const { rows } = await db.query(`select x.*, p.title as post_title from comments x join posts p on p.id = x.post_id where ${where} order by ${order} limit 200`, params);
      send(res, 200, { items: rows.map((r) => commentJson(r, { admin: true })), pending: { posts: await pendingCount('posts'), comments: await pendingCount('comments') } });
    }
  }

  async function adminPost(req, res, id, admin) {
    const input = await readJson(req);
    if (!isId(id)) throw new HttpError(404, 'not found');
    const post = (await db.query('select * from posts where id = $1', [id])).rows[0];
    if (!post || post.status === 'withdrawn') throw new HttpError(404, '投稿不存在或已被作者撤回');
    const action = input.action;

    // Edits (title, body, place, date, category, dropping images) can go with any decision
    let edited = false;
    const set = {};
    if (input.title !== undefined) set.title = cleanText(input.title, LIMITS.title, { required: true, label: '标题' });
    if (input.body !== undefined) set.body = cleanText(input.body, LIMITS.body, { multiline: true, required: true, label: '正文' });
    if (input.place !== undefined) set.place = cleanText(input.place, LIMITS.place, { label: '地点' });
    if (input.happenedOn !== undefined) set.happened_on = cleanDate(input.happenedOn, new Date(now()));
    if (input.category !== undefined) {
      if (!CATEGORIES.includes(input.category)) throw new HttpError(400, '分类不正确');
      set.category = input.category;
    }
    const cols = Object.keys(set).filter((k) => String(set[k] ?? '') !== String(k === 'happened_on' ? (post.happened_on ? fmtDate(post.happened_on) : '') : post[k] ?? ''));
    if (cols.length) {
      await db.query(`update posts set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, edited = edited or status = 'published', updated_at = now() where id = $1`, [id, ...cols.map((c) => set[c])]);
      edited = true;
    }
    const drop = Array.isArray(input.removeImages) ? input.removeImages.filter(isId) : [];
    if (drop.length) {
      const n = await deleteImages('post_id = $1 and id = any($2)', [id, drop]);
      if (n) edited = true;
    }
    if (edited) await log(admin, 'edit', `post:${id}`, [...cols, ...(drop.length ? [`-${drop.length} images`] : [])].join(','));

    const reason = cleanText(input.reason, LIMITS.reason, { label: '原因' });
    let status = post.status;
    if (action === 'approve' || action === 'restore') {
      await db.query("update posts set status = 'published', published_at = coalesce(published_at, date_trunc('milliseconds', now())), reject_reason = '', updated_at = now() where id = $1", [id]);
      status = 'published';
    } else if (action === 'reject') {
      await db.query("update posts set status = 'rejected', reject_reason = $2, updated_at = now() where id = $1", [id, reason]);
      status = 'rejected';
    } else if (action === 'remove') {
      await db.query("update posts set status = 'removed', reject_reason = $2, updated_at = now() where id = $1", [id, reason]);
      status = 'removed';
    } else if (action === 'clear-reports') {
      await db.query('update posts set reports = 0 where id = $1', [id]);
    } else if (action !== 'edit') {
      throw new HttpError(400, '未知操作');
    }
    if (action !== 'edit') await log(admin, action, `post:${id}`, reason);

    const fresh = (await db.query('select * from posts where id = $1', [id])).rows[0];
    const images = await imagesOf(id);
    // Keep the exported copy in step with what the site shows
    if (status === 'published') bg(publisher.published(postJson(fresh, images), images));
    else if (post.status === 'published') bg(publisher.unpublished(id));
    send(res, 200, postJson(fresh, images, { admin: true }));
  }

  async function adminComment(req, res, id, admin) {
    const input = await readJson(req);
    if (!isId(id)) throw new HttpError(404, 'not found');
    const next = { approve: 'published', reject: 'rejected', remove: 'removed', restore: 'published' }[input.action];
    let r;
    if (next) {
      r = await db.query(
        `update comments set status = $2, published_at = case when $2 = 'published' then coalesce(published_at, now()) else published_at end, updated_at = now() where id = $1 and status <> 'withdrawn'`,
        [id, next],
      );
    } else if (input.action === 'clear-reports') {
      r = await db.query('update comments set reports = 0 where id = $1', [id]);
    } else {
      throw new HttpError(400, '未知操作');
    }
    if (!r.rowCount) throw new HttpError(404, '评论不存在或已被作者撤回');
    await log(admin, input.action, `comment:${id}`);
    send(res, 200, { ok: true, status: next || null });
  }

  async function adminLog(req, res, url) {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const { rows } = await db.query('select at, admin, action, target, note from mod_log order by id desc limit $1', [limit]);
    send(res, 200, { items: rows.map((r) => ({ ...r, at: r.at.toISOString() })) });
  }

  // ---------- routing ----------

  const routes = [
    ['GET', /^\/api\/board\/meta$/, meta],
    ['GET', /^\/api\/board\/pow$/, pow],
    ['POST', /^\/api\/board\/drafts$/, createDraft],
    ['PUT', /^\/api\/board\/drafts\/([^/]+)\/images$/, addImage],
    ['DELETE', /^\/api\/board\/drafts\/([^/]+)\/images\/([^/]+)$/, removeDraftImage],
    ['POST', /^\/api\/board\/drafts\/([^/]+)\/submit$/, submitDraft],
    ['GET', /^\/api\/board\/posts$/, listPosts],
    ['GET', /^\/api\/board\/posts\/([^/]+)$/, getPost],
    ['POST', /^\/api\/board\/posts\/([^/]+)\/comments$/, addComment],
    ['GET', /^\/api\/board\/img\/([^/]+)$/, (req, res, id) => sendImage(res, id, "p.status = 'published'", 'public, max-age=3600')],
    ['POST', /^\/api\/board\/status$/, status],
    ['POST', /^\/api\/board\/withdraw$/, withdraw],
    ['POST', /^\/api\/board\/report$/, report],
    ['GET', /^\/api\/board\/admin\/me$/, (req, res, admin) => send(res, 200, { admin })],
    ['GET', /^\/api\/board\/admin\/queue$/, (req, res, admin, url) => adminQueue(req, res, url)],
    ['GET', /^\/api\/board\/admin\/log$/, (req, res, admin, url) => adminLog(req, res, url)],
    ['GET', /^\/api\/board\/admin\/img\/([^/]+)$/, (req, res, id) => sendImage(res, id, "p.status <> 'withdrawn'", 'private, no-store')],
    ['POST', /^\/api\/board\/admin\/posts\/([^/]+)$/, (req, res, id, admin) => adminPost(req, res, id, admin)],
    ['POST', /^\/api\/board\/admin\/comments\/([^/]+)$/, (req, res, id, admin) => adminComment(req, res, id, admin)],
  ];

  return async function handle(req, res) {
    try {
      // Only the site's Worker may call this service
      const key = Buffer.from(String(req.headers['x-board-key'] || ''));
      if (!boardKey.length || !safeEq(sha256(key), sha256(boardKey))) throw new HttpError(403, 'forbidden');
      const url = new URL(req.url, 'http://board');
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m) continue;
        if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) continue;
        const args = m.slice(1).map(decodeURIComponent);
        if (url.pathname.startsWith('/api/board/admin/')) {
          const admin = adminName(req);
          // Admin handlers get (req, res, ...params, admin, url); /me, /queue, /log get (req, res, admin, url)
          return await fn(req, res, ...args, admin, url);
        }
        return await fn(req, res, ...args, url);
      }
      throw new HttpError(404, 'not found');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error('request failed', err?.message);
      send(res, 500, { error: '服务暂时不可用，请稍后再试' });
    }
  };
}

// Housekeeping: expired drafts and challenges; rejected, removed and withdrawn content is
// deleted for good (rows and image files) after config.purgeDays.
export async function cleanup(db, config) {
  const files = [];
  const drafts = await db.query("delete from images where draft_id in (select id from drafts where expires_at < now()) or (draft_id is null and post_id is null and created_at < now() - interval '1 day') returning id");
  files.push(...drafts.rows.map((r) => r.id));
  await db.query('delete from drafts where expires_at < now()');
  await db.query('delete from pow_used where expires_at < now()');
  const old = await db.query(
    "select id from posts where status in ('rejected', 'removed', 'withdrawn') and updated_at < now() - make_interval(days => $1)",
    [config.purgeDays],
  );
  if (old.rows.length) {
    const ids = old.rows.map((r) => r.id);
    const imgs = await db.query('delete from images where post_id = any($1) returning id', [ids]);
    files.push(...imgs.rows.map((r) => r.id));
    await db.query('delete from posts where id = any($1)', [ids]);
  }
  await db.query("delete from comments where status in ('rejected', 'removed', 'withdrawn') and updated_at < now() - make_interval(days => $1)", [config.purgeDays]);
  await Promise.all(files.map((id) => unlink(join(config.filesDir, id)).catch(() => {})));
  return { files: files.length, posts: old.rows.length };
}
