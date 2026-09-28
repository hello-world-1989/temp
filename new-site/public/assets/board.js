// 事件墙 list
import { $, call, boardMeta, fmtDay, setMsg } from './board-common.js';

const list = $('#list');
const more = $('#more');
const msg = $('#list-msg');
let category = new URLSearchParams(location.search).get('category') || '';
let cursor = null;
let loading = false;

function card(item) {
  const a = document.createElement('a');
  a.className = 'card board-item';
  a.href = `/board/e/${encodeURIComponent(item.id)}`;

  const text = document.createElement('div');
  text.className = 'board-item-text';
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const badge = document.createElement('span');
  badge.className = 'badge soft';
  badge.textContent = item.category;
  meta.append(badge);
  for (const t of [item.happenedOn && fmtDay(item.happenedOn), item.place, item.comments ? `${item.comments} 条留言` : '']) {
    if (!t) continue;
    const s = document.createElement('span');
    s.textContent = t;
    meta.append(s);
  }
  const h = document.createElement('h3');
  h.textContent = item.title;
  const p = document.createElement('p');
  p.className = 'board-excerpt';
  p.textContent = item.excerpt.replace(/\s+/g, ' ') + (item.excerpt.length >= 140 ? '…' : '');
  text.append(meta, h, p);
  a.append(text);

  if (item.cover) {
    const img = document.createElement('img');
    img.className = 'board-cover';
    img.src = `/api/board/img/${encodeURIComponent(item.cover)}`;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    a.append(img);
  }
  return a;
}

async function load(reset = false) {
  if (loading) return;
  loading = true;
  more.disabled = true;
  if (reset) {
    cursor = null;
    list.replaceChildren();
  }
  setMsg(msg, '加载中…');
  try {
    const q = new URLSearchParams({ limit: '20' });
    if (category) q.set('category', category);
    if (cursor) q.set('cursor', cursor);
    const data = await call('GET', `/api/board/posts?${q}`);
    for (const item of data.items) list.append(card(item));
    cursor = data.nextCursor;
    more.classList.toggle('hidden', !cursor);
    setMsg(msg, list.children.length ? '' : '这里还没有内容。你可以成为第一个投稿的人。');
  } catch (err) {
    setMsg(msg, err.message, 'error');
  } finally {
    loading = false;
    more.disabled = false;
  }
}

async function tabs() {
  const { categories } = await boardMeta().catch(() => ({ categories: [] }));
  const box = $('#cats');
  for (const c of ['', ...categories]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(c === category));
    b.textContent = c || '全部';
    b.addEventListener('click', () => {
      category = c;
      for (const x of box.children) x.setAttribute('aria-selected', String(x === b));
      history.replaceState(null, '', c ? `?category=${encodeURIComponent(c)}` : location.pathname);
      load(true);
    });
    box.append(b);
  }
}

more.addEventListener('click', () => load());
tabs();
load(true);
