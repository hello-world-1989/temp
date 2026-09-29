// 事件墙: status of a submission or comment by its receipt; withdraw
import { $, call, fmtTime, setMsg, STATUS } from './board-common.js';

const msg = $('#msg');
let current = '';

function row(dl, k, v, href) {
  const dt = document.createElement('dt');
  dt.textContent = k;
  const dd = document.createElement('dd');
  if (href) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = v;
    dd.append(a);
  } else dd.textContent = v;
  const pair = document.createElement('div');
  pair.append(dt, dd);
  dl.append(pair);
}

async function check(receipt) {
  const r = await call('POST', '/api/board/status', { body: { receipt } });
  const dl = $('#kv');
  dl.replaceChildren();
  row(dl, '类型', r.kind === 'post' ? '投稿' : '留言');
  if (r.title) row(dl, r.kind === 'post' ? '标题' : '所在事件', r.title, r.status === 'published' || r.kind === 'comment' ? `/board/e/${encodeURIComponent(r.postId)}` : null);
  row(dl, '状态', STATUS[r.status] || r.status);
  row(dl, '提交日期', r.submittedOn);
  if (r.publishedAt) row(dl, '发布时间', fmtTime(r.publishedAt));
  if (r.rejectReason) row(dl, '管理员说明', r.rejectReason);
  if (r.status === 'rejected') row(dl, '说明', '未通过的内容会在 7 天后彻底删除。可以修改后重新投稿。');
  $('#withdraw').classList.toggle('hidden', r.status === 'withdrawn');
  $('#result').classList.remove('hidden');
  setMsg(msg, '');
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  current = $('#receipt').value.trim();
  if (!current) return setMsg(msg, '请输入回执码', 'warn');
  $('#check').disabled = true;
  $('#result').classList.add('hidden');
  try {
    await check(current);
  } catch (err) {
    setMsg(msg, err.message, 'error');
  } finally {
    $('#check').disabled = false;
  }
});

$('#withdraw').addEventListener('click', async () => {
  if (!confirm('撤回后内容和图片会立即删除，不能恢复。确定撤回？')) return;
  $('#withdraw').disabled = true;
  try {
    await call('POST', '/api/board/withdraw', { body: { receipt: current } });
    await check(current);
    setMsg(msg, '已撤回并删除。', 'ok');
  } catch (err) {
    setMsg(msg, err.message, 'error');
  } finally {
    $('#withdraw').disabled = false;
  }
});
