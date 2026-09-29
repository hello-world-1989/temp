// 加密聊天 (event rooms). The browser encrypts everything with the room key from the invite
// link's #fragment; this service only relays and stores ciphertext for a limited time.
//
// HTTP   GET  /chat                   the page (served from here, never through Cloudflare)
//        GET  /chat/assets/<file>     its scripts and styles
//        GET  /chat/api/pow           proof-of-work challenge for creating a room
//        GET  /chat/api/entries       addresses this page can be opened at (invite links' backups)
//        POST /chat/api/backup/get    { id } -> { blob }                       恢复口令 backups
//        POST /chat/api/backup/put    { id, write, blob, pow? } -> { ok }     pow only to create
//        POST /chat/api/backup/delete { id, write } -> { ok }
// 公开事件群 (the room owner asks, a site admin approves the listing; joining needs the owner):
//        GET  /chat/api/directory                 listed rooms: { rooms: [{ room, name, desc, at, ownerPub }] }
//        POST /chat/api/rooms/publish  { room, owner, name, desc, ownerPub, ownerBox }  -> waits for review
//        POST /chat/api/rooms/unpublish { room, owner }
//        POST /chat/api/rooms/owner    { room, owner } -> { state, name, desc, reason, ownerBox, requests }
//        POST /chat/api/rooms/decide   { room, owner, id, approve, sealed? }
//        POST /chat/api/join/request   { room, reqPub, info, secret, pow } -> { id }
//        POST /chat/api/join/status    { id, secret } -> { status, sealed?, ownerPub }
//        GET  /chat/api/admin/listings?state=1|2|3   POST /chat/api/admin/review { room, action, reason }
//             (Authorization: Bearer <事件墙 admin token>)
//        POST /chat/api/rooms         { id, auth, owner, meta, pow } -> { id }
//        POST /chat/api/transfer      { blob, pow } -> { id, exp }   迁移到新设备 (one-time copy)
//        POST /chat/api/transfer/take { id } -> { blob }            and it is deleted
// WS     /chat/ws                     see handleSocket()
//
// Nothing about visitors is kept: no IP addresses, no user agents, no logs of who is in which
// room. The room key never reaches the server; rooms admit whoever proves it (auth token).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { checkPow, makeChallenge } from '../../board-server/src/pow.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha256 = (b) => createHash('sha256').update(b).digest();
const ROOM_ID = /^[A-Za-z0-9]{16}$/;
const TRANSFER_TTL = 10 * 60_000;
const POLL_GRACE = 60_000; // a long-poll client that has not asked for this long has left
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newId() {
  let out = '';
  while (out.length < 16) for (const b of randomBytes(32)) if (b < 224 && out.length < 16) out += ALPHABET[b % 56];
  return out;
}
const B64URL = /^[A-Za-z0-9_-]*$/;

// base64url -> Buffer of exactly `len` bytes (or up to `max`), else null
export function b64(value, { len, max } = {}) {
  if (typeof value !== 'string' || !B64URL.test(value) || value.length > 4 * Math.ceil((max ?? len ?? 0) / 3) + 4) return null;
  const buf = Buffer.from(value, 'base64url');
  if (len != null && buf.length !== len) return null;
  if (max != null && buf.length > max) return null;
  return buf;
}

const safeEq = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);

// Ciphertext blobs from chat-crypto.js start with this
const MAGIC = Buffer.from('EGC1');
const isBlob = (buf, max, magic = MAGIC) => buf && buf.length >= magic.length + 12 + 16 && buf.length <= max && buf.subarray(0, 4).equals(magic);
const TRANSFER_MAGIC = Buffer.from('EGT1');
const BACKUP_MAGIC = Buffer.from('EGR1');
const BACKUP_ID = /^[A-Za-z0-9_-]{22}$/;
const OWNER_MAGIC = Buffer.from('EGO1'); // owner's private key, boxed with the owner token
const JOIN_MAGIC = Buffer.from('EGJ1'); // request info (to the owner) and approval (to the requester)
const PUB_STATES = { private: 0, review: 1, listed: 2, rejected: 3 };

