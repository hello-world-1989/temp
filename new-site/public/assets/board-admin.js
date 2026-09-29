// 事件墙 review queue. The admin token stays in sessionStorage (this tab only) and is sent
// as a Bearer token; images are fetched with it and shown as blob: URLs.
import { $, call, boardMeta, fmtTime, setMsg, STATUS } from './board-common.js';

const KEY = 'board-admin-token';
const store = {
  get: () => {
    try {
      return sessionStorage.getItem(KEY) || '';
    } catch {
      return '';
    }
  },
  set: (v) => {
    try {
      v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY);
    } catch {}
  },
};
let token = store.get();
let categories = [];
const blobs = [];

const TABS = [
  { id: 'posts-pending', label: '待审投稿', type: 'posts', status: 'pending', count: 'posts' },
  { id: 'comments-pending', label: '待审留言', type: 'comments', status: 'pending', count: 'comments' },
  { id: 'posts-reported', label: '被举报投稿', type: 'posts', status: 'reported' },
  { id: 'comments-reported', label: '被举报留言', type: 'comments', status: 'reported' },
  { id: 'posts-published', label: '已发布', type: 'posts', status: 'published' },
  { id: 'posts-rejected', label: '未通过', type: 'posts', status: 'rejected' },
  { id: 'posts-removed', label: '已下架', type: 'posts', status: 'removed' },
  { id: 'comments-published', label: '已发布留言', type: 'comments', status: 'published' },
  { id: 'log', label: '操作记录' },
];
let tab = TABS[0];

const auth = () => ({ Authorization: `Bearer ${token}` });
const acall = (method, path, opts = {}) => call(method, path, { ...opts, headers: { ...auth(), ...(opts.headers || {}) } });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function field(label, input) {
  const f = el('div', 'field mt');
  const l = el('label', '', label);
  f.append(l, input);
  return f;
}

function input(value, { tag = 'input', type = 'text', max } = {}) {
  const i = el(tag, `input${tag === 'textarea' ? ' board-textarea' : ''}`);
  if (tag === 'input') i.type = type;
  if (max) i.maxLength = max;
  i.value = value ?? '';
  return i;
}

async function adminImage(id) {
  const res = await fetch(`/api/board/admin/img/${encodeURIComponent(id)}`, { headers: auth() });
  if (!res.ok) throw new Error('图片加载失败');
  const url = URL.createObjectURL(await res.blob());
  blobs.push(url);
  return url;
}

function postCard(p) {
  const card = el('article', 'card feature board-admin-item');
  const meta = el('div', 'item-meta');
  meta.append(el('span', 'badge soft', STATUS[p.status] || p.status), el('span', '', `提交于 ${fmtTime(p.createdAt)}`));
  if (p.publishedAt) meta.append(el('a', '', '查看页面'));
  if (p.publishedAt) {
    const a = meta.lastChild;
    a.href = `/board/e/${encodeURIComponent(p.id)}`;
    a.target = '_blank';
  }
  if (p.status === 'published') meta.append(el('span', '', `浏览 ${p.views} 次`));
  if (p.reports) meta.append(el('span', 'badge warn', `举报 ${p.reports}`));
  card.append(meta);

  const title = input(p.title, { max: 80 });
  const cat = el('select', 'input');
  for (const c of categories) {
    const o = el('option', '', c);
    o.value = c;
    cat.append(o);
  }
  cat.value = p.category;
  const date = input(p.happenedOn || '', { type: 'date' });
  const place = input(p.place, { max: 60 });
  const body = input(p.body, { tag: 'textarea', max: 5000 });
  body.rows = 8;
  const row = el('div', 'grid grid-3');
  row.append(field('分类', cat), field('发生日期', date), field('地点', place));
  card.append(field('标题', title), row, field('经过', body));

  const drop = new Set();
  if (p.images.length) {
    const gallery = el('div', 'board-thumbs');
    for (const im of p.images) {
      const fig = el('figure');
      const img = el('img');
      img.alt = '投稿图片';
      adminImage(im.id).then((u) => (img.src = u)).catch(() => (img.alt = '图片加载失败'));
      const open = el('button', 'btn btn-ghost btn-sm', '看大图');
      open.type = 'button';
      open.addEventListener('click', () => img.src && window.open(img.src, '_blank', 'noopener'));
      const label = el('label', 'board-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => {
        cb.checked ? drop.add(im.id) : drop.delete(im.id);
        fig.classList.toggle('dropped', cb.checked);
      });
      label.append(cb, document.createTextNode(' 删除这张'));
      fig.append(img, open, label);
      gallery.append(fig);
    }
    card.append(field(`图片（${p.images.length}）`, gallery));
  }

  const reason = input(p.rejectReason, { max: 200 });
  reason.placeholder = '拒绝或下架时写给投稿人的说明（投稿人用回执码可以看到）';
  card.append(field('说明', reason));

  const out = el('p', 'notice mt');
  const actions = el('div', 'row mt board-actions');
  const act = (label, action, primary = false) => {
    const b = el('button', `btn ${primary ? 'btn-primary' : 'btn-ghost'}`, label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      if ((action === 'reject' || action === 'remove') && !reason.value.trim() && !confirm('没有写说明，确定继续？')) return;
      for (const x of actions.children) x.disabled = true;
      try {
        const payload = { action, title: title.value, body: body.value, place: place.value, category: cat.value, happenedOn: date.value || null, reason: reason.value, removeImages: [...drop] };
        const r = await acall('POST', `/api/board/admin/posts/${encodeURIComponent(p.id)}`, { body: payload });
        setMsg(out, `已${label}：${STATUS[r.status] || r.status}`, 'ok');
        if (action !== 'edit' && action !== 'clear-reports') setTimeout(() => card.remove(), 800);
        refreshCounts();
      } catch (err) {
        setMsg(out, err.message, 'error');
      } finally {
        for (const x of actions.children) x.disabled = false;
      }
    });
    actions.append(b);
  };
  if (p.status === 'pending') {
    act('通过并发布', 'approve', true);
    act('拒绝', 'reject');
    act('保存修改', 'edit');
  } else if (p.status === 'published') {
    act('保存修改', 'edit', true);
    act('下架', 'remove');
    if (p.reports) act('清除举报', 'clear-reports');
  } else {
    act('重新发布', 'restore', true);
  }
  card.append(actions, out);
  return card;
}

