import { $, api, esc, safeUrl, ymd, addDays } from './site.js';

const params = new URLSearchParams(location.search);
const today = ymd();
let date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date') : today;
let items = [];
let source = 'all';

const img = (p) => (p && /^[\w/.-]+$/.test(p) ? `/news-resource/${p.replace(/^\//, '')}` : '');

function renderSources() {
  const names = new Map(items.map((n) => [n.sourceId, n.name || n.sourceId]));
  $('#sources').innerHTML = [['all', '全部'], ...names]
    .map(([id, name]) => `<button class="tab" role="tab" data-source="${esc(id)}" aria-selected="${id === source}">${esc(name)}</button>`)
    .join('');
}

function renderFeed() {
  const list = source === 'all' ? items : items.filter((n) => n.sourceId === source);
  $('#feed').innerHTML = list.length
    ? list
        .map((n) => {
          const pic = img(n.detailImage || n.thumbnail);
          return `<article class="card item" id="n${esc(n.id)}">
            <div class="item-meta"><span class="badge soft">${esc(n.name || n.sourceId)}</span><span>${esc(n.createdDate)}</span></div>
            <h3>${esc(n.title)}</h3>
            ${pic ? `<div class="thumbs"><img src="${esc(pic)}" alt="" loading="lazy"></div>` : ''}
            <p>${esc(n.content)}</p>
            ${n.newsLink ? `<a href="${esc(safeUrl(n.newsLink))}" rel="noopener nofollow">阅读原文（需翻墙）</a>` : ''}
          </article>`;
        })
        .join('')
    : '<p class="muted">这一天没有新闻。</p>';
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

async function load() {
  $('#date').value = date;
  $('#date').max = today;
  $('#next').disabled = date >= today;
  $('#feed').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  try {
    items = await api(`/api/news?date=${date}`);
  } catch {
    items = [];
  }
  // Early in the day today's file may be missing: show yesterday instead
  if (!items.length && date === today && !params.get('date')) {
    date = addDays(date, -1);
    return load();
  }
  source = 'all';
  renderSources();
  renderFeed();
}

function go(d) {
  date = d;
  history.replaceState(null, '', `?date=${date}`);
  load();
}

$('#prev').addEventListener('click', () => go(addDays(date, -1)));
$('#next').addEventListener('click', () => date < today && go(addDays(date, 1)));
$('#date').addEventListener('change', (e) => e.target.value && go(e.target.value > today ? today : e.target.value));
$('#sources').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  source = t.dataset.source;
  renderSources();
  renderFeed();
});

load();