// Plain text for public listings: no control or bidi characters, NFC, one line (or a few)
export function cleanText(v, max, { multiline = false } = {}) {
  let s = typeof v === 'string' ? v.normalize('NFC') : '';
  s = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '');
  s = multiline ? s.replace(/\n{3,}/g, '\n\n') : s.replace(/\n/g, ' ');
  s = s.trim();
  return [...s].length > max ? null : s;
}

const STATIC = {
  '/chat': ['../public/chat.html', 'text/html; charset=utf-8'],
  '/chat/assets/chat.css': ['../public/chat.css', 'text/css; charset=utf-8'],
  '/chat/assets/chat.js': ['../public/chat.js', 'text/javascript; charset=utf-8'],
  '/chat/assets/chat-crypto.js': ['../public/chat-crypto.js', 'text/javascript; charset=utf-8'],
  '/chat/assets/chat-vault.js': ['../public/chat-vault.js', 'text/javascript; charset=utf-8'],
  '/chat/assets/chat-me.js': ['../public/chat-me.js', 'text/javascript; charset=utf-8'],
  '/chat/assets/chat-identity.js': ['../public/chat-identity.js', 'text/javascript; charset=utf-8'],
  '/chat/assets/chat-rooms.js': ['../public/chat-rooms.js', 'text/javascript; charset=utf-8'],
  '/chat/assets/qrcode.js': ['../../public/assets/vendor/qrcode.js', 'text/javascript; charset=utf-8'],
};

// Everything the page needs comes from this origin; nothing third-party can run on it
function securityHeaders(host) {
  const h = /^[0-9A-Za-z.:[\]-]{1,100}$/.test(host || '') ? host : '';
  return {
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${h ? ` wss://${h} ws://${h}` : ''}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'X-Robots-Tag': 'noindex',
  };
}

function send(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length, ...headers });
  res.end(body);
}

async function readJson(req, max = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, '请求太大');
    chunks.push(chunk);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new HttpError(400, '请求格式不正确');
}

