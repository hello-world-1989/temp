import { $, esc, fmtBytes, fmtDate, copyText } from './site.js';
import qrcode from './vendor/qrcode.js';
import { MAX_FILE, encryptFile, b64url, sha256hex } from './share-crypto.js';

function msg(el, text, kind = '') {
  el.className = `notice mt ${kind}`;
  el.textContent = text;
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// XMLHttpRequest for upload progress (fetch has none)
function post(body, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/share');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) resolve(data);
      else reject(new Error(data?.error || `上传失败（${xhr.status}）`));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.send(body);
  });
}

let current = null; // { id, deleteToken }

$('#file').addEventListener('change', () => {
  const f = $('#file').files[0];
  $('#file-info').textContent = f ? `${f.name} · ${fmtBytes(f.size)}${f.size > MAX_FILE ? '（超过 50 MB，无法上传）' : ''}` : '';
});

$('#up-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#up-msg');
  const file = $('#file').files[0];
  const password = $('#password').value;
  if (!file) return msg(out, '请先选择文件', 'warn');
  if (file.size > MAX_FILE) return msg(out, '文件太大，最大 50 MB', 'warn');
  if (!window.crypto?.subtle) return msg(out, '这个浏览器不支持加密，请换用最新版的 Chrome、Safari 或 Edge', 'error');

  $('#up-submit').disabled = true;
  try {
    msg(out, password ? '正在加密（设置了密码，需要几秒钟）…' : '正在加密…');
    const { blob, linkKey, deleteToken } = await encryptFile(file, password);
    msg(out, '正在上传… 0%');
    const res = await post(
      blob,
      { 'Content-Type': 'application/octet-stream', 'X-Delete-Hash': await sha256hex(deleteToken), 'X-Share-Password': password ? '1' : '0' },
      (p) => msg(out, `正在上传… ${Math.floor(p * 100)}%`),
    );
    current = { id: res.id, deleteToken };
    const link = `${location.origin}/s/${res.id}#${b64url(linkKey)}`;
    $('#link').textContent = link;
    $('#link-box').onclick = () => copyText(link);
    $('#link-qr').innerHTML = qrSvg(link);
    $('#pw-note').hidden = !password;
    $('#meta').innerHTML = [
      ['文件', esc(file.name)],
      ['大小', fmtBytes(file.size)],
      ['有效期至', fmtDate(res.expiresAt)],
      ['密码', password ? '已设置' : '未设置'],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
      .join('');
    $('#del-btn').disabled = false;
    msg($('#del-msg'), '');
    $('#result').hidden = false;
    msg(out, '上传完成。可以继续分享其他文件。', 'ok');
    $('#up-form').reset();
    $('#file-info').textContent = '';
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    msg(out, err.message || '上传失败，请稍后再试', 'error');
  } finally {
    $('#up-submit').disabled = false;
  }
});

$('#del-btn').addEventListener('click', async () => {
  if (!current) return;
  $('#del-btn').disabled = true;
  try {
    const res = await fetch(`/api/share/${current.id}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: current.deleteToken }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '删除失败');
    msg($('#del-msg'), '已删除，这个链接已失效。', 'ok');
  } catch (err) {
    $('#del-btn').disabled = false;
    msg($('#del-msg'), err.message || '删除失败，请稍后再试', 'error');
  }
});
