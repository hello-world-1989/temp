// 和谐词典: shared by the dictionary pages — light / dark switch, words people added
// (published through the 事件墙 service), and the 3:4 share image.
import { $, toast } from './site.js';
import { shareCardHtml } from './dict-render.js';
import PRESET from './dict-data.js';

export { PRESET };

// ---------- light / dark ----------
const THEME_KEY = 'dict-theme';
const getTheme = () => {
  try {
    return localStorage.getItem(THEME_KEY) || '';
  } catch {
    return '';
  }
};
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const btn = $('[data-dict-theme]');
  if (btn) btn.textContent = { light: '☀️ 浅色', dark: '🌙 深色' }[t] || '🌓 跟随系统';
}
applyTheme(getTheme());
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-dict-theme]')) return;
  // 跟随系统 -> 浅色 -> 深色 -> 跟随系统
  const next = { '': 'light', light: 'dark', dark: '' }[getTheme()] ?? '';
  try {
    next ? localStorage.setItem(THEME_KEY, next) : localStorage.removeItem(THEME_KEY);
  } catch {}
  applyTheme(next);
});

// ---------- words added by visitors ----------
// -> [] when the 事件墙 service is not reachable (the built-in words still work)
let userWords;
export function loadUserWords() {
  userWords ||= fetch('/api/board/dict', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : { items: [] }))
    .then((d) => (Array.isArray(d.items) ? d.items.map((w) => ({ ...w, source: 'user' })) : []))
    .catch(() => []);
  return userWords;
}

export async function findWord(id) {
  const preset = PRESET.find((e) => e.id === id);
  if (preset) return preset;
  if (!/^[A-Za-z0-9]{8,32}$/.test(id)) return null;
  const res = await fetch(`/api/board/dict/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } }).catch(() => null);
  return res?.ok ? { ...(await res.json()), source: 'user' } : null;
}

// ---------- share image ----------
let libPromise;
function loadLib() {
  libPromise ||= new Promise((resolve, reject) => {
    if (window.htmlToImage) return resolve(window.htmlToImage);
    const s = document.createElement('script');
    s.src = '/assets/vendor/html-to-image.js';
    s.onload = () => resolve(window.htmlToImage);
    s.onerror = () => {
      libPromise = null;
      reject(new Error('图片工具加载失败'));
    };
    document.head.append(s);
  });
  return libPromise;
}

export async function shareImage(entry, button) {
  if (button) button.disabled = true;
  const stage = document.createElement('div');
  stage.className = 'dict-share-stage';
  stage.setAttribute('aria-hidden', 'true');
  stage.innerHTML = shareCardHtml(entry, location.host);
  document.body.append(stage);
  try {
    const lib = await loadLib();
    const blob = await lib.toBlob(stage.firstElementChild, { pixelRatio: 2, width: 600, height: 800, cacheBust: false });
    const name = `和谐词典-${entry.word}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    // Phones: the system share sheet (save to photos, send to an app); else a download
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `和谐词典：${entry.word}` });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast('图片已生成');
  } catch (err) {
    toast(err.message || '生成失败，请重试');
  } finally {
    stage.remove();
    if (button) button.disabled = false;
  }
}

// Any [data-dict-card="<id>"] button; pages register the entries they show
const shown = new Map();
export const registerEntries = (list) => list.forEach((e) => shown.set(e.id, e));
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dict-card]');
  if (!btn) return;
  const entry = shown.get(btn.dataset.dictCard);
  if (entry) shareImage(entry, btn);
});