function commentCard(c) {
  const card = el('article', 'card feature board-admin-item');
  const meta = el('div', 'item-meta');
  meta.append(el('span', 'badge soft', STATUS[c.status] || c.status), el('strong', '', c.nickname || '匿名'), el('span', '', fmtTime(c.createdAt)));
  if (c.reports) meta.append(el('span', 'badge warn', `举报 ${c.reports}`));
  const on = el('p', 'muted');
  on.append('所在事件：');
  const a = el('a', '', c.postTitle);
  a.href = `/board/e/${encodeURIComponent(c.postId)}`;
  a.target = '_blank';
  on.append(a);
  const body = el('p', 'board-pre', c.body);
  const out = el('p', 'notice mt');
  const actions = el('div', 'row mt board-actions');
  const act = (label, action, primary = false) => {
    const b = el('button', `btn ${primary ? 'btn-primary' : 'btn-ghost'}`, label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      for (const x of actions.children) x.disabled = true;
      try {
        await acall('POST', `/api/board/admin/comments/${encodeURIComponent(c.id)}`, { body: { action } });
        setMsg(out, `已${label}`, 'ok');
        if (action !== 'clear-reports') setTimeout(() => card.remove(), 600);
        refreshCounts();
      } catch (err) {
        setMsg(out, err.message, 'error');
      } finally {
        for (const x of actions.children) x.disabled = false;
      }
    });
    actions.append(b);
  };
  if (c.status === 'pending') {
    act('通过', 'approve', true);
    act('拒绝', 'reject');
  } else if (c.status === 'published') {
    act('下架', 'remove');
    if (c.reports) act('清除举报', 'clear-reports');
  } else act('恢复', 'restore', true);
  card.append(meta, on, body, actions, out);
  return card;
}

let counts = { posts: 0, comments: 0 };
function renderTabs() {
  const box = $('#tabs');
  box.replaceChildren();
  for (const t of TABS) {
    const b = el('button', 'tab', t.count && counts[t.count] ? `${t.label}（${counts[t.count]}）` : t.label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t === tab));
    b.addEventListener('click', () => {
      tab = t;
      renderTabs();
      load();
    });
    box.append(b);
  }
}

async function refreshCounts() {
  try {
    const r = await acall('GET', '/api/board/admin/queue?type=posts&status=pending');
    counts = r.pending;
    renderTabs();
  } catch {}
}

async function load() {
  const list = $('#items');
  const msg = $('#msg');
  for (const u of blobs.splice(0)) URL.revokeObjectURL(u);
  list.replaceChildren();
  setMsg(msg, '加载中…');
  try {
    if (tab.id === 'log') {
      const r = await acall('GET', '/api/board/admin/log?limit=200');
      const table = el('table', 'board-log');
      for (const i of r.items) {
        const tr = el('tr');
        for (const v of [fmtTime(i.at), i.admin, i.action, i.target, i.note]) tr.append(el('td', '', v));
        table.append(tr);
      }
      list.append(table);
      setMsg(msg, r.items.length ? '' : '还没有记录');
      return;
    }
    const r = await acall('GET', `/api/board/admin/queue?type=${tab.type}&status=${tab.status}`);
    counts = r.pending;
    renderTabs();
    for (const item of r.items) list.append(tab.type === 'posts' ? postCard(item) : commentCard(item));
    setMsg(msg, r.items.length ? '' : '没有内容');
  } catch (err) {
    if (err.status === 401) return logout('口令无效或已被停用');
    setMsg(msg, err.message, 'error');
  }
}

function logout(reason = '') {
  token = '';
  store.set('');
  $('#panel').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#who').textContent = '';
  setMsg($('#login-msg'), reason, reason ? 'error' : '');
}

async function start() {
  try {
    const { admin } = await acall('GET', '/api/board/admin/me');
    categories = (await boardMeta()).categories;
    $('#login').classList.add('hidden');
    $('#panel').classList.remove('hidden');
    $('#who').replaceChildren(`已登录：${admin} · `);
    const out = el('button', 'board-link', '退出');
    out.type = 'button';
    out.addEventListener('click', () => logout());
    $('#who').append(out);
    renderTabs();
    load();
  } catch (err) {
    logout(err.status === 401 ? '口令不正确' : err.message);
  }
}

$('#login').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('#token').value.trim();
  $('#token').value = '';
  store.set(token);
  start();
});

if (token) start();
