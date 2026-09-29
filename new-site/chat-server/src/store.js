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
