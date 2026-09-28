import { $, api, esc, safeUrl, ymd, addDays } from './site.js';

const params = new URLSearchParams(location.search);
const today = ymd();
let date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : today;
let items = [];

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

function render() {
  const q = $('#q').value.trim();
  const list = q ? items.filter((t) => String(t.content || '').includes(q)) : items;
  $('#feed').innerHTML = list.length
    ? list
        .map((t) => {
          const pics = media(t.images);
          const hasVideo = !!String(t.videos || t.originVideos || '').trim();
          return `<article class="card item">
            <div class="item-meta"><b>${esc(t.name || '')}</b><span>${esc(t.createdDate)}</span>${Number(t.views) ? `<span>${esc(t.views)} 次浏览</span>` : ''}</div>
            <p>${linkify(t.content)}</p>
            ${pics.length ? `<div class="thumbs">${pics.map((src) => `<img src="${esc(src)}" alt="" loading="lazy">`).join('')}</div>` : ''}
            <div class="row">
              ${t.link ? `<a class="btn btn-ghost btn-sm" href="${esc(safeUrl(t.link))}" rel="noopener nofollow">在 X 查看${hasVideo ? '（含视频）' : ''}</a>` : ''}
            </div>
          </article>`;
        })
        .join('')
    : `<p class="muted">${q ? '没有找到相关推文。' : '这一天没有推文。'}</p>`;
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
  render();
}

function go(d) {
  date = d;
  history.replaceState(null, '', `?date=${date}`);
  load();
}

$('#prev').addEventListener('click', () => go(addDays(date, -1)));
$('#next').addEventListener('click', () => date < today && go(addDays(date, 1)));
$('#date').addEventListener('change', (e) => e.target.value && go(e.target.value > today ? today : e.target.value));
$('#q').addEventListener('input', render);

load();

// "Save as PDF": the browser's own print preview renders the day's tweets (print styles
// in site.css hide the menus, ads and controls); lazy images are loaded first
async function printDay() {
  const imgs = [...document.querySelectorAll('#feed img')];
  imgs.forEach((img) => { img.loading = 'eager'; });
  await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 10000); }))));
  const title = document.title;
  document.title = `tweets-${date}`; // default PDF file name
  window.print();
  document.title = title;
}
$('#pdf')?.addEventListener('click', printDay);
