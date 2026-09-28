import { $, esc, fmtBytes, fmtDate } from './site.js';
import { decryptFile, fromB64url } from './share-crypto.js';

function msg(text, kind = '') {
  const el = $('#get-msg');
  el.className = `notice mt ${kind}`;
  el.textContent = text;
}

function meta(rows) {
  $('#meta').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

// WeChat / QQ in-app browsers cannot save downloaded files. The file is deleted from the server
// once decrypted, so do not let it be decrypted where it cannot be saved.
const inApp = /MicroMessenger|QQ\/|MQQBrowser.*QQ/i.test(navigator.userAgent);
if (inApp) $('#inapp').hidden = false;

const id = location.pathname.split('/')[2] || '';
let linkKey = null;
try {
  const k = fromB64url(location.hash.slice(1));
  if (k.length === 32) linkKey = k;
} catch {}

let bytes = null; // ciphertext, kept so a wrong password can be retried without downloading again

async function download(size) {
  const res = await fetch(`/api/share/${id}/file`, { cache: 'no-store' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `下载失败（${res.status}）`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length <= buf.length) buf.set(value, got);
    else chunks.push(value);
    got += value.length;
    if (total) msg(`正在下载… ${Math.floor((got / total) * 100)}%`);
  }
  if (!chunks.length && got === buf.length) return buf;
  // Length header missing or wrong: join what arrived
  const all = new Uint8Array(got);
  all.set(buf.subarray(0, Math.min(got, buf.length)));
  let off = Math.min(got, buf.length);
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return all;
}

async function init() {
  if (!linkKey) {
    meta([['状态', '链接不完整']]);
    return msg('链接缺少 # 后面的密钥。请让对方重新发送完整的链接（复制时不要截断）。', 'error');
  }
  let info;
  try {
    const res = await fetch(`/api/share/${id}`, { cache: 'no-store' });
    info = await res.json();
    if (!res.ok) throw new Error(info?.error || '文件不存在');
  } catch (err) {
    meta([['状态', '无法下载']]);
    return msg(err.message || '文件不存在：已被下载、已删除或已过期', 'error');
  }
  meta([
    ['大小', fmtBytes(info.size)],
    ['有效期至', fmtDate(info.expiresAt)],
    ['密码', info.password ? '需要' : '不需要'],
  ]);
  $('#pw-field').hidden = !info.password;
  if (inApp) return msg('请先在系统浏览器里打开这个链接，再下载。', 'warn');
  $('#get-submit').disabled = false;

  $('#get-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#password').value;
    if (info.password && !password) return msg('请输入密码', 'warn');
    $('#get-submit').disabled = true;
    try {
      if (!bytes) bytes = await download(info.size);
      msg(info.password ? '正在解密（需要几秒钟）…' : '正在解密…');
      let file;
      try {
        file = await decryptFile(bytes, linkKey, password);
      } catch (err) {
        if (err.message === 'password') throw new Error(info.password ? '密码不对，请重新输入' : '解密失败：链接不完整或文件已损坏');
        throw new Error('文件格式不正确');
      }
      const url = URL.createObjectURL(new Blob([file.data], { type: file.type }));
      const save = $('#save');
      save.href = url;
      save.download = file.name;
      save.textContent = `保存文件：${file.name}`;
      save.hidden = false;
      $('#get-submit').hidden = true;
      $('#pw-field').hidden = true;
      bytes = null;
      meta([
        ['文件', esc(file.name)],
        ['大小', fmtBytes(file.data.length)],
      ]);
      // Decrypted: delete from the server now (download once). The file stays in this page until it is closed.
      const del = await fetch(`/api/share/${id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: file.deleteToken }),
      }).catch(() => null);
      msg(
        del?.ok
          ? '解密成功，文件已从服务器删除。请点“保存文件”，关闭页面前一定要保存，之后无法再次下载。'
          : '解密成功。请点“保存文件”，关闭页面前一定要保存。',
        'ok',
      );
    } catch (err) {
      $('#get-submit').disabled = false;
      msg(err.message || '下载失败，请稍后再试', 'error');
    }
  });
}

init();
