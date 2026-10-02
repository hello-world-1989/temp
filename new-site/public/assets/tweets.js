import { $, api, esc, safeUrl, ymd, addDays, copyText } from './site.js';

const params = new URLSearchParams(location.search);
const today = ymd();
let date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : today;
let items = [];
// ?view=print: the preview page — the whole day in the print layout, no menus or ads
const previewMode = params.get('view') === 'print';
if (previewMode) document.body.classList.add('print-view');

const media = (list) =>
  String(list || '')
    .split(',')
    .map((s) => s.trim())
    .filter((p) => /^\/[\w/.-]+\.(jpe?g|png|webp|gif)$/i.test(p))
    .map((p) => `/news-resource${p}`);

// "[查看原文](https://…)" and "[查看引用原文](https://…)" in the text become links
function linkify(text) {
  return esc(text).replace(/\[([^\]\n]{1,40})\]\((https?:\/\/[^\s)]+)\)/g, (all, label, href) => {
    const safe = safeUrl(href.replace(/&amp;/g, '&'));
    return safe && safe !== '#' ? `<a href="${esc(safe)}" target="_blank" rel="noopener nofollow">${label}</a>` : all;
  });
}

// Like the old site: the day's tweets come in one request, but are shown 10 at a time;
// the next 10 appear when the reader nears the end (or presses the button)
const BATCH = 10;
let shown = previewMode ? Infinity : BATCH;
let observer = null;

const filtered = () => {
  const q = $('#q').value.trim();
  return q ? items.filter((t) => String(t.content || '').includes(q)) : items;
};

const xUrl = (t) => (t.link ? safeUrl(t.link) : `https://x.com/whyyoutouzhele/status/${encodeURIComponent(t.id)}`);
const X_ICON = '<svg class="x-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';

function card(t) {
  const pics = media(t.images);
  const hasVideo = !!String(t.videos || t.originVideos || '').trim();
  const id = String(t.id || '');
  return `<article class="card item${id && id === targetId ? ' item-target' : ''}"${id ? ` id="${esc(id)}"` : ''}>
    <div class="item-head">
      <div class="item-meta"><b>${esc(t.name || '')}</b><span>${esc(t.createdDate)}</span>${Number(t.views) ? `<span>${esc(t.views)} 次浏览</span>` : ''}</div>
      <div class="item-actions">
        ${id ? `<button class="btn btn-ghost btn-sm" type="button" data-share="${esc(id)}" title="复制分站链接，国内不翻墙也能打开">免墙分享</button>` : ''}
        ${id || t.link ? `<a class="btn btn-ghost btn-sm" href="${esc(xUrl(t))}" target="_blank" rel="noopener nofollow" title="在 X 上查看原推文">${X_ICON}查看X推文${hasVideo ? '（含视频）' : ''}</a>` : ''}
      </div>
    </div>
    <p>${linkify(t.content)}</p>
    ${pics.length ? `<div class="thumbs">${pics.map((src) => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="" loading="lazy"></a>`).join('')}</div>` : ''}
  </article>`;
}

// "免墙分享": like the old site, a link to this tweet on one of the mirrors (分站, https://<ip>/,
// opens in China without a VPN), with the tweet's id as the anchor
let mirrorsReq = null;
const mirrors = () => (mirrorsReq ||= api('/api/free').then((d) => (d.mirrors || []).filter((m) => /^https?:\/\/[^/]+\/$/.test(m))).catch(() => { mirrorsReq = null; return []; }));
async function shareTweet(id) {
  const list = await mirrors();
  const base = list.length ? list[Math.floor(Math.random() * list.length)] : `${location.origin}/`;
  await copyText(`${base}tweets?date=${date}#${encodeURIComponent(id)}`);
}
$('#feed').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-share]');
  if (btn) shareTweet(btn.getAttribute('data-share'));
});

// Opened from a shared link (#<tweet id>): show enough of the day to include it and scroll there
let anchorDone = false;
let targetId = '';
function showAnchor() {
  if (anchorDone) return;
  anchorDone = true;
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); } catch {}
  if (!id) return;
  const i = filtered().findIndex((t) => String(t.id) === id);
  if (i < 0) return;
  targetId = id;
  shown = Math.max(shown, Math.ceil((i + 1) / BATCH) * BATCH);
  render();
  document.getElementById(id)?.scrollIntoView({ block: 'start' });
}

function render() {
  const list = filtered();
  observer?.disconnect();
  if (!list.length) {
    $('#feed').innerHTML = `<p class="muted">${$('#q').value.trim() ? '没有找到相关推文。' : '这一天没有推文。'}</p>`;
    return;
  }
  const count = Math.min(shown, list.length);
  const more = count < list.length;
  $('#feed').innerHTML =
    list.slice(0, count).map(card).join('') +
    `<div class="card item feed-more" id="feed-more">
      <p class="muted">${more ? `已显示 ${count} / ${list.length} 条` : `已加载全部 ${list.length} 条`}</p>
      ${more ? '<button class="btn btn-primary btn-sm" type="button" id="more">加载更多</button>' : '<button class="btn btn-ghost btn-sm" type="button" id="top">返回顶部</button>'}
    </div>`;
  $('#more')?.addEventListener('click', loadMore);
  $('#top')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  if (more && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadMore(), { rootMargin: '300px 0px' });
    observer.observe($('#feed-more'));
  }
}

function loadMore() {
  shown += BATCH;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

function setPreviewLink() {
  const a = $('#preview');
  if (a) a.href = `/tweets?date=${date}&view=print`;
}

async function load() {
  $('#date').value = date;
  $('#date').max = today;
  $('#next').disabled = date >= today;
  $('#feed').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    items = await api(`/api/tweets?date=${date}`);
  } catch {
    items = [];
  }
  if (!items.length && date === today && !params.get('date')) {
    date = addDays(date, -1);
    return load();
  }
  items.sort((a, b) => String(b.createdDate).localeCompare(String(a.createdDate)));
  shown = previewMode ? Infinity : BATCH;
  setPreviewLink();
  render();
  showAnchor();
}

function go(d) {
  date = d;
  history.replaceState(null, '', `?date=${date}${previewMode ? '&view=print' : ''}`);
  load();
}

$('#prev').addEventListener('click', () => go(addDays(date, -1)));
$('#next').addEventListener('click', () => date < today && go(addDays(date, 1)));
$('#date').addEventListener('change', (e) => e.target.value && go(e.target.value > today ? today : e.target.value));
$('#q').addEventListener('input', () => { shown = previewMode ? Infinity : BATCH; render(); });

load();

// "保存为 PDF": opens the browser's print window (print styles in site.css hide the menus,
// ads and controls; choose "Save as PDF" there); lazy images are loaded first
async function printDay() {
  // The PDF holds the whole day, not just the tweets shown so far
  shown = Infinity;
  render();
  const imgs = [...document.querySelectorAll('#feed img')];
  imgs.forEach((img) => { img.loading = 'eager'; });
  await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 10000); }))));
  const title = document.title;
  document.title = `tweets-${date}`; // default PDF file name
  window.print();
  document.title = title;
}
$('#pdf')?.addEventListener('click', printDay);
