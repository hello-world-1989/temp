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
            <p>${esc(t.content)}</p>
            ${pics.length ? `<div class="thumbs">${pics.map((src) => `<img src="${esc(src)}" alt="" loading="lazy">`).join('')}</div>` : ''}
            <div class="row">
              ${t.link ? `<a class="btn btn-ghost btn-sm" href="${esc(safeUrl(t.link))}" rel="noopener nofollow">在 X 查看${hasVideo ? '（含视频）' : ''}</a>` : ''}
              ${t.telegramLink ? `<a class="btn btn-ghost btn-sm" href="${esc(safeUrl(t.telegramLink))}" rel="noopener nofollow">Telegram</a>` : ''}
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
