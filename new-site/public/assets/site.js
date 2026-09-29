// Shared helpers for every page (loaded as a module on each page)

export const $ = (sel, root = document) => root.querySelector(sel);

// Escape text for insertion into HTML; everything from the network goes through this
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Only http(s) and same-site links; anything else (javascript:, data:) becomes "#"
export function safeUrl(value) {
  try {
    const u = new URL(String(value), location.origin);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '#';
  } catch {
    return '#';
  }
}

export async function api(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const msg = data?.error || data?.message || `请求失败（${res.status}）`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
export function toast(text) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Older browsers / non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制');
}

// Any element with data-copy="..." copies that text when clicked
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (btn) {
    e.preventDefault();
    copyText(btn.getAttribute('data-copy'));
  }
});

// Close the mobile menu after choosing a link
document.addEventListener('click', (e) => {
  if (e.target.closest('.nav a')) document.querySelector('.menu')?.removeAttribute('open');
});

export function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtBytes(n) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtPrice(cents, currency = 'usd') {
  const v = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: currency.toUpperCase() }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

// YYYY-MM-DD in Beijing time (the news and tweet files are organised by that date)
export function ymd(date = new Date()) {
  const s = new Date(date.getTime() + 8 * 3600 * 1000).toISOString();
  return s.slice(0, 10);
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Remembered subscription token (this browser only)
export const tokenStore = {
  get() {
    try {
      return localStorage.getItem('xn_token') || '';
    } catch {
      return '';
    }
  },
  set(v) {
    try {
      v ? localStorage.setItem('xn_token', v) : localStorage.removeItem('xn_token');
    } catch {}
  },
};

// 加密分享 / 加密聊天 on a third-party mirror (anyone can run one with mirror.sh): they work, with a
// warning, because whoever runs the mirror could change the page's scripts and read the keys.
const OFFICIAL_HOSTS = ['end-gfw.com', 'www.end-gfw.com', 'v2.end-gfw.com', 'share-preview.end-gfw.com', 'board-preview.end-gfw.com', 'localhost', '127.0.0.1'];
export async function isOfficialHost() {
  if (OFFICIAL_HOSTS.includes(location.hostname)) return true;
  try {
    const res = await fetch('/api/official-hosts', { cache: 'no-store' });
    if (!res.ok) return false;
    return ((await res.json()).hosts || []).includes(location.hostname);
  } catch {
    return false;
  }
}

// -> true on an official address; elsewhere shows the warning at the top of the page
export async function guardOfficial(what) {
  if (await isOfficialHost()) return true;
  const main = document.getElementById('main');
  if (main) {
    const box = document.createElement('div');
    box.className = 'wrap';
    box.innerHTML = `<p class="notice warn mt"><strong>这是第三方镜像，不是官方地址。</strong>${esc(what)}可以正常使用，但镜像的运营者理论上能改动这个页面、看到链接里的密钥。敏感内容请用官方地址 <b>https://end-gfw.com</b>，打不开时官方入口见 <b>https://end-gfw.com/chat-mirrors</b>。</p>`;
    main.prepend(box);
  }
  return false;
}
