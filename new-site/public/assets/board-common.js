// 事件墙: helpers shared by the board pages
import { $, esc } from './site.js';

export { $, esc };

export async function call(method, path, { body, raw, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let metaPromise;
export const boardMeta = () => (metaPromise ||= call('GET', '/api/board/meta'));

// Proof of work: find a nonce so SHA-256(challenge + nonce) starts with `bits` zero bits.
// Takes a few seconds; nothing about the visitor is sent anywhere.
function zeroBits(buf) {
  const b = new Uint8Array(buf);
  let n = 0;
  for (const byte of b) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

export async function proofOfWork(purpose, onProgress) {
  const { challenge, bits } = await call('GET', `/api/board/pow?for=${purpose}`);
  const enc = new TextEncoder();
  const expected = 2 ** bits;
  const batch = 256;
  for (let start = 0; ; start += batch) {
    const nonces = Array.from({ length: batch }, (_, k) => (start + k).toString(36));
    const hashes = await Promise.all(nonces.map((n) => crypto.subtle.digest('SHA-256', enc.encode(challenge + n))));
    const hit = hashes.findIndex((h) => zeroBits(h) >= bits);
    if (hit >= 0) return { challenge, nonce: nonces[hit] };
    if (onProgress && start % (batch * 16) === 0) onProgress(Math.min(0.95, start / (expected * 1.5)));
  }
}

export function fmtDay(iso) {
  if (!iso) return '';
  return iso.length === 10 ? iso : new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Plain text -> paragraphs (never HTML)
export function paragraphs(el, text) {
  el.replaceChildren();
  for (const block of String(text || '').split(/\n{2,}/)) {
    const p = document.createElement('p');
    p.textContent = block;
    el.append(p);
  }
}

export function setMsg(el, text, kind = '') {
  el.className = `notice mt ${kind}`.trim();
  el.textContent = text;
}

export const STATUS = { pending: '待审核', published: '已发布', rejected: '未通过', removed: '已下架', withdrawn: '已撤回' };

// Saves a receipt into the 加密聊天 identity (保险箱) on this device, so it does not have to be
// copied by hand; shows the outcome in `el`. Posts stay anonymous. Without the chat service
// (or on a site without it) nothing happens.
export async function rememberReceipt(el, entry) {
  let idm;
  try {
    idm = await import('/chat/assets/chat-identity.js');
  } catch {
    return;
  }
  const say = (text, kind = '') => {
    el.className = `notice mt ${kind}`.trim();
    el.replaceChildren(text);
    el.classList.remove('hidden');
    el.hidden = false;
  };
  const r = await idm.saveReceipt(entry).catch(() => 'error');
  if (r === 'saved') return say('回执码已自动保存到你的身份（加密聊天 → 我的），换设备用恢复口令也能找回。', 'ok');
  if (r === 'none') {
    const a = document.createElement('a');
    a.href = '/chat';
    a.textContent = '加密聊天 → 我的';
    say('想让回执码自动保存、丢了也能找回？在 ');
    el.append(a, ' 里设置身份口令。');
    return;
  }
  if (r !== 'locked') return;
  // Locked in this tab: unlock right here
  const form = document.createElement('form');
  form.className = 'receipt-unlock';
  const input = Object.assign(document.createElement('input'), { type: 'password', className: 'input', placeholder: '身份口令', autocomplete: 'current-password' });
  const btn = Object.assign(document.createElement('button'), { type: 'submit', className: 'btn btn-sm', textContent: '解锁并保存' });
  form.append(input, btn);
  say('输入加密聊天的身份口令，把这个回执码保存到你的身份：');
  el.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      await idm.unlockAndSave(input.value, entry);
      say('回执码已保存到你的身份（加密聊天 → 我的）。', 'ok');
    } catch (err) {
      btn.disabled = false;
      input.value = '';
      input.placeholder = err.message === 'password' ? '口令不对，再试一次' : '保存失败，请手动抄下回执码';
    }
  });
}

// The nickname from the 加密聊天 identity, if this tab has it unlocked ('' otherwise)
export async function identityNick() {
  try {
    return await (await import('/chat/assets/chat-identity.js')).currentNick();
  } catch {
    return '';
  }
}