export function createApp({ store, config, entries = { list: () => [] }, now = () => Date.now() }) {
  const powSecret = randomBytes(32); // challenges stop working on restart, which is fine
  const files = new Map();
  for (const [path, [file, type]] of Object.entries(STATIC)) {
    try {
      files.set(path, { body: readFileSync(new URL(file, import.meta.url)), type });
    } catch (err) {
      console.error(`missing static file for ${path}`, err.message);
    }
  }

  // room id -> Set of members. A member is a WebSocket or a long-poll client (for networks and
  // mirrors that do not pass WebSockets); both get every event through deliver().
  const rooms = new Map();
  const pollers = new Map(); // long-poll client id -> member
  let connections = 0;

  // `own` = [member, data]: that member gets `data` instead (the sender's copy with its ref)
  const broadcast = (roomId, data, own) => {
    for (const m of rooms.get(roomId) || []) m.deliver(own && m === own[0] ? own[1] : data);
  };
  const online = (roomId) => broadcast(roomId, { t: 'online', n: rooms.get(roomId)?.size || 0 });

  function leave(member) {
    const set = member.roomId && rooms.get(member.roomId);
    if (!set || !set.delete(member)) return;
    if (set.size) online(member.roomId);
    else rooms.delete(member.roomId);
  }

  function closeRoom(roomId) {
    const set = rooms.get(roomId);
    if (!set) return;
    rooms.delete(roomId);
    for (const m of set) {
      m.deliver({ t: 'gone' });
      m.close(4010);
    }
  }

  async function http(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/') {
        res.writeHead(302, { Location: '/chat', 'Cache-Control': 'no-store' });
        return res.end();
      }
      const f = files.get(path);
      if (f) {
        res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length, 'Cache-Control': 'no-cache', ...securityHeaders(req.headers.host) });
        return res.end(req.method === 'HEAD' ? undefined : f.body);
      }
      if (path === '/chat/api/pow') {
        const purpose = { transfer: 'transfer', backup: 'backup', join: 'join' }[url.searchParams.get('for')] || 'room';
        const bits = { transfer: config.powBitsTransfer, backup: config.powBitsBackup, join: config.powBitsJoin, room: config.powBits }[purpose];
        return send(res, 200, { challenge: makeChallenge(powSecret, purpose, bits, now()), bits });
      }
      if (path === '/chat/api/health') return send(res, 200, { ok: true, rooms: rooms.size, connections });
      if (path === '/chat/api/entries') return send(res, 200, { entries: entries.list() }, { 'Cache-Control': 'public, max-age=300' });
    }
    if (req.method === 'POST' && path === '/chat/api/rooms') return send(res, 200, createRoom(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/transfer') return send(res, 200, putTransfer(await readJson(req, config.transferBytes * 1.4 + 1024)));
    if (req.method === 'POST' && path === '/chat/api/transfer/take') return send(res, 200, takeTransfer(await readJson(req)));
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/chat/api/directory') return send(res, 200, directory(), { 'Cache-Control': 'public, max-age=60' });
    if (req.method === 'GET' && path === '/chat/api/admin/listings') return send(res, 200, adminListings(req, url));
    if (req.method === 'POST' && path === '/chat/api/admin/review') return send(res, 200, adminReview(req, await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/rooms/publish') return send(res, 200, publish(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/rooms/unpublish') return send(res, 200, unpublish(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/rooms/owner') return send(res, 200, ownerView(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/rooms/decide') return send(res, 200, decide(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/join/request') return send(res, 200, joinRequest(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/join/status') return send(res, 200, joinStatus(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/backup/get') return send(res, 200, getBackup(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/backup/put') return send(res, 200, putBackup(await readJson(req, config.backupBytes * 1.4 + 2048)));
    if (req.method === 'POST' && path === '/chat/api/backup/delete') return send(res, 200, deleteBackup(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/poll/join') return send(res, 200, pollJoin(await readJson(req)));
    if (req.method === 'POST' && path === '/chat/api/poll/act') return send(res, 200, pollAct(await readJson(req, config.maxMessageBytes * 2 + 1024)));
    if (req.method === 'POST' && path === '/chat/api/poll') return pollWait(await readJson(req), res);
    throw new HttpError(404, '找不到页面');
  }

  function createRoom(body) {
    const t = now();
    const pow = checkPow(powSecret, 'room', config.powBits, body.pow, t);
    if (!pow.ok) throw new HttpError(400, pow.error === 'expired' ? '验证已过期，请重试' : '验证失败，请重试');
    const id = typeof body.id === 'string' && ROOM_ID.test(body.id) ? body.id : null;
    const auth = b64(body.auth, { len: 32 });
    const owner = b64(body.owner, { len: 32 });
    const meta = b64(body.meta, { max: 2048 });
    if (!id || !auth || !owner || !isBlob(meta, 2048)) throw new HttpError(400, '请求格式不正确');
    if (store.roomCount() >= config.maxRooms) throw new HttpError(503, '服务器繁忙，请稍后再试');
    if (!store.usePow(pow.hash, pow.expiresAt.getTime())) throw new HttpError(400, '验证已使用，请重试');
    if (store.getRoom(id)) throw new HttpError(409, '群号冲突，请重试');
    store.addRoom({ id, authHash: auth, ownerHash: owner, meta, now: t });
    return { id };
  }

  function putTransfer(body) {
    const t = now();
    const pow = checkPow(powSecret, 'transfer', config.powBitsTransfer, body.pow, t);
    if (!pow.ok) throw new HttpError(400, pow.error === 'expired' ? '验证已过期，请重试' : '验证失败，请重试');
    const blob = b64(body.blob, { max: config.transferBytes });
    if (!isBlob(blob, config.transferBytes, TRANSFER_MAGIC)) throw new HttpError(400, '请求格式不正确');
    if (store.transferCount() >= config.maxTransfers) throw new HttpError(503, '服务器繁忙，请稍后再试');
    if (!store.usePow(pow.hash, pow.expiresAt.getTime())) throw new HttpError(400, '验证已使用，请重试');
    const id = newId();
    const exp = t + TRANSFER_TTL;
    store.addTransfer(id, blob, exp);
    return { id, exp };
  }

  // ---- 公开事件群 -------------------------------------------------------------------------------
  function ownedRoom(body) {
    const id = typeof body.room === 'string' && ROOM_ID.test(body.room) ? body.room : null;
    const room = id && store.getRoom(id);
    const owner = b64(body.owner, { len: 32 });
    if (!room) throw new HttpError(404, '群不存在或已销毁');
    if (!owner || !safeEq(sha256(owner), room.owner_hash)) throw new HttpError(403, '只有建群的人能管理这个群');
    return room;
  }

  const STATE_NAMES = ['private', 'review', 'listed', 'rejected'];

  function publish(body) {
    const room = ownedRoom(body);
    const name = cleanText(body.name, 40);
    const desc = cleanText(body.desc, 300, { multiline: true });
    const ownerPub = b64(body.ownerPub, { len: 65 });
    const ownerBox = b64(body.ownerBox, { max: 1024 });
    if (!name || [...name].length < 2) throw new HttpError(400, '群名称要 2 到 40 个字');
    if (desc == null) throw new HttpError(400, '简介不能超过 300 个字');
    if (!ownerPub || ownerPub[0] !== 4 || !isBlob(ownerBox, 1024, OWNER_MAGIC)) throw new HttpError(400, '请求格式不正确');
    store.publish(room.id, { name, desc, ownerPub, ownerBox }, now());
    return { state: 'review' };
  }

  function unpublish(body) {
    const room = ownedRoom(body);
    store.unpublish(room.id);
    return { state: 'private' };
  }

  function ownerView(body) {
    const room = ownedRoom(body);
    const requests = room.pub_state ? store.pendingRequests(room.id).map((r) => ({ id: r.id, reqPub: r.req_pub.toString('base64url'), info: r.info.toString('base64url'), at: r.created_at })) : [];
    return {
      state: STATE_NAMES[room.pub_state] || 'private',
      name: room.pub_name,
      desc: room.pub_desc,
      reason: room.pub_reason,
      ownerBox: room.owner_box ? room.owner_box.toString('base64url') : null,
      requests,
    };
  }

  function decide(body) {
    const room = ownedRoom(body);
    const id = typeof body.id === 'string' && ROOM_ID.test(body.id) ? body.id : null;
    const approve = body.approve === true;
    const sealed = approve ? b64(body.sealed, { max: 1024 }) : null;
    if (!id || (approve && !isBlob(sealed, 1024, JOIN_MAGIC))) throw new HttpError(400, '请求格式不正确');
    if (!store.decideRequest(room.id, id, approve ? 'approved' : 'rejected', sealed, now())) throw new HttpError(404, '这个申请已经处理过了');
    return { ok: true };
  }

  function directory() {
    return {
      rooms: store.listed(300).map((r) => ({ room: r.id, name: r.pub_name, desc: r.pub_desc, at: r.pub_at, ownerPub: r.owner_pub.toString('base64url'), online: rooms.get(r.id)?.size || 0 })),
    };
  }

  function joinRequest(body) {
    const t = now();
    const pow = checkPow(powSecret, 'join', config.powBitsJoin, body.pow, t);
    if (!pow.ok) throw new HttpError(400, pow.error === 'expired' ? '验证已过期，请重试' : '验证失败，请重试');
    const id = typeof body.room === 'string' && ROOM_ID.test(body.room) ? body.room : null;
    const room = id && store.getRoom(id);
    if (!room || room.pub_state !== PUB_STATES.listed) throw new HttpError(404, '这个群不在公开列表里了');
    const reqPub = b64(body.reqPub, { len: 65 });
    const info = b64(body.info, { max: 2048 });
    const secret = b64(body.secret, { len: 32 });
    if (!reqPub || reqPub[0] !== 4 || !secret || !isBlob(info, 2048, JOIN_MAGIC)) throw new HttpError(400, '请求格式不正确');
    if (store.pendingCount(room.id) >= 200) throw new HttpError(503, '这个群待处理的申请太多了，请稍后再试');
    if (!store.usePow(pow.hash, pow.expiresAt.getTime())) throw new HttpError(400, '验证已使用，请重试');
    const rid = newId();
    store.addRequest({ id: rid, room: room.id, reqPub, info, secretHash: sha256(secret), now: t });
    return { id: rid };
  }

  function joinStatus(body) {
    const id = typeof body.id === 'string' && ROOM_ID.test(body.id) ? body.id : null;
    const r = id && store.getRequest(id);
    const secret = b64(body.secret, { len: 32 });
    if (!r || !secret || !safeEq(sha256(secret), r.secret_hash)) throw new HttpError(404, '申请不存在或已过期');
    const room = store.getRoom(r.room);
    return { status: r.status, sealed: r.sealed ? r.sealed.toString('base64url') : null, ownerPub: room?.owner_pub ? room.owner_pub.toString('base64url') : null };
  }

  // Site admins: the 事件墙 admin tokens (Authorization: Bearer ...)
  function adminName(req) {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const name = token && config.admins.get(sha256(token).toString('hex'));
    if (!name) throw new HttpError(401, '需要管理员口令');
    return name;
  }

  function adminListings(req, url) {
    adminName(req);
    const state = Number(url.searchParams.get('state') || 1);
    if (![1, 2, 3].includes(state)) throw new HttpError(400, 'state 1, 2 or 3');
    return { items: store.listings(state).map((r) => ({ room: r.id, state: STATE_NAMES[r.pub_state], name: r.pub_name, desc: r.pub_desc, reason: r.pub_reason, at: r.pub_at })) };
  }

  function adminReview(req, body) {
    const admin = adminName(req);
    const id = typeof body.room === 'string' && ROOM_ID.test(body.room) ? body.room : null;
    const action = { approve: PUB_STATES.listed, reject: PUB_STATES.rejected, remove: PUB_STATES.rejected }[body.action];
    const reason = cleanText(body.reason ?? '', 200) ?? '';
    if (!id || action == null) throw new HttpError(400, '请求格式不正确');
    if (!store.review(id, action, action === PUB_STATES.listed ? '' : reason, now())) throw new HttpError(404, '这个群没有申请公开');
    console.log(`listing ${body.action} by ${admin}`); // no room id or name in the log
    return { ok: true };
  }

  // ---- 恢复口令 backups ---------------------------------------------------------------------
  const backupId = (body) => (typeof body.id === 'string' && BACKUP_ID.test(body.id) ? body.id : null);

  function getBackup(body) {
    const id = backupId(body);
    const row = id && store.getBackup(id);
    if (!row) throw new HttpError(404, '没有找到这个恢复口令的备份：请检查口令有没有抄错');
    return { blob: row.blob.toString('base64url') };
  }

  function putBackup(body) {
    const id = backupId(body);
    const write = b64(body.write, { len: 32 });
    const blob = b64(body.blob, { max: config.backupBytes });
    if (!id || !write || !isBlob(blob, config.backupBytes, BACKUP_MAGIC)) throw new HttpError(400, '请求格式不正确');
    const row = store.getBackup(id);
    if (row) {
      if (!safeEq(sha256(write), row.write_hash)) throw new HttpError(403, '恢复口令不对');
    } else {
      const t = now();
      const pow = checkPow(powSecret, 'backup', config.powBitsBackup, body.pow, t);
      if (!pow.ok) throw new HttpError(400, pow.error === 'expired' ? '验证已过期，请重试' : '验证失败，请重试');
      if (store.backupCount() >= config.maxBackups) throw new HttpError(503, '服务器繁忙，请稍后再试');
      if (!store.usePow(pow.hash, pow.expiresAt.getTime())) throw new HttpError(400, '验证已使用，请重试');
    }
    store.putBackup(id, blob, sha256(write), now());
    return { ok: true, created: !row };
  }

  function deleteBackup(body) {
    const id = backupId(body);
    const write = b64(body.write, { len: 32 });
    const row = id && store.getBackup(id);
    if (!row) return { ok: true };
    if (!write || !safeEq(sha256(write), row.write_hash)) throw new HttpError(403, '恢复口令不对');
    store.deleteBackup(id);
    return { ok: true };
  }

  function takeTransfer(body) {
    const id = typeof body.id === 'string' && ROOM_ID.test(body.id) ? body.id : null;
    const blob = id && store.takeTransfer(id, now());
    if (!blob) throw new HttpError(404, '迁移码已失效：已经被用过，或者超过了 10 分钟。请在旧设备上重新生成。');
    return { blob: blob.toString('base64url') };
  }

  async function handler(req, res) {
    try {
      await http(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('request failed', err.message);
      if (!res.headersSent) send(res, status, { error: status === 500 ? '服务器出错，请稍后再试' : err.message, code: err.code });
      else res.destroy();
    }
  }

  // ---- room protocol (the same over WebSocket and long polling) -----------------------------
  // client -> server
  //   { t: 'auth', room, token }           first message; token = HKDF(room key, "auth")
  //   { t: 'send', ref, ct, ttl, burn, dh } dh = sha256(delete token), ttl/burn in seconds
  //   { t: 'del', id, token }              撤回 with the delete token
  //   { t: 'read', ids }                   someone other than the sender has shown these
  //   { t: 'destroy', owner }              the owner token: delete the room and everything in it
  // server -> client
  //   { t: 'ready', now, meta, online, maxTtl, msgs }   msgs: [{ id, ts, exp, burn, ct }]
  //   { t: 'msg', id, ts, exp, burn, ct, ref? }         ref only on the sender's own copy
  //   { t: 'exp', id, exp } | { t: 'del', id } | { t: 'online', n } | { t: 'gone' }
  //   { t: 'error', code, message }
  //
  // Long polling: POST /chat/api/poll/join { room, token } -> { cid, ready }, then
  // POST /chat/api/poll { cid } -> { events } (held up to POLL_WAIT) and
  // POST /chat/api/poll/act { cid, ...client message } -> { events } (errors for this client).
  // A long-poll client that stops asking for POLL_GRACE is dropped.

  const errorOf = (code, message) => ({ t: 'error', code, message });

  // -> { ready } or { error: [code, message] }
  function join(member, m) {
    const id = typeof m.room === 'string' && ROOM_ID.test(m.room) ? m.room : null;
    const room = id && store.getRoom(id);
    const token = b64(m.token, { len: 32 });
    if (!room || !token || !safeEq(sha256(token), room.auth_hash)) return { error: ['room', '群不存在或已销毁，或者链接不完整'] };
    const set = rooms.get(id) || new Set();
    if (set.size >= config.maxRoomConnections) return { error: ['full', '这个群在线人数已满'] };
    member.roomId = id;
    set.add(member);
    rooms.set(id, set);
    const t = now();
    const msgs = store.history(id, 0, t, config.maxHistory).map((r) => ({ id: r.id, ts: r.ts, exp: r.exp, burn: r.burn, ct: r.ct.toString('base64url') }));
    const ready = { t: 'ready', now: t, meta: room.meta.toString('base64url'), online: set.size, maxTtl: config.maxTtl, msgs };
    online(id);
    return { ready };
  }

  // A joined member's request; `reply` answers that member only
  function act(member, m, reply) {
    const roomId = member.roomId;
    const room = store.getRoom(roomId);
    if (!room) return closeRoom(roomId);
    if (m.t === 'send') return sendMsg();
    if (m.t === 'del') return delMsg();
    if (m.t === 'read') return readMsgs();
    if (m.t === 'destroy') return destroy();
    reply(errorOf('bad', '未知操作'));

    function sendMsg() {
      const t = now();
      const b = member.bucket;
      b.tokens = Math.min(config.sendBurst, b.tokens + ((t - b.refilled) / 10_000) * config.sendBurst);
      b.refilled = t;
      if (b.tokens < 1) return reply(errorOf('slow', '发送太快了，请稍等'));
      b.tokens--;
      const ct = b64(m.ct, { max: config.maxMessageBytes });
      const dh = b64(m.dh, { len: 32 });
      const ttl = Number(m.ttl);
      const burn = m.burn == null ? 0 : Number(m.burn);
      if (!isBlob(ct, config.maxMessageBytes) || !dh) return reply(errorOf('bad', '消息格式不正确'));
      if (!Number.isInteger(ttl) || ttl < 10 || ttl > config.maxTtl) return reply(errorOf('bad', '销毁时间不正确'));
      if (!Number.isInteger(burn) || burn < 0 || burn > 3600) return reply(errorOf('bad', '阅后销毁时间不正确'));
      const msg = { ts: t, exp: t + ttl * 1000, burn, delHash: dh, ct };
      const id = store.addMessage(roomId, msg, config.maxRoomMessages);
      const out = { t: 'msg', id, ts: t, exp: msg.exp, burn, ct: ct.toString('base64url') };
      broadcast(roomId, out, [member, { ...out, ref: Number.isSafeInteger(m.ref) ? m.ref : undefined }]);
    }

    function delMsg() {
      const row = Number.isSafeInteger(m.id) ? store.getMessage(roomId, m.id) : null;
      const token = b64(m.token, { len: 32 });
      if (!row) return; // already gone
      if (!token || !safeEq(sha256(token), row.del_hash)) return reply(errorOf('denied', '只能撤回自己发的消息'));
      store.deleteMessage(roomId, m.id);
      broadcast(roomId, { t: 'del', id: m.id });
    }

    // The first reader starts the countdown for everyone (the sender's own page never reports)
    function readMsgs() {
      if (!Array.isArray(m.ids)) return;
      const t = now();
      for (const id of m.ids.slice(0, 100)) {
        const row = Number.isSafeInteger(id) ? store.getMessage(roomId, id) : null;
        if (!row || !row.burn) continue;
        const exp = Math.min(row.exp, t + row.burn * 1000);
        store.setExpiry(roomId, id, exp);
        broadcast(roomId, { t: 'exp', id, exp });
      }
    }

    function destroy() {
      const token = b64(m.owner, { len: 32 });
      if (!token || !safeEq(sha256(token), room.owner_hash)) return reply(errorOf('denied', '只有建群的人能销毁这个群'));
      store.deleteRoom(roomId);
      closeRoom(roomId);
    }
  }

  const newBucket = () => ({ tokens: config.sendBurst, refilled: now() });

  // ---- WebSocket ----------------------------------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes * 2 + 1024, perMessageDeflate: false });

  function upgrade(req, socket, head) {
    const path = new URL(req.url, 'http://x').pathname;
    if (path !== '/chat/ws' || connections >= config.maxConnections) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleSocket(ws));
  }

  function handleSocket(ws) {
    connections++;
    const member = {
      roomId: null,
      bucket: newBucket(),
      deliver: (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj)),
      close: (code) => ws.close(code, 'closed'),
    };
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const authTimer = setTimeout(() => member.roomId || ws.close(4001, 'auth'), 10_000);
    const fail = (code, message, close = false) => {
      member.deliver(errorOf(code, message));
      if (close) ws.close(4000, code);
    };

    ws.on('close', () => {
      connections--;
      clearTimeout(authTimer);
      leave(member);
    });

    ws.on('message', (data, isBinary) => {
      let m;
      try {
        m = isBinary ? null : JSON.parse(data.toString('utf8'));
      } catch {}
      if (!m || typeof m !== 'object') return fail('bad', '消息格式不正确');
      try {
        if (!member.roomId) {
          if (m.t !== 'auth') return fail('auth', '请先加入群', true);
          const r = join(member, m);
          if (r.error) return fail(...r.error, true);
          clearTimeout(authTimer);
          return member.deliver(r.ready);
        }
        act(member, m, member.deliver);
      } catch (err) {
        console.error('socket message failed', err.message);
        fail('server', '服务器出错，请稍后再试');
      }
    });
  }

  // ---- long polling -----------------------------------------------------------------------------
  function pollMember(cid) {
    const member = {
      cid,
      roomId: null,
      bucket: newBucket(),
      queue: [],
      waiting: null, // { res, timer }
      lastSeen: now(),
      closed: false,
      deliver(obj) {
        this.queue.push(obj);
        if (this.queue.length > 1000) this.queue.splice(0, this.queue.length - 1000);
        this.flush();
      },
      close() {
        this.closed = true;
        leave(this);
        this.flush();
      },
      flush() {
        if (!this.waiting || !this.queue.length) return;
        const { res, timer } = this.waiting;
        this.waiting = null;
        clearTimeout(timer);
        send(res, 200, { events: this.queue.splice(0) });
        if (this.closed) drop(this);
      },
    };
    return member;
  }

  function drop(member) {
    if (pollers.get(member.cid) !== member) return;
    pollers.delete(member.cid);
    connections--;
    if (member.waiting) {
      clearTimeout(member.waiting.timer);
      send(member.waiting.res, 200, { events: member.queue.splice(0) });
      member.waiting = null;
    }
    leave(member);
  }

  function findPoller(body) {
    const member = typeof body.cid === 'string' ? pollers.get(body.cid) : null;
    if (!member) throw new HttpError(404, '连接已过期，请重新连接');
    member.lastSeen = now();
    return member;
  }

  function pollJoin(body) {
    if (connections >= config.maxConnections) throw new HttpError(503, '服务器繁忙，请稍后再试');
    const member = pollMember(newId());
    const r = join(member, body);
    if (r.error) throw Object.assign(new HttpError(r.error[0] === 'full' ? 503 : 404, r.error[1]), { code: r.error[0] });
    pollers.set(member.cid, member);
    connections++;
    return { cid: member.cid, ready: r.ready };
  }

  function pollWait(body, res) {
    const member = findPoller(body);
    if (member.waiting) {
      clearTimeout(member.waiting.timer);
      send(member.waiting.res, 200, { events: [] });
      member.waiting = null;
    }
    if (member.queue.length) {
      send(res, 200, { events: member.queue.splice(0) });
      if (member.closed) drop(member);
      return;
    }
    const timer = setTimeout(() => {
      if (member.waiting?.res !== res) return;
      member.waiting = null;
      send(res, 200, { events: [] });
    }, config.pollWait * 1000);
    member.waiting = { res, timer };
    res.on('close', () => {
      if (member.waiting?.res === res) {
        clearTimeout(timer);
        member.waiting = null;
      }
    });
  }

  function pollAct(body) {
    const member = findPoller(body);
    if (member.closed) return { events: [{ t: 'gone' }] };
    const events = [];
    act(member, body, (obj) => events.push(obj));
    return { events };
  }

  // Housekeeping: expired messages, idle rooms, dead connections, WAL truncation
  function sweep() {
    const t = now();
    for (const { room, id } of store.purgeExpired(t)) broadcast(room, { t: 'del', id });
  }
  function sweepRooms() {
    store.purgeRequests(now());
    for (const id of store.idleRooms(now() - config.roomIdleDays * 86400_000)) {
      store.deleteRoom(id);
      closeRoom(id);
    }
  }
  function heartbeat() {
    const t = now();
    for (const m of [...pollers.values()]) if (!m.waiting && t - m.lastSeen > POLL_GRACE) drop(m);
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }

  return { handler, upgrade, sweep, sweepRooms, heartbeat, wss, stats: () => ({ rooms: rooms.size, connections, pollers: pollers.size }) };
}
