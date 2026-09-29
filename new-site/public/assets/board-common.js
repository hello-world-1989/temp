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
