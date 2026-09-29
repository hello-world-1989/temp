import { $, esc, fmtBytes, fmtDate, copyText, guardOfficial } from './site.js';

guardOfficial('加密分享');
import qrcode from './vendor/qrcode.js';
import { MAX_FILE, encryptFile, b64url, sha256hex } from './share-crypto.js';
import { stripMetadata, kindOf } from './share-meta.js';

// Other addresses of this site (mirror IPs, the main domain) for backup links
const backupsReady = fetch('/api/share/mirrors', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : {}))
  .then((d) => [...(d.mirrors || []), ...(d.site || [])].filter((o) => o !== location.origin))
  .catch(() => []);

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

async function metaNote() {
  const f = $('#file').files[0];
  const note = $('#meta-note');
  if (!f) return msg(note, '');
  const kind = kindOf(new Uint8Array(await f.slice(0, 16).arrayBuffer()));
  if (kind && $('#strip').checked) msg(note, '会清除这张图片的位置、拍摄设备和时间信息。', 'ok');
  else if (kind) msg(note, '不会清除图片里的隐藏信息，照片可能带有拍摄位置。', 'warn');
  else if (/^image\//.test(f.type) || /\.(heic|heif|tiff?|dng|raw)$/i.test(f.name))
    msg(note, '这种图片格式无法自动清除位置等信息。建议先截图或转成 JPG 再分享。', 'warn');
  else msg(note, '这种文件无法自动清除隐藏信息（例如 PDF、Word 的作者名，视频的拍摄位置）。请自己先检查。', 'warn');
}

$('#file').addEventListener('change', () => {
  const f = $('#file').files[0];
  $('#file-info').textContent = f ? `${f.name} · ${fmtBytes(f.size)}${f.size > MAX_FILE ? '（超过 50 MB，无法上传）' : ''}` : '';
  metaNote();
});
$('#strip').addEventListener('change', metaNote);

$('#up-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#up-msg');
  let file = $('#file').files[0];
  const password = $('#password').value;
  if (!file) return msg(out, '请先选择文件', 'warn');
  if (file.size > MAX_FILE) return msg(out, '文件太大，最大 50 MB', 'warn');
  if (!window.crypto?.subtle) return msg(out, '这个浏览器不支持加密，请换用最新版的 Chrome、Safari 或 Edge', 'error');

  $('#up-submit').disabled = true;
  try {
    if ($('#strip').checked) {
      try {
        file = (await stripMetadata(file)).file;
      } catch {
        throw new Error('这张图片无法处理，无法清除隐藏信息。可以取消勾选“清除隐藏信息”后再上传，或先截图再分享。');
      }
    }
    msg(out, password ? '正在加密（设置了密码，需要几秒钟）…' : '正在加密…');
    const { blob, linkKey, deleteToken } = await encryptFile(file, password);
    msg(out, '正在上传… 0%');
    const res = await post(
      blob,
      { 'Content-Type': 'application/octet-stream', 'X-Delete-Hash': await sha256hex(deleteToken), 'X-Share-Password': password ? '1' : '0' },
      (p) => msg(out, `正在上传… ${Math.floor(p * 100)}%`),
    );
    current = { id: res.id, deleteToken };
    const path = `/s/${res.id}#${b64url(linkKey)}`;
    const link = `${location.origin}${path}`;
    $('#link').textContent = link;
    $('#link-box').onclick = () => copyText(link);
    const backups = (await backupsReady).slice(0, 4).map((o) => `${o}${path}`);
    $('#backup').hidden = !backups.length;
    $('#backup-links').innerHTML = backups.map((l) => `<li><code>${esc(l)}</code></li>`).join('');
    $('#copy-all').onclick = () => copyText(['加密文件（打不开时换下一个链接）：', link, ...backups].join('\n'));
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
