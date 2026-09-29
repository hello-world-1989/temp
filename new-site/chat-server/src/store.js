// SQLite storage, owned by this one process. Holds only ciphertext and the hashes that let
// key holders in: no IP addresses, nicknames, room names or message text.
//
// 阅后即焚 on disk: secure_delete overwrites deleted rows in the database file, and the WAL
// (where deleted content can linger until a checkpoint) is truncated every minute.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
create table if not exists rooms (
  id          text primary key,
  auth_hash   blob not null,          -- sha256(HKDF(room key, "auth")): proves the key, is not it
  owner_hash  blob not null,          -- sha256(owner token): may destroy the room
  meta        blob not null,          -- room name etc., encrypted with the room key
  created_at  integer not null,
  last_at     integer not null        -- last message; idle rooms are deleted
) strict;

create table if not exists messages (
  room      text not null references rooms (id) on delete cascade,
  id        integer not null,
  ts        integer not null,
  exp       integer not null,         -- deleted at this time (ms)
  burn      integer not null default 0, -- seconds left once someone else has read it (0: off)
  del_hash  blob not null,            -- sha256(delete token) held by the sender (撤回)
  ct        blob not null,
  primary key (room, id)
) strict;
create index if not exists messages_exp on messages (exp);

create table if not exists pow_used (
  h    blob primary key,
  exp  integer not null
) strict;

-- 迁移到新设备: one encrypted copy of a vault, taken once, gone after 10 minutes at most
create table if not exists transfers (
  id    text primary key,
  blob  blob not null,
  exp   integer not null
) strict;

-- 公开事件群 (listing) and 申请加入: see app.js. Only rooms whose owner asks to be listed have
-- a public name; join requests are encrypted to the owner's key (info) and the approval to the
-- requester's key (sealed). Owner keys: public raw P-256, private boxed with the owner token.
create table if not exists join_requests (
  id           text primary key,
  room         text not null references rooms (id) on delete cascade,
  req_pub      blob not null,
  info         blob not null,
  secret_hash  blob not null,
  status       text not null default 'pending', -- pending | approved | rejected
  sealed       blob,
  created_at   integer not null,
  decided_at   integer not null default 0
) strict;
create index if not exists join_requests_room on join_requests (room, status);

-- 恢复口令 backups: the vault encrypted with a key from a generated phrase; id and write hash
-- are derived from the same phrase, so the server never sees anything that opens them
create table if not exists backups (
  id          text primary key,
  blob        blob not null,
  write_hash  blob not null,
  updated_at  integer not null
) strict;

