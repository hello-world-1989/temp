// 事件墙: anonymous submission
// Photos are cleaned in the browser before upload (share-meta.js: GPS, time, camera, thumbnails
// removed); the server cleans them again.
import { $, call, boardMeta, proofOfWork, rememberReceipt, setMsg } from './board-common.js';
import { copyText } from './site.js';
import { kindOf, stripMetadata } from './share-meta.js';
import { redact } from './board-redact.js';

const msg = $('#msg');
const picked = []; // { file, url, redacted }
let meta = { maxImages: 6, maxImageBytes: 8 * 1024 * 1024, categories: [] };
let draft = null; // kept for retries after a failed upload: { draftId, draftKey, uploaded: Map(file -> imageId) }

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function renderThumbs() {
  const box = $('#thumbs');
  box.replaceChildren();
  picked.forEach((p, i) => {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = p.url;
    img.alt = `图片 ${i + 1}`;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn-ghost btn-sm';
    edit.textContent = p.redacted ? '打码 ✓' : '打码';
    edit.addEventListener('click', async () => {
      const out = await redact(p.file);
      if (!out || out === p.file) return;
      URL.revokeObjectURL(p.url);
      picked[i] = { file: out, url: URL.createObjectURL(out), redacted: true };
      renderThumbs();
    });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn-ghost btn-sm';
    rm.textContent = '移除';
    rm.addEventListener('click', () => {
      URL.revokeObjectURL(p.url);
      picked.splice(i, 1);
      renderThumbs();
    });
    const row = document.createElement('div');
    row.className = 'board-thumb-actions';
    row.append(edit, rm);
    fig.append(img, row);
    box.append(fig);
  });
}

$('#images').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    if (picked.length >= meta.maxImages) {
      setMsg(msg, `最多 ${meta.maxImages} 张图片`, 'warn');
      break;
    }
    const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
    if (!kindOf(head)) {
      setMsg(msg, `“${f.name}”不是 JPEG、PNG 或 WebP 图片。iPhone 的 HEIC 照片请先截图或在相册里导出为 JPEG。`, 'warn');
      continue;
    }
    try {
      const { file } = await stripMetadata(f);
      if (file.size > meta.maxImageBytes) {
        setMsg(msg, `“${f.name}”太大（${mb(file.size)}），单张不能超过 ${mb(meta.maxImageBytes)}`, 'warn');
        continue;
      }
      picked.push({ file, url: URL.createObjectURL(file) });
    } catch {
      setMsg(msg, `“${f.name}”无法读取，可能已损坏`, 'warn');
    }
  }
  renderThumbs();
});

$('#body').addEventListener('input', () => {
  const n = [...$('#body').value].length;
  $('#body-count').textContent = n ? `${n} / 5000` : '';
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = {
    title: $('#title').value.trim(),
    category: $('#category').value,
    happenedOn: $('#date').value || null,
    place: $('#place').value.trim(),
    body: $('#body').value.trim(),
  };
  if (!fields.title) return setMsg(msg, '请填写标题', 'warn');
  if ([...fields.body].length < 10) return setMsg(msg, '请写清楚经过（至少 10 个字）', 'warn');

  const btn = $('#submit');
  btn.disabled = true;
  try {
    if (!draft) {
      setMsg(msg, '正在进行防刷验证，需要几秒到十几秒…');
      const pow = await proofOfWork('post');
      const d = await call('POST', '/api/board/drafts', { body: { pow } });
      draft = { ...d, uploaded: new Map() };
    }
    const headers = { 'x-draft-key': draft.draftKey };
    // Images removed from the picker after a failed attempt are removed from the draft too
    for (const [file, imageId] of draft.uploaded) {
      if (!picked.some((p) => p.file === file)) {
        await call('DELETE', `/api/board/drafts/${draft.draftId}/images/${imageId}`, { headers });
        draft.uploaded.delete(file);
      }
    }
    let n = 0;
    for (const p of picked) {
      n++;
      if (draft.uploaded.has(p.file)) continue;
      setMsg(msg, `上传图片 ${n} / ${picked.length}…`);
      const r = await call('PUT', `/api/board/drafts/${draft.draftId}/images`, { raw: p.file, headers: { ...headers, 'Content-Type': p.file.type || 'application/octet-stream' } });
      draft.uploaded.set(p.file, r.imageId);
    }
    setMsg(msg, '提交中…');
    const r = await call('POST', `/api/board/drafts/${draft.draftId}/submit`, { body: fields, headers });
    draft = null;
    $('#form').classList.add('hidden');
    $('#receipt').textContent = r.receipt;
    $('#done').classList.remove('hidden');
    rememberReceipt($('#receipt-saved'), { receipt: r.receipt, kind: 'post', title: fields.title });
    $('#done').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    // An expired or unknown draft cannot be reused; the next attempt starts a new one
    if (err.status === 404) draft = null;
    setMsg(msg, err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#copy-receipt').addEventListener('click', () => copyText($('#receipt').textContent));

boardMeta()
  .then((m) => {
    meta = m;
    const sel = $('#category');
    for (const c of m.categories) {
      const o = document.createElement('option');
      o.value = o.textContent = c;
      sel.append(o);
    }
    sel.value = m.categories.includes('其他') ? '其他' : m.categories[0];
    $('#date').max = new Date().toISOString().slice(0, 10);
  })
  .catch((err) => setMsg(msg, `事件墙暂时无法使用：${err.message}`, 'error'));
