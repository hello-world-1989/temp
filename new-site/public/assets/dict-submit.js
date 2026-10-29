// 和谐词典: suggest a word. Goes to the 事件墙 service, waits for review like a 事件墙 post;
// the receipt works on /board-status (status, withdraw).
import { $, call, boardMeta, proofOfWork, setMsg, rememberReceipt } from './board-common.js';
import { CATEGORIES } from './dict-render.js';
import { copyText } from './site.js';
import './dict-common.js';

const form = $('#form');
const msg = $('#msg');
const sel = $('#category');
for (const c of CATEGORIES) sel.append(new Option(c, c));
boardMeta()
  .then((m) => {
    if (!m.dictCategories) setMsg(msg, '投稿服务还没更新，暂时不能提交。', 'warn');
  })
  .catch(() => setMsg(msg, '投稿服务暂时连不上，可以稍后再试。', 'warn'));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    word: $('#word').value.trim(),
    alternatives: $('#alts').value,
    category: sel.value,
    reason: $('#reason').value.trim(),
    example: $('#example').value.trim(),
    trivia: $('#trivia').value.trim(),
  };
  if (!body.word || !body.alternatives.trim() || !body.reason) return setMsg(msg, '请填写原词、替代写法和原因', 'warn');
  const btn = $('#submit');
  btn.disabled = true;
  try {
    setMsg(msg, '正在做防刷验证（几秒钟，不收集任何信息）…');
    body.pow = await proofOfWork('word', (p) => setMsg(msg, `正在做防刷验证… ${Math.round(p * 100)}%`));
    setMsg(msg, '正在提交…');
    const r = await call('POST', '/api/board/dict', { body });
    form.classList.add('hidden');
    $('#receipt').textContent = r.receipt;
    $('#done').classList.remove('hidden');
    rememberReceipt($('#receipt-saved'), { receipt: r.receipt, kind: 'word', title: body.word });
  } catch (err) {
    setMsg(msg, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#copy-receipt').addEventListener('click', () => copyText($('#receipt').textContent));