create table if not exists mirrors (
  ip          text primary key,
  last_seen   integer not null,
  failed_at   integer not null default 0
) strict;
`;

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('secure_delete = ON');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_size_limit = 1048576');
  db.exec(SCHEMA);
  // Columns added after the first release (SQLite has no "add column if not exists")
  const cols = new Set(db.prepare('pragma table_info(rooms)').all().map((c) => c.name));
  for (const [name, def] of [
    ['pub_state', 'integer not null default 0'], // 0 private, 1 waiting for review, 2 listed, 3 not approved
    ['pub_name', "text not null default ''"],
    ['pub_desc', "text not null default ''"],
    ['pub_reason', "text not null default ''"],
    ['pub_at', 'integer not null default 0'],
    ['owner_pub', 'blob'],
    ['owner_box', 'blob'],
  ]) if (!cols.has(name)) db.exec(`alter table rooms add column ${name} ${def}`);

  const q = {
    roomCount: db.prepare('select count(*) as n from rooms'),
    roomGet: db.prepare('select * from rooms where id = ?'),
    roomAdd: db.prepare('insert into rooms (id, auth_hash, owner_hash, meta, created_at, last_at) values (?, ?, ?, ?, ?, ?)'),
    roomTouch: db.prepare('update rooms set last_at = ? where id = ?'),
    roomDel: db.prepare('delete from rooms where id = ?'),
    roomIdle: db.prepare('select id from rooms where last_at < ?'),
    msgNextId: db.prepare('select coalesce(max(id), 0) + 1 as id, count(*) as n from messages where room = ?'),
    msgOldest: db.prepare('select id from messages where room = ? order by id limit ?'),
    msgAdd: db.prepare('insert into messages (room, id, ts, exp, burn, del_hash, ct) values (?, ?, ?, ?, ?, ?, ?)'),
    msgGet: db.prepare('select * from messages where room = ? and id = ?'),
    msgDel: db.prepare('delete from messages where room = ? and id = ?'),
    msgExp: db.prepare('update messages set exp = ?, burn = 0 where room = ? and id = ?'),
    msgAfter: db.prepare('select id, ts, exp, burn, ct from messages where room = ? and id > ? and exp > ? order by id desc limit ?'),
    msgExpired: db.prepare('select room, id from messages where exp <= ?'),
    msgPurge: db.prepare('delete from messages where exp <= ?'),
    powUse: db.prepare('insert or ignore into pow_used (h, exp) values (?, ?)'),
    powPurge: db.prepare('delete from pow_used where exp <= ?'),
    xferCount: db.prepare('select count(*) as n from transfers'),
    xferAdd: db.prepare('insert into transfers (id, blob, exp) values (?, ?, ?)'),
    xferTake: db.prepare('delete from transfers where id = ? and exp > ? returning blob'),
    xferPurge: db.prepare('delete from transfers where exp <= ?'),
    publish: db.prepare('update rooms set pub_state = 1, pub_name = ?, pub_desc = ?, pub_reason = \'\', pub_at = ?, owner_pub = ?, owner_box = ? where id = ?'),
    unpublish: db.prepare('update rooms set pub_state = 0 where id = ?'),
    review: db.prepare('update rooms set pub_state = ?, pub_reason = ?, pub_at = ? where id = ? and pub_state in (1, 2, 3)'),
    listed: db.prepare('select id, pub_name, pub_desc, pub_at, owner_pub from rooms where pub_state = 2 order by pub_at desc limit ?'),
    listings: db.prepare('select id, pub_state, pub_name, pub_desc, pub_reason, pub_at from rooms where pub_state = ? order by pub_at desc limit 200'),
    reqAdd: db.prepare('insert into join_requests (id, room, req_pub, info, secret_hash, created_at) values (?, ?, ?, ?, ?, ?)'),
    reqGet: db.prepare('select * from join_requests where id = ?'),
    reqPending: db.prepare("select id, req_pub, info, created_at from join_requests where room = ? and status = 'pending' order by created_at limit 200"),
    reqPendingCount: db.prepare("select count(*) as n from join_requests where room = ? and status = 'pending'"),
    reqDecide: db.prepare("update join_requests set status = ?, sealed = ?, decided_at = ? where id = ? and room = ? and status = 'pending'"),
    reqPurge: db.prepare("delete from join_requests where (status != 'pending' and decided_at < ?) or created_at < ?"),
    backupGet: db.prepare('select * from backups where id = ?'),
    backupCount: db.prepare('select count(*) as n from backups'),
    backupPut: db.prepare('insert into backups (id, blob, write_hash, updated_at) values (?, ?, ?, ?) on conflict (id) do update set blob = excluded.blob, updated_at = excluded.updated_at'),
    backupDel: db.prepare('delete from backups where id = ?'),
    mirrorSeen: db.prepare('insert into mirrors (ip, last_seen) values (?, ?) on conflict (ip) do update set last_seen = excluded.last_seen'),
    mirrorFail: db.prepare('update mirrors set failed_at = ? where ip = ?'),
    mirrorList: db.prepare('select * from mirrors'),
    mirrorDel: db.prepare('delete from mirrors where ip = ?'),
  };

  const addMessage = db.transaction((room, ts, exp, burn, delHash, ct, keep) => {
    const { id, n } = q.msgNextId.get(room);
    // A full room drops its oldest messages
    if (n >= keep) for (const old of q.msgOldest.all(room, n - keep + 1)) q.msgDel.run(room, old.id);
    q.msgAdd.run(room, id, ts, exp, burn, delHash, ct);
    q.roomTouch.run(ts, room);
    return id;
  });

  return {
    db,
    roomCount: () => q.roomCount.get().n,
    getRoom: (id) => q.roomGet.get(id),
    addRoom: (r) => q.roomAdd.run(r.id, r.authHash, r.ownerHash, r.meta, r.now, r.now),
    deleteRoom: (id) => q.roomDel.run(id).changes > 0,
    idleRooms: (before) => q.roomIdle.all(before).map((r) => r.id),
    addMessage: (room, m, keep) => addMessage(room, m.ts, m.exp, m.burn, m.delHash, m.ct, keep),
    getMessage: (room, id) => q.msgGet.get(room, id),
    deleteMessage: (room, id) => q.msgDel.run(room, id).changes > 0,
    setExpiry: (room, id, exp) => q.msgExp.run(exp, room, id),
    // Newest `limit` live messages after `after`, oldest first
    history: (room, after, now, limit) => q.msgAfter.all(room, after, now, limit).reverse(),
    // -> [{ room, id }] of the messages it deleted
    purgeExpired: db.transaction((now) => {
      const gone = q.msgExpired.all(now);
      q.msgPurge.run(now);
      q.powPurge.run(now);
      q.xferPurge.run(now);
      return gone;
    }),
    transferCount: () => q.xferCount.get().n,
    addTransfer: (id, blob, exp) => q.xferAdd.run(id, blob, exp),
    // The blob, deleted in the same statement: a second download finds nothing
    takeTransfer: (id, now) => q.xferTake.get(id, now)?.blob || null,
    publish: (id, r, now) => q.publish.run(r.name, r.desc, now, r.ownerPub, r.ownerBox, id),
    unpublish: (id) => q.unpublish.run(id),
    review: (id, state, reason, now) => q.review.run(state, reason, now, id).changes > 0,
    listed: (limit) => q.listed.all(limit),
    listings: (state) => q.listings.all(state),
    addRequest: (r) => q.reqAdd.run(r.id, r.room, r.reqPub, r.info, r.secretHash, r.now),
    getRequest: (id) => q.reqGet.get(id),
    pendingRequests: (room) => q.reqPending.all(room),
    pendingCount: (room) => q.reqPendingCount.get(room).n,
    decideRequest: (room, id, status, sealed, now) => q.reqDecide.run(status, sealed, now, id, room).changes > 0,
    // Decided requests are kept 7 days (the requester may look again); undecided ones 30 days
    purgeRequests: (now) => q.reqPurge.run(now - 7 * 86400_000, now - 30 * 86400_000),
    getBackup: (id) => q.backupGet.get(id),
    backupCount: () => q.backupCount.get().n,
    putBackup: (id, blob, writeHash, now) => q.backupPut.run(id, blob, writeHash, now),
    deleteBackup: (id) => q.backupDel.run(id).changes > 0,
    // true the first time a challenge is spent
    usePow: (hash, exp) => q.powUse.run(hash, exp).changes > 0,
    mirrorSeen: (ip, now) => q.mirrorSeen.run(ip, now),
    mirrorFailed: (ip, now) => q.mirrorFail.run(now, ip),
    mirrors: () => q.mirrorList.all(),
    deleteMirror: (ip) => q.mirrorDel.run(ip),
    checkpoint: () => db.pragma('wal_checkpoint(TRUNCATE)'),
    close: () => db.close(),
  };
}
