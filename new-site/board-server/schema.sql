-- 事件墙 (board) schema. Applied on every start; every statement is idempotent.
-- No IP addresses, user agents or other visitor data are stored anywhere.

create table if not exists drafts (
  id          text primary key,
  key_hash    bytea not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create table if not exists posts (
  id            text primary key,
  status        text not null check (status in ('pending', 'published', 'rejected', 'removed', 'withdrawn')),
  title         text not null,
  body          text not null,
  category      text not null,
  place         text not null default '',
  happened_on   date,
  receipt_hash  bytea not null unique,
  reject_reason text not null default '',
  reports       integer not null default 0,
  edited        boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz
);
create index if not exists posts_status_created on posts (status, created_at);
create index if not exists posts_published on posts (published_at desc, id desc) where status = 'published';

create table if not exists images (
  id          text primary key,
  draft_id    text references drafts (id) on delete set null,
  post_id     text references posts (id) on delete cascade,
  pos         integer not null default 0,
  mime        text not null,
  size        integer not null,
  created_at  timestamptz not null default now()
);
create index if not exists images_post on images (post_id, pos);
create index if not exists images_draft on images (draft_id);

create table if not exists comments (
  id            text primary key,
  post_id       text not null references posts (id) on delete cascade,
  status        text not null check (status in ('pending', 'published', 'rejected', 'removed', 'withdrawn')),
  nickname      text not null default '',
  body          text not null,
  receipt_hash  bytea not null unique,
  reports       integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz
);
create index if not exists comments_post on comments (post_id, status, published_at);
create index if not exists comments_status on comments (status, created_at);

-- Who did what in the review queue (admin name from the admins credential, never a person's identity)
create table if not exists mod_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  admin   text not null,
  action  text not null,
  target  text not null,
  note    text not null default ''
);

-- Spent proof-of-work challenges (each can be used once)
create table if not exists pow_used (
  h           bytea primary key,
  expires_at  timestamptz not null
);
