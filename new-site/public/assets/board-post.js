// 事件墙: one event, its comments, the comment form
import { $, call, boardMeta, fmtDay, fmtTime, paragraphs, proofOfWork, setMsg } from './board-common.js';
import { copyText } from './site.js';

const id = decodeURIComponent(location.pathname.split('/')[3] || new URLSearchParams(location.search).get('id') || '');
const box = $('#post');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderComments(comments) {
  const list = $('#comments');
  list.replaceChildren();
  $('#comment-count').textContent = comments.length ? `（${comments.length}）` : '';
  if (!comments.length) list.append(el('p', 'muted', '还没有留言。'));
  comments.forEach((c, i) => {
    const item = el('div', 'board-comment');
    const meta = el('div', 'item-meta');
    meta.append(el('strong', '', c.nickname || '匿名'), el('span', '', `#${i + 1}`), el('span', '', fmtTime(c.publishedAt)));
    const report = el('button', 'board-link', '举报');
    report.type = 'button';
    report.addEventListener('click', () => reportIt('comment', c.id, report));
    meta.append(report);
    const body = el('div', 'board-body');
    paragraphs(body, c.body);
    item.append(meta, body);
    list.append(item);
  });
}

async function reportIt(target, targetId, btn) {
  if (!confirm('举报这条内容？管理员会重新检查。')) return;
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    await call('POST', '/api/board/report', { body: { target, id: targetId, pow: await proofOfWork('report') } });
    btn.textContent = '已举报';
  } catch (err) {
    btn.textContent = '举报';
    btn.disabled = false;
    alert(err.message);
  }
}

async function load() {
  try {
    const post = await call('GET', `/api/board/posts/${encodeURIComponent(id)}`);
    document.title = `${post.title} | 事件墙 | 大翻墙运动`;
    box.replaceChildren();
    const meta = el('div', 'item-meta');
    meta.append(el('span', 'badge soft', post.category));
    if (post.happenedOn) meta.append(el('span', '', `发生于 ${fmtDay(post.happenedOn)}`));
    if (post.place) meta.append(el('span', '', post.place));
    const h1 = el('h1', 'board-title', post.title);
    const body = el('div', 'board-body');
    paragraphs(body, post.body);
    box.append(meta, h1, body);

    if (post.images.length) {
      const gallery = el('div', 'board-gallery');
      for (const im of post.images) {
        const a = el('a');
        a.href = `/api/board/img/${encodeURIComponent(im.id)}`;
        a.target = '_blank';
        a.rel = 'noopener';
        const img = el('img');
        img.src = a.href;
        img.alt = '投稿图片';
        img.loading = 'lazy';
        a.append(img);
        gallery.append(a);
      }
      box.append(gallery);
    }

    const foot = el('div', 'item-meta board-foot');
    foot.append(el('span', '', `发布于 ${fmtTime(post.publishedAt)}${post.edited ? '（发布后经管理员修改）' : ''}`));
    const copy = el('button', 'btn btn-ghost btn-sm', '复制链接');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(location.href.split('#')[0]));
    const report = el('button', 'board-link', '举报');
    report.type = 'button';
    report.addEventListener('click', () => reportIt('post', post.id, report));
    foot.append(copy, report);
    box.append(foot);

    renderComments(post.comments);
    $('#comment-form').classList.remove('hidden');
  } catch (err) {
    box.replaceChildren(el('p', `notice ${err.status === 404 ? 'warn' : 'error'}`, err.message));
    $('#comments-title').parentElement.classList.add('hidden');
  }
}

boardMeta()
  .then((m) => {
    if (!m.commentPremod) $('#premod-note').textContent = '留言提交后直接显示。不要写你的真实姓名、电话或住址。';
  })
  .catch(() => {});

$('#comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#comment-msg');
  const body = $('#comment').value.trim();
  if (!body) return setMsg(out, '请先写留言', 'warn');
  const btn = $('#comment-submit');
  btn.disabled = true;
  try {
    setMsg(out, '正在进行防刷验证，需要几秒钟…');
    const pow = await proofOfWork('comment');
    setMsg(out, '提交中…');
    const r = await call('POST', `/api/board/posts/${encodeURIComponent(id)}/comments`, { body: { body, nickname: $('#nickname').value.trim(), pow } });
    $('#comment').value = '';
    if (r.status === 'published') {
      setMsg(out, '留言已发布。', 'ok');
      load();
    } else {
      setMsg(out, `留言已提交，审核通过后显示。想撤回的话，保存这个回执码，到“查询投稿状态”页面撤回：${r.receipt}`, 'ok');
    }
  } catch (err) {
    setMsg(out, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

load();
